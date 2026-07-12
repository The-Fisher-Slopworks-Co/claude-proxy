import { test, expect } from "bun:test";
import { buildPrompt, textOf } from "./index";

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
