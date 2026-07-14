# claude-proxy

Local OpenAI-compatible HTTP proxy in front of Claude Code. Accepts OpenAI
Chat Completions requests and serves them through your Claude subscription via
`@anthropic-ai/claude-agent-sdk`. Lets OpenAI-only tools (aider, cline,
OpenClaw, any `openai` SDK client) use Claude.

- `POST /v1/chat/completions` — non-streaming and `"stream": true` (SSE)
- `GET /v1/models`
- `GET /health`

Built-in Claude Code tools (Bash/Edit/Read/…) are **disabled by default**: the
proxy behaves like a plain text model, never touches your filesystem, never
blocks on permission prompts. Opt back in with `ALLOWED_TOOLS`.

## Setup

Requires [Bun](https://bun.sh) and the Claude Code CLI (`claude`) on PATH.

```sh
bun install

# subscription auth token (API keys are not used and are stripped from the env)
claude setup-token
# put the printed token into .env
cp .env.example .env

# client API key — REQUIRED, the proxy refuses to start without it
echo "sk-cproxy-$(openssl rand -hex 32)"   # put the result into .env as API_KEY
```

If `CLAUDE_CODE_OAUTH_TOKEN` is unset, the proxy falls back to the CLI's
stored login (`claude /login`). Either way `ANTHROPIC_API_KEY` is never passed
to the Claude Code subprocess, so usage always bills the subscription.

## Authentication

Every `/v1/*` request must carry the configured key as an OpenAI-standard
bearer token: `Authorization: Bearer <API_KEY>`. Requests without it (or with
the wrong key) get `401`. `/health` stays open for liveness probes. The proxy
**refuses to start** if `API_KEY` is unset, so it is never unintentionally open.

## Run

```sh
bun src/index.ts
# claude-proxy: http://127.0.0.1:8787/v1
```

Config via env (see `.env.example`): `API_KEY` (required), `HOST`, `PORT`,
`DEFAULT_MODEL` (default `sonnet`), `ALLOWED_TOOLS`, `LOG_LEVEL`.

## Observability

One event per line on stdout (warnings/errors on stderr). On a terminal you
get readable `HH:MM:SS LEVEL event key=value` text; when piped or running as
a service the same events come out as JSON lines for `jq`/log collectors
(override with `LOG_FORMAT=pretty|json`). Every response carries an
`x-request-id` header matching the `reqId` field in the logs.

Events at `LOG_LEVEL=info` (default):

- `startup` — bind address, default model, tools, auth method, log level
- `request.start` — reqId, resolved + requested model, stream flag, message
  count, prompt/system sizes
- `request.done` — status, total duration, SDK/API latency, turns, token
  usage, cost (USD), finish reason; streams add TTFT, chunk count, output size
- `request.error` / `request.reject` — what failed and why
- `client.abort` / `stream.cancel` — client disconnected mid-request

`LOG_LEVEL=debug` adds full prompt and response texts (`request.prompt`,
`request.response`), the SDK message flow (`sdk.message`), Claude Code
subprocess stderr (`claude.stderr`), and `/health`–`/v1/models` access logs.

```sh
LOG_LEVEL=debug bun src/index.ts | jq 'select(.event == "request.done")'
```

## Usage

Non-streaming:

```sh
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"sonnet","messages":[{"role":"user","content":"Say hi"}]}'
```

Streaming (SSE, ends with `data: [DONE]`):

```sh
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"sonnet","stream":true,"messages":[{"role":"user","content":"Count to 5"}]}'
```

Any OpenAI client — point it at the proxy and pass your `API_KEY`:

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="sk-cproxy-...")
r = client.chat.completions.create(
    model="sonnet",
    messages=[{"role": "user", "content": "Say hi"}],
)
print(r.choices[0].message.content)
```

Models: `sonnet`, `opus`, `haiku` or full IDs (`claude-sonnet-5`,
`claude-opus-4-8`, …). Requests for `gpt-*` models are routed to
`DEFAULT_MODEL`, so clients with hardcoded OpenAI model names just work.

Notes:

- The proxy is stateless — clients send the full message history each request
  (standard OpenAI behavior). History is rendered into a single prompt.
- `temperature`, `max_tokens` etc. are accepted and ignored (the Agent SDK
  does not expose them).
- Requests to `/v1/*` require `Authorization: Bearer <API_KEY>` (see
  [Authentication](#authentication)); `/health` is open.
- The proxy listens on 127.0.0.1 by default. `API_KEY` is what makes a wider
  bind safe, but it has no TLS — terminate HTTPS upstream if you expose it.

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).
