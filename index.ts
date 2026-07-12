import {
  query,
  type Options,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";

// ---- config ----
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 8787);
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "sonnet";
// ponytail: comma-separated tool names, empty = all built-in tools off (safe default)
const ALLOWED_TOOLS = (process.env.ALLOWED_TOOLS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const LOG_LEVEL = process.env.LOG_LEVEL === "debug" ? "debug" : "info";
// pretty (key=value text) on a terminal, JSON lines when piped/collected
const LOG_FORMAT =
  process.env.LOG_FORMAT === "json" || process.env.LOG_FORMAT === "pretty"
    ? process.env.LOG_FORMAT
    : process.stdout.isTTY
      ? "pretty"
      : "json";

// ---- logging ----
type LogLevel = "debug" | "info" | "warn" | "error";
function log(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> = {},
) {
  if (level === "debug" && LOG_LEVEL !== "debug") return;
  let line: string;
  if (LOG_FORMAT === "json") {
    line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      event,
      ...fields,
    });
  } else {
    const kv = Object.entries(fields)
      .map(([k, v]) =>
        typeof v === "string" && !/\s/.test(v)
          ? `${k}=${v}`
          : `${k}=${JSON.stringify(v)}`,
      )
      .join(" ");
    line = `${new Date().toISOString().slice(11, 23)} ${level.toUpperCase().padEnd(5)} ${event}${kv ? "  " + kv : ""}`;
  }
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

// Never let the subprocess see ANTHROPIC_API_KEY — it would silently win over
// subscription OAuth and bill the API key instead.
const childEnv: Record<string, string | undefined> = {
  ...process.env,
  ANTHROPIC_API_KEY: undefined,
};

const MODELS = [
  "sonnet",
  "opus",
  "haiku",
  "claude-sonnet-5",
  "claude-opus-4-8",
  "claude-haiku-4-5-20251001",
];

// ---- OpenAI request shapes ----
type ContentPart = { type?: string; text?: string };
type ChatMessage = { role: string; content: string | ContentPart[] | null };
type ChatRequest = {
  model?: string;
  messages?: ChatMessage[];
  stream?: boolean;
};

export function textOf(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((p) => (typeof p.text === "string" ? p.text : ""))
      .filter(Boolean)
      .join("\n");
  return "";
}

export function buildPrompt(messages: ChatMessage[]): {
  systemPrompt: string | undefined;
  prompt: string;
} {
  const systemPrompt =
    messages
      .filter((m) => m.role === "system" || m.role === "developer")
      .map((m) => textOf(m.content))
      .filter(Boolean)
      .join("\n\n") || undefined;

  const turns = messages.filter(
    (m) => m.role === "user" || m.role === "assistant",
  );
  // ponytail: stateless — history is rendered into one prompt; switch to SDK
  // resume/sessions if turn fidelity ever matters
  const prompt =
    turns.length === 1 && turns[0]!.role === "user"
      ? textOf(turns[0]!.content)
      : turns
          .map(
            (m) =>
              `${m.role === "user" ? "Human" : "Assistant"}: ${textOf(m.content)}`,
          )
          .join("\n\n") + "\n\nAssistant:";
  return { systemPrompt, prompt };
}

// ---- OpenAI response helpers ----
const now = () => Math.floor(Date.now() / 1000);
const STARTED = now();

const oaiError = (
  status: number,
  message: string,
  type = "api_error",
  reqId?: string,
) =>
  Response.json(
    { error: { message, type } },
    { status, headers: reqId ? { "x-request-id": reqId } : undefined },
  );

const finishReason = (stop: string | null) =>
  stop === "max_tokens" ? "length" : "stop";

function usageOf(u: {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}) {
  const prompt_tokens =
    (u.input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0);
  const completion_tokens = u.output_tokens ?? 0;
  return {
    prompt_tokens,
    completion_tokens,
    total_tokens: prompt_tokens + completion_tokens,
  };
}

const resolveModel = (m: string | undefined) =>
  // ponytail: some OpenAI clients hardcode gpt-* — route them to the default
  !m || m.startsWith("gpt-") ? DEFAULT_MODEL : m;

