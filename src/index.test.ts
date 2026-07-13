import { test, expect } from "bun:test";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { interpretResult } from "./chat";
import {
  buildPrompt,
  chunk,
  completion,
  modelEntry,
  sseError,
  SSE_DONE,
  textOf,
} from "./openai";

test("textOf handles string and part-array content", () => {
  expect(textOf("hi")).toBe("hi");
  expect(
    textOf([
      { type: "text", text: "a" },
      { type: "image_url" },
      { type: "text", text: "b" },
    ]),
  ).toBe("a\nb");
  expect(textOf(null)).toBe("");
});

test("single user message passes through verbatim", () => {
  const { systemPrompt, content } = buildPrompt([
    { role: "system", content: "be terse" },
    { role: "user", content: "hello" },
  ]);
  expect(systemPrompt).toBe("be terse");
  expect(content).toEqual([{ type: "text", text: "hello" }]);
});

test("multi-turn history renders as a transcript", () => {
  const { content } = buildPrompt([
    { role: "user", content: "2+2?" },
    { role: "assistant", content: "4" },
    { role: "user", content: [{ type: "text", text: "and +1?" }] },
  ]);
  expect(content).toEqual([
    {
      type: "text",
      text: "Human: 2+2?\n\nAssistant: 4\n\nHuman: and +1?\n\nAssistant:",
    },
  ]);
});

test("images stay in place in the interleaved transcript", () => {
  const { content } = buildPrompt([
    {
      role: "user",
      content: [
        { type: "text", text: "first:" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        { type: "text", text: "second:" },
        { type: "image_url", image_url: { url: "https://x.test/a.jpg" } },
        { type: "image_url" }, // no url — dropped
      ],
    },
    { role: "assistant", content: "the second" },
    { role: "user", content: "why?" },
  ]);
  expect(content).toEqual([
    { type: "text", text: "Human: first:" },
    {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAAA" },
    },
    { type: "text", text: "\nsecond:" },
    { type: "image", source: { type: "url", url: "https://x.test/a.jpg" } },
    {
      type: "text",
      text: "\n\nAssistant: the second\n\nHuman: why?\n\nAssistant:",
    },
  ]);
});

test("chunk/sseError/SSE_DONE emit byte-exact SSE frames", () => {
  expect(chunk("c", 5, "m", { content: "hi" })).toBe(
    `data: {"id":"c","object":"chat.completion.chunk","created":5,"model":"m","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n`,
  );
  expect(chunk("c", 5, "m", {}, "stop", { total_tokens: 3 })).toBe(
    `data: {"id":"c","object":"chat.completion.chunk","created":5,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"total_tokens":3}}\n\n`,
  );
  expect(sseError("boom")).toBe(
    `data: {"error":{"message":"boom","type":"api_error"}}\n\n`,
  );
  expect(SSE_DONE).toBe("data: [DONE]\n\n");
});

test("completion builds the OpenAI response object", () => {
  expect(
    completion("c", 5, "m", "hi", "stop", {
      prompt_tokens: 1,
      completion_tokens: 2,
      total_tokens: 3,
    }),
  ).toEqual({
    id: "c",
    object: "chat.completion",
    created: 5,
    model: "m",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "hi" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  });
});

test("interpretResult classifies success and error results", () => {
  const base = {
    type: "result",
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    total_cost_usd: 0,
    session_id: "s",
    usage: { input_tokens: 1, output_tokens: 2 },
  };
  expect(
    interpretResult({
      ...base,
      subtype: "success",
      is_error: false,
      result: "hi",
      stop_reason: "max_tokens",
    } as SDKResultMessage),
  ).toEqual({
    ok: true,
    text: "hi",
    finish: "length",
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  });
  expect(
    interpretResult({
      ...base,
      subtype: "error_during_execution",
      is_error: true,
      errors: ["a", "b"],
    } as unknown as SDKResultMessage),
  ).toEqual({ ok: false, subtype: "error_during_execution", detail: "a; b" });
});

test("modelEntry maps family pricing and modalities", () => {
  const opus = modelEntry("claude-opus-4-8", 1);
  expect(opus.pricing.prompt).toBe("0.000015");
  expect(opus.pricing.input_cache_write).toBe("0.00001875");
  expect(opus.architecture.modality).toBe("text+image->text");
  expect(opus.architecture.input_modalities).toEqual(["text", "image"]);
  expect(opus.pricing.image).toBe("0.024");
  expect(modelEntry("haiku", 1).pricing.completion).toBe("0.000005");
  expect(modelEntry("haiku", 1).pricing.image).toBe("0.0016");
  expect(modelEntry("claude-sonnet-5", 1).pricing.prompt).toBe("0.000003");
  expect(modelEntry("sonnet", 1, "Sonnet").name).toBe("Sonnet");
});
