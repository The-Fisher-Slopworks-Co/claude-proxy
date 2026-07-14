// ---- startup ----
import { chatCompletions } from "./chat";
import { ALLOWED_TOOLS, DEFAULT_MODEL, HOST, LOG_LEVEL, MODELS, PORT } from "./config";
import { log } from "./log";
import { modelEntry, now, oaiError } from "./openai";

const STARTED = now();

const staticModels = () =>
  Response.json({
    object: "list",
    data: MODELS.map((id) => modelEntry(id, STARTED)),
  });

// Proxy Anthropic's GET /v1/models, mapped to the OpenAI list shape.
// NOTE: no cache; add one if clients hammer this route
async function listModels(): Promise<Response> {
  const key = process.env.ANTHROPIC_API_KEY;
  const oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!key && !oauth) {
    // CLI stored login — no token we can send upstream
    log("debug", "request.access", { route: "/v1/models", source: "static" });
    return staticModels();
  }
  const headers: Record<string, string> = {
    "anthropic-version": "2023-06-01",
    ...(key
      ? { "x-api-key": key }
      : {
          authorization: `Bearer ${oauth}`,
          "anthropic-beta": "oauth-2025-04-20",
        }),
  };
  try {
    const res = await fetch("https://api.anthropic.com/v1/models?limit=1000", {
      headers,
    });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    const body = (await res.json()) as {
      data: { id: string; created_at: string; display_name?: string }[];
    };
    log("debug", "request.access", { route: "/v1/models", source: "anthropic" });
    return Response.json({
      object: "list",
      data: body.data.map((m) =>
        modelEntry(m.id, Math.floor(Date.parse(m.created_at) / 1000), m.display_name),
      ),
    });
  } catch (e) {
    log("warn", "models.upstream_failed", {
      detail: e instanceof Error ? e.message : String(e),
    });
    return staticModels();
  }
}

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
  idleTimeout: 255, // NOTE: Bun max; non-stream completions can be slow
  routes: {
    "/health": () => {
      log("debug", "request.access", { route: "/health" });
      return Response.json({ status: "ok" });
    },
    "/v1/models": listModels,
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
