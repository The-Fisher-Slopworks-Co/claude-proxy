// POST /v1/chat/completions — translate OpenAI chat requests to SDK queries.
import {
  query,
  type Options,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { ALLOWED_TOOLS, childEnv } from "./config";
import { log } from "./log";
import {
  buildPrompt,
  finishReason,
  now,
  oaiError,
  resolveModel,
  usageOf,
  type ChatRequest,
  type PromptBlock,
} from "./openai";

// Streaming-input mode is the only way to pass image blocks to the SDK.
async function* userTurn(
  content: PromptBlock[],
): AsyncIterable<SDKUserMessage> {
  yield {
    type: "user",
    parent_tool_use_id: null,
    message: { role: "user", content },
  };
}

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

export async function chatCompletions(req: Request): Promise<Response> {
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
  const { systemPrompt, content } = buildPrompt(body.messages);
  const images = content.filter((b) => b.type === "image").length;
  // text-only rendering, used for logs and for the plain string prompt path
  const prompt = content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  if (content.length === 0) {
    log("warn", "request.reject", { reqId, reason: "no content" });
    return oaiError(
      400,
      "No text or image content found in 'messages'",
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
    images,
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
    prompt: images ? userTurn(content) : prompt,
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
