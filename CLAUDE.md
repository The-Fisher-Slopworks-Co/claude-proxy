# claude-proxy

Local OpenAI-compatible HTTP proxy in front of Claude Code. Accepts OpenAI Chat
Completions requests and serves them through a Claude subscription via
`@anthropic-ai/claude-agent-sdk`. Entry point: `src/index.ts`.

## Commands

```sh
bun src/index.ts        # run   -> http://127.0.0.1:8787/v1
bun run dev             # run with --hot reload
bun test                # run src/*.test.ts
claude setup-token      # one-time: mint the subscription OAuth token for .env
```

Requires [Bun](https://bun.sh) and the Claude Code CLI (`claude`) on PATH.
Config is env-only (see `.env.example`): `HOST`, `PORT`, `DEFAULT_MODEL`,
`ALLOWED_TOOLS`, `LOG_LEVEL`, `LOG_FORMAT`.

## Architecture

`src/` — no framework, `Bun.serve` routes only:

- `index.ts`  — server, routes (`/health`, `/v1/models`, `/v1/chat/completions`), startup checks
- `chat.ts`   — `POST /v1/chat/completions`: OpenAI request -> SDK `query()`, JSON + SSE paths
- `openai.ts` — OpenAI wire format: prompt building, response/chunk encoding, model+pricing metadata
- `config.ts` — env parsing, model list, `childEnv`
- `log.ts`    — one structured event per line (pretty on a TTY, JSON when piped)

Flow: client request -> `buildPrompt` (history -> one interleaved text+image block
list) -> `query()` -> `interpretResult` -> JSON completion or SSE stream.

## Invariants (don't break these)

- `ANTHROPIC_API_KEY` is stripped from the child env (`childEnv`) so usage always
  bills the subscription OAuth, never an API key.
- Built-in tools are **off by default** (`ALLOWED_TOOLS` empty) — proxy behaves like
  a plain text model, never touches the filesystem.
- `permissionMode: "dontAsk"` — never hang on a permission prompt.
- `settingSources: []` — never leak local CLAUDE.md/settings into responses.
- Stateless: clients send full history each request; it's rendered into one prompt.
- Binds 127.0.0.1 only; the proxy has no auth of its own.

## Conventions

- Default to Bun, not Node: `bun <file>`, `bun test`, `bun install`, `Bun.serve`,
  `Bun.file`, `Bun.$`. No express/vite/webpack/dotenv/ws. Bun auto-loads `.env`.
- No frontend in this project. Bun docs: `node_modules/bun-types/docs/**.mdx`.
