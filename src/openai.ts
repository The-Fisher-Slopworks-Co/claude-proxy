// OpenAI wire format: request shapes, prompt building, response helpers.
import type {
  Base64ImageSource,
  ImageBlockParam,
  TextBlockParam,
} from "@anthropic-ai/sdk/resources";
import { DEFAULT_MODEL } from "./config";

export type ContentPart = {
  type?: string;
  text?: string;
  image_url?: { url?: string } | string;
};
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

export type PromptBlock = TextBlockParam | ImageBlockParam;

// OpenAI image_url part (data: or http(s) URL) -> Anthropic image block.
function imageBlockOf(p: ContentPart): ImageBlockParam | undefined {
  const url = typeof p.image_url === "string" ? p.image_url : p.image_url?.url;
  if (p.type !== "image_url" || !url) return undefined;
  const data = url.match(/^data:(image\/[\w.+-]+);base64,(.+)$/s);
  return {
    type: "image",
    source: data
      ? {
          type: "base64",
          media_type: data[1] as Base64ImageSource["media_type"],
          data: data[2]!,
        }
      : { type: "url", url },
  };
}

export function buildPrompt(messages: ChatMessage[]): {
  systemPrompt: string | undefined;
  content: PromptBlock[];
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
  // NOTE: stateless — history is rendered into one interleaved block list
  // (text transcript with images kept in place); switch to SDK resume/sessions
  // if turn fidelity ever matters
  const single = turns.length === 1 && turns[0]!.role === "user";
  const content: PromptBlock[] = [];
  let buf = "";
  const flush = () => {
    if (buf) content.push({ type: "text", text: buf });
    buf = "";
  };
  turns.forEach((m, i) => {
    if (!single)
      buf += (i ? "\n\n" : "") + (m.role === "user" ? "Human: " : "Assistant: ");
    if (typeof m.content === "string") buf += m.content;
    else if (Array.isArray(m.content)) {
      let sep = "";
      for (const p of m.content) {
        const img = imageBlockOf(p);
        if (img) {
          flush();
          content.push(img);
        } else if (typeof p.text === "string" && p.text) {
          buf += sep + p.text;
          sep = "\n";
        }
      }
    }
  });
  if (!single) buf += "\n\nAssistant:";
  flush();
  return { systemPrompt, content };
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

// ---- response encoding: the exact bytes clients receive ----

export function completion(
  id: string,
  created: number,
  model: string,
  text: string,
  finish: string,
  usage: ReturnType<typeof usageOf>,
) {
  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: finish,
      },
    ],
    usage,
  };
}

export const chunk = (
  id: string,
  created: number,
  model: string,
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

export const sseError = (message: string, type = "api_error") =>
  `data: ${JSON.stringify({ error: { message, type } })}\n\n`;

export const SSE_DONE = "data: [DONE]\n\n";

// USD strings (OpenRouter format): prompt, completion, cache read, cache write
// (per token), image (per max-size image ≈ 1600 tokens × input price).
// NOTE: family heuristic off the current Anthropic price sheet; update on price changes
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
  // NOTE: some OpenAI clients hardcode gpt-* — route them to the default
  !m || m.startsWith("gpt-") ? DEFAULT_MODEL : m;
