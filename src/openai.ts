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

// USD strings (OpenRouter format): prompt, completion, cache read, cache write
// (per token), image (per max-size image ≈ 1600 tokens × input price).
// ponytail: family heuristic off the current Anthropic price sheet; update on price changes
const PRICING: Array<[RegExp, [string, string, string, string, string]]> = [
  [/opus/, ["0.000015", "0.000075", "0.0000015", "0.00001875", "0.024"]],
  [/haiku/, ["0.000001", "0.000005", "0.0000001", "0.00000125", "0.0016"]],
  [/./, ["0.000003", "0.000015", "0.0000003", "0.00000375", "0.0048"]], // sonnet & default
];

// OpenAI model object + OpenRouter extensions (pricing, architecture).
export function modelEntry(id: string, created: number, name = id) {
  const [prompt, completion, input_cache_read, input_cache_write, image] =
    PRICING.find(([re]) => re.test(id))![1];
  return {
    id,
    object: "model",
    created,
    owned_by: "anthropic",
    name,
    context_length: 200000,
    architecture: {
      // Real model modalities (all current Claude models take images);
      // the proxy itself still strips non-text parts before the SDK.
      modality: "text+image->text",
      input_modalities: ["text", "image"],
      output_modalities: ["text"],
      tokenizer: "Claude",
      instruct_type: null,
    },
    pricing: {
      prompt,
      completion,
      request: "0",
      image,
      input_cache_read,
      input_cache_write,
    },
    per_request_limits: null,
  };
}

export const resolveModel = (m: string | undefined) =>
  // ponytail: some OpenAI clients hardcode gpt-* — route them to the default
  !m || m.startsWith("gpt-") ? DEFAULT_MODEL : m;
