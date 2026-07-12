import { query, type Options } from "@anthropic-ai/claude-agent-sdk";

// ---- config ----
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 8787);
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "sonnet";
// ponytail: comma-separated tool names, empty = all built-in tools off (safe default)
const ALLOWED_TOOLS = (process.env.ALLOWED_TOOLS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

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

const oaiError = (status: number, message: string, type = "api_error") =>
  Response.json({ error: { message, type } }, { status });

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
  };
}

// ---- handlers ----
async function chatCompletions(req: Request): Promise<Response> {
  let body: ChatRequest;
  try {
    body = (await req.json()) as ChatRequest;
  } catch {
    return oaiError(400, "Invalid JSON body", "invalid_request_error");
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0)
    return oaiError(
      400,
      "'messages' must be a non-empty array",
      "invalid_request_error",
    );

  const model = resolveModel(
    typeof body.model === "string" ? body.model : undefined,
  );
  const { systemPrompt, prompt } = buildPrompt(body.messages);
  if (!prompt)
    return oaiError(
      400,
      "No text content found in 'messages'",
      "invalid_request_error",
    );

  const ac = new AbortController();
  req.signal.addEventListener("abort", () => ac.abort());

  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = now();
  const q = query({
    prompt,
    options: queryOptions(model, systemPrompt, !!body.stream, ac),
  });

  if (!body.stream) {
    try {
      for await (const msg of q) {
        if (msg.type !== "result") continue;
        if (msg.subtype === "success" && !msg.is_error)
          return Response.json({
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
          });
        const detail =
          msg.subtype === "success" ? msg.result : msg.errors.join("; ");
        return oaiError(502, `Claude Code error (${msg.subtype}): ${detail}`);
      }
      return oaiError(502, "Claude Code produced no result");
    } catch (e) {
      if (ac.signal.aborted) return new Response(null, { status: 499 });
      return oaiError(500, e instanceof Error ? e.message : String(e));
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
      try {
        send(chunk({ role: "assistant", content: "" }));
        for await (const msg of q) {
          if (msg.type === "stream_event" && msg.parent_tool_use_id === null) {
            const ev = msg.event;
            if (
              ev.type === "content_block_delta" &&
              ev.delta.type === "text_delta" &&
              ev.delta.text
            )
              send(chunk({ content: ev.delta.text }));
          } else if (msg.type === "result") {
            if (msg.subtype === "success" && !msg.is_error) {
              send(chunk({}, finishReason(msg.stop_reason), usageOf(msg.usage)));
            } else {
              const detail =
                msg.subtype === "success" ? msg.result : msg.errors.join("; ");
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
          }
        }
        send("data: [DONE]\n\n");
      } catch (e) {
        if (!ac.signal.aborted)
          try {
            send(
              `data: ${JSON.stringify({
                error: {
                  message: e instanceof Error ? e.message : String(e),
                  type: "api_error",
                },
              })}\n\ndata: [DONE]\n\n`,
            );
          } catch {}
      } finally {
        ac.abort(); // query is done or client is gone — stop the subprocess
        try {
          controller.close();
        } catch {}
      }
    },
    cancel() {
      ac.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

// ---- startup ----
if (import.meta.main) {
  if (!Bun.which("claude")) {
    console.error(
      "Claude Code CLI not found on PATH. The Agent SDK needs it.\n" +
        "Install: bun add -g @anthropic-ai/claude-code  (then: claude setup-token)",
    );
    process.exit(1);
  }
  if (process.env.ANTHROPIC_API_KEY)
    console.warn(
      "WARNING: ANTHROPIC_API_KEY is set in this environment. It will NOT be " +
        "passed to Claude Code — this proxy uses subscription OAuth only.",
    );
  console.log(
    process.env.CLAUDE_CODE_OAUTH_TOKEN
      ? "auth: CLAUDE_CODE_OAUTH_TOKEN (subscription)"
      : "auth: no CLAUDE_CODE_OAUTH_TOKEN — falling back to Claude Code CLI stored login (`claude setup-token` to create one)",
  );

  Bun.serve({
    hostname: HOST,
    port: PORT,
    idleTimeout: 255, // ponytail: Bun max; non-stream completions can be slow
    routes: {
      "/health": () => Response.json({ status: "ok" }),
      "/v1/models": () =>
        Response.json({
          object: "list",
          data: MODELS.map((id) => ({
            id,
            object: "model",
            created: STARTED,
            owned_by: "anthropic",
          })),
        }),
      "/v1/chat/completions": { POST: chatCompletions },
    },
    fetch: () => oaiError(404, "Not found", "invalid_request_error"),
  });
  console.log(
    `claude-proxy: http://${HOST}:${PORT}/v1  (default model: ${DEFAULT_MODEL}, tools: ${ALLOWED_TOOLS.length ? ALLOWED_TOOLS.join(",") : "disabled"})`,
  );
}
