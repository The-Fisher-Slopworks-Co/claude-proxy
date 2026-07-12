// ---- config ----
export const HOST = process.env.HOST || "127.0.0.1";
export const PORT = Number(process.env.PORT || 8787);
export const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "sonnet";
// ponytail: comma-separated tool names, empty = all built-in tools off (safe default)
export const ALLOWED_TOOLS = (process.env.ALLOWED_TOOLS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
export const LOG_LEVEL = process.env.LOG_LEVEL === "debug" ? "debug" : "info";
// pretty (key=value text) on a terminal, JSON lines when piped/collected
export const LOG_FORMAT =
  process.env.LOG_FORMAT === "json" || process.env.LOG_FORMAT === "pretty"
    ? process.env.LOG_FORMAT
    : process.stdout.isTTY
      ? "pretty"
      : "json";

// Never let the subprocess see ANTHROPIC_API_KEY — it would silently win over
// subscription OAuth and bill the API key instead.
export const childEnv: Record<string, string | undefined> = {
  ...process.env,
  ANTHROPIC_API_KEY: undefined,
};

export const MODELS = [
  "sonnet",
  "opus",
  "haiku",
  "claude-sonnet-5",
  "claude-opus-4-8",
  "claude-haiku-4-5-20251001",
];
