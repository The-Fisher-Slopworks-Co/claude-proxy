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
```

If `CLAUDE_CODE_OAUTH_TOKEN` is unset, the proxy falls back to the CLI's
stored login (`claude /login`). Either way `ANTHROPIC_API_KEY` is never passed
to the Claude Code subprocess, so usage always bills the subscription.

## Run

```sh
bun index.ts
# claude-proxy: http://127.0.0.1:8787/v1
```

Config via env (see `.env.example`): `HOST`, `PORT`, `DEFAULT_MODEL`
(default `sonnet`), `ALLOWED_TOOLS`.

## Usage

Non-streaming:

```sh
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"sonnet","messages":[{"role":"user","content":"Say hi"}]}'
```

Streaming (SSE, ends with `data: [DONE]`):

```sh
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"sonnet","stream":true,"messages":[{"role":"user","content":"Count to 5"}]}'
```

Any OpenAI client — point it at the proxy; the API key is ignored:

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="unused")
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
- The proxy listens on 127.0.0.1 and has no auth of its own — don't bind it
  to a public interface.