function queryOptions(
  reqId: string,
  model: string,
  systemPrompt: string | undefined,
  stream: boolean,
  abortController: AbortController,
): Options {
  return {
    model,
    systemPrompt: systemPrompt ?? "You are a helpful assistant.",
    tools: ALLOWED_TOOLS, // [] disables every built-in tool
    allowedTools: ALLOWED_TOOLS.length ? ALLOWED_TOOLS : undefined,
    permissionMode: "dontAsk", // never hang on a permission prompt
    persistSession: false,
    settingSources: [], // don't leak local CLAUDE.md/settings into responses
    env: childEnv,
    includePartialMessages: stream,
    abortController,
    stderr: (data) => log("debug", "claude.stderr", { reqId, data }),
  };
}

// SDK-reported metrics shared by success and error results.
const resultFields = (msg: SDKResultMessage) => ({
  sdk_ms: msg.duration_ms,
  api_ms: msg.duration_api_ms,
  turns: msg.num_turns,
  cost_usd: Number(msg.total_cost_usd.toFixed(6)),
  session_id: msg.session_id,
  usage: usageOf(msg.usage),
});

// ---- handlers ----
async function chatCompletions(req: Request): Promise<Response> {
  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  const reqId = crypto.randomUUID();
  const id = `chatcmpl-${reqId}`;

  let body: ChatRequest;
  try {
    body = (await req.json()) as ChatRequest;
  } catch {
    log("warn", "request.reject", { reqId, reason: "invalid JSON" });
    return oaiError(400, "Invalid JSON body", "invalid_request_error", reqId);
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    log("warn", "request.reject", { reqId, reason: "empty messages" });
    return oaiError(
      400,
      "'messages' must be a non-empty array",
      "invalid_request_error",
      reqId,
    );
  }

  const model = resolveModel(
    typeof body.model === "string" ? body.model : undefined,
  );
  const { systemPrompt, prompt } = buildPrompt(body.messages);
  if (!prompt) {
    log("warn", "request.reject", { reqId, reason: "no text content" });
    return oaiError(
      400,
      "No text content found in 'messages'",
      "invalid_request_error",
      reqId,
    );
  }

  log("info", "request.start", {
    reqId,
    model,
    requested_model: body.model ?? null,
    stream: !!body.stream,
    messages: body.messages.length,
    prompt_chars: prompt.length,
    system_chars: systemPrompt?.length ?? 0,
  });
  log("debug", "request.prompt", { reqId, systemPrompt, prompt });

  const ac = new AbortController();
  req.signal.addEventListener("abort", () => {
    ac.abort();
    log("warn", "client.abort", { reqId, elapsed_ms: ms() });
  });

  const created = now();
  const q = query({
    prompt,
    options: queryOptions(reqId, model, systemPrompt, !!body.stream, ac),
  });

  if (!body.stream) {
    try {
      for await (const msg of q) {
        log("debug", "sdk.message", {
          reqId,
          type: msg.type,
          subtype: "subtype" in msg ? msg.subtype : undefined,
        });
        if (msg.type !== "result") continue;
        if (msg.subtype === "success" && !msg.is_error) {
          log("info", "request.done", {
            reqId,
            status: 200,
            duration_ms: ms(),
            finish: finishReason(msg.stop_reason),
            ...resultFields(msg),
          });
          log("debug", "request.response", { reqId, text: msg.result });
          return Response.json(
            {
              id,
              object: "chat.completion",
              created,
              model,
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: msg.result },
                  finish_reason: finishReason(msg.stop_reason),
                },
              ],
              usage: usageOf(msg.usage),
            },
            { headers: { "x-request-id": reqId } },
          );
        }
        const detail =
          msg.subtype === "success" ? msg.result : msg.errors.join("; ");
        log("error", "request.error", {
          reqId,
          duration_ms: ms(),
          subtype: msg.subtype,
          detail,
          ...resultFields(msg),
        });
        return oaiError(
          502,
          `Claude Code error (${msg.subtype}): ${detail}`,
          "api_error",
          reqId,
        );
      }
      log("error", "request.error", {
        reqId,
        duration_ms: ms(),
        detail: "no result message",
      });
      return oaiError(502, "Claude Code produced no result", "api_error", reqId);
    } catch (e) {
      if (ac.signal.aborted) return new Response(null, { status: 499 });
      const detail = e instanceof Error ? e.message : String(e);
      log("error", "request.error", { reqId, duration_ms: ms(), detail });
      return oaiError(500, detail, "api_error", reqId);
    }
  }

  // streaming (SSE)
  const enc = new TextEncoder();
  const chunk = (
    delta: object,
    finish: string | null = null,
    usage?: object,
  ) =>
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(usage ? { usage } : {}),
    })}\n\n`;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (s: string) => controller.enqueue(enc.encode(s));
      let ttftMs: number | undefined;
      let chunks = 0;
      let text = "";
      try {
        send(chunk({ role: "assistant", content: "" }));
        for await (const msg of q) {
          if (msg.type === "stream_event" && msg.parent_tool_use_id === null) {
            const ev = msg.event;
            if (
              ev.type === "content_block_delta" &&
              ev.delta.type === "text_delta" &&
              ev.delta.text
            ) {
              ttftMs ??= ms();
              chunks++;
              text += ev.delta.text;
              send(chunk({ content: ev.delta.text }));
            }
          } else if (msg.type === "result") {
            if (msg.subtype === "success" && !msg.is_error) {
              send(chunk({}, finishReason(msg.stop_reason), usageOf(msg.usage)));
              log("info", "request.done", {
                reqId,
                status: 200,
                stream: true,
                duration_ms: ms(),
                ttft_ms: ttftMs,
                chunks,
                completion_chars: text.length,
                finish: finishReason(msg.stop_reason),
                ...resultFields(msg),
              });
              log("debug", "request.response", { reqId, text });
            } else {
              const detail =
                msg.subtype === "success" ? msg.result : msg.errors.join("; ");
              log("error", "request.error", {
                reqId,
                duration_ms: ms(),
                subtype: msg.subtype,
                detail,
                ...resultFields(msg),
              });
              send(
                `data: ${JSON.stringify({
                  error: {
                    message: `Claude Code error (${msg.subtype}): ${detail}`,
                    type: "api_error",
                  },
                })}\n\n`,
              );
            }
            break;
          } else {
            log("debug", "sdk.message", {
              reqId,
              type: msg.type,
              subtype: "subtype" in msg ? msg.subtype : undefined,
            });
          }
        }
        send("data: [DONE]\n\n");
      } catch (e) {
        if (!ac.signal.aborted) {
          const detail = e instanceof Error ? e.message : String(e);
          log("error", "request.error", { reqId, duration_ms: ms(), detail });
          try {
            send(
              `data: ${JSON.stringify({
                error: { message: detail, type: "api_error" },
              })}\n\ndata: [DONE]\n\n`,
            );
          } catch {}
        }
      } finally {
        ac.abort(); // query is done or client is gone — stop the subprocess
        try {
          controller.close();
        } catch {}
      }
    },
    cancel() {
      ac.abort();
      log("warn", "stream.cancel", { reqId, elapsed_ms: ms() });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "x-request-id": reqId,
    },
  });
}

// ---- startup ----
if (import.meta.main) {
  if (!Bun.which("claude")) {
    log("error", "startup.failed", {
      reason:
        "Claude Code CLI not found on PATH. Install: bun add -g @anthropic-ai/claude-code (then: claude setup-token)",
    });
    process.exit(1);
  }
  if (process.env.ANTHROPIC_API_KEY)
    log("warn", "startup.api_key_ignored", {
      detail:
        "ANTHROPIC_API_KEY is set but will NOT be passed to Claude Code — subscription OAuth only",
    });

  Bun.serve({
    hostname: HOST,
    port: PORT,
    idleTimeout: 255, // ponytail: Bun max; non-stream completions can be slow
    routes: {
      "/health": () => {
        log("debug", "request.access", { route: "/health" });
        return Response.json({ status: "ok" });
      },
      "/v1/models": () => {
        log("debug", "request.access", { route: "/v1/models" });
        return Response.json({
          object: "list",
          data: MODELS.map((id) => ({
            id,
            object: "model",
            created: STARTED,
            owned_by: "anthropic",
          })),
        });
      },
      "/v1/chat/completions": { POST: chatCompletions },
    },
    fetch: (req) => {
      log("info", "request.reject", {
        reason: "unknown route",
        method: req.method,
        path: new URL(req.url).pathname,
      });
      return oaiError(404, "Not found", "invalid_request_error");
    },
  });

  log("info", "startup", {
    url: `http://${HOST}:${PORT}/v1`,
    default_model: DEFAULT_MODEL,
    tools: ALLOWED_TOOLS.length ? ALLOWED_TOOLS : "disabled",
    auth: process.env.CLAUDE_CODE_OAUTH_TOKEN
      ? "CLAUDE_CODE_OAUTH_TOKEN (subscription)"
      : "CLI stored login (no CLAUDE_CODE_OAUTH_TOKEN set)",
    log_level: LOG_LEVEL,
  });
}
