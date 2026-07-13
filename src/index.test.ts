import { test, expect } from "bun:test";
import { buildPrompt, modelEntry, textOf } from "./openai";

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
