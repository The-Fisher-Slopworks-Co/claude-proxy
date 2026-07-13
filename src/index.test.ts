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
  const { systemPrompt, prompt } = buildPrompt([
    { role: "system", content: "be terse" },
    { role: "user", content: "hello" },
  ]);
  expect(systemPrompt).toBe("be terse");
  expect(prompt).toBe("hello");
});

test("multi-turn history renders as a transcript", () => {
  const { prompt } = buildPrompt([
    { role: "user", content: "2+2?" },
    { role: "assistant", content: "4" },
    { role: "user", content: [{ type: "text", text: "and +1?" }] },
  ]);
  expect(prompt).toBe("Human: 2+2?\n\nAssistant: 4\n\nHuman: and +1?\n\nAssistant:");
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
