// ---- startup ----
import { chatCompletions } from "./chat";
import { ALLOWED_TOOLS, DEFAULT_MODEL, HOST, LOG_LEVEL, MODELS, PORT } from "./config";
import { log } from "./log";
import { now, oaiError } from "./openai";

const STARTED = now();

if (!Bun.which("claude")) {
  log("error", "startup.failed", {
    reason:
      "Claude Code CLI not found on PATH. Install: bun add -g @anthropic-ai/claude-code (then: claude setup-token)",
  });
  process.exit(1);
}
if (process.env.ANTHROPIC_API_KEY)
  log("warn", "startup.api_key_ignored", {
    detail:
      "ANTHROPIC_API_KEY is set but will NOT be passed to Claude Code — subscription OAuth only",
  });

Bun.serve({
  hostname: HOST,
  port: PORT,
  idleTimeout: 255, // ponytail: Bun max; non-stream completions can be slow
  routes: {
    "/health": () => {
      log("debug", "request.access", { route: "/health" });
      return Response.json({ status: "ok" });
    },
    "/v1/models": () => {
      log("debug", "request.access", { route: "/v1/models" });
      return Response.json({
        object: "list",
        data: MODELS.map((id) => ({
          id,
          object: "model",
          created: STARTED,
          owned_by: "anthropic",
        })),
      });
    },
    "/v1/chat/completions": { POST: chatCompletions },
  },
  fetch: (req) => {
    log("info", "request.reject", {
      reason: "unknown route",
      method: req.method,
      path: new URL(req.url).pathname,
    });
    return oaiError(404, "Not found", "invalid_request_error");
  },
});

log("info", "startup", {
  url: `http://${HOST}:${PORT}/v1`,
  default_model: DEFAULT_MODEL,
  tools: ALLOWED_TOOLS.length ? ALLOWED_TOOLS : "disabled",
  auth: process.env.CLAUDE_CODE_OAUTH_TOKEN
    ? "CLAUDE_CODE_OAUTH_TOKEN (subscription)"
    : "CLI stored login (no CLAUDE_CODE_OAUTH_TOKEN set)",
  log_level: LOG_LEVEL,
});
