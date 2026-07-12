// OpenAI wire format: request shapes, prompt building, response helpers.
import { DEFAULT_MODEL } from "./config";

export type ContentPart = { type?: string; text?: string };
export type ChatMessage = {
  role: string;
  content: string | ContentPart[] | null;
};
export type ChatRequest = {
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

export const now = () => Math.floor(Date.now() / 1000);

export const oaiError = (
  status: number,
  message: string,
  type = "api_error",
  reqId?: string,
) =>
  Response.json(
    { error: { message, type } },
    { status, headers: reqId ? { "x-request-id": reqId } : undefined },
  );

export const finishReason = (stop: string | null) =>
  stop === "max_tokens" ? "length" : "stop";

export function usageOf(u: {
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

export const resolveModel = (m: string | undefined) =>
  // ponytail: some OpenAI clients hardcode gpt-* — route them to the default
  !m || m.startsWith("gpt-") ? DEFAULT_MODEL : m;
