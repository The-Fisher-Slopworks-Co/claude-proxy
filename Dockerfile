# syntax=docker/dockerfile:1

# SPDX-FileCopyrightText: 2026 The Fisher Slopworks Co
#
# SPDX-License-Identifier: AGPL-3.0-or-later

# Debian (glibc) base: the Claude Code CLI ships a standalone glibc binary, so
# an Alpine/musl base won't run it. Bun runs the proxy itself — no Node needed.
ARG BUN_VERSION=1
FROM oven/bun:${BUN_VERSION}

# Claude Code CLI version to install: stable | latest | X.Y.Z.
ARG CLAUDE_VERSION=stable

# The installer only needs curl + TLS roots; the binary it fetches is native.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Run as the image's non-root `bun` user with a writable HOME — the CLI keeps
# its launcher and state under ~/.local and ~/.claude.
ENV HOME=/home/bun
ENV PATH=/home/bun/.local/bin:$PATH
RUN mkdir -p /app && chown bun:bun /app
USER bun
WORKDIR /app

# Install the Claude Code CLI (standalone binary -> ~/.local/bin/claude).
RUN curl -fsSL https://claude.ai/install.sh | bash -s -- "${CLAUDE_VERSION}" \
 && claude --version

# Dependencies first so edits under src/ don't bust the install layer.
COPY --chown=bun:bun package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Application source.
COPY --chown=bun:bun tsconfig.json ./
COPY --chown=bun:bun src ./src

# Bind all interfaces so the published port is reachable. This is safe only
# because API_KEY auth is mandatory (the proxy refuses to start without it).
# Supply secrets at runtime (-e / --env-file); there is no interactive
# `claude /login` inside a container, so CLAUDE_CODE_OAUTH_TOKEN is required:
#   API_KEY                 client bearer key (sk-cproxy-...)
#   CLAUDE_CODE_OAUTH_TOKEN subscription token from `claude setup-token`
ENV HOST=0.0.0.0 \
    PORT=8787
EXPOSE 8787

# /health needs no auth — a clean liveness signal.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS "http://localhost:${PORT}/health" || exit 1

CMD ["bun", "src/index.ts"]
