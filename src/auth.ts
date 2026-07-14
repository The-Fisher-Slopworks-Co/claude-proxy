// SPDX-FileCopyrightText: 2026 The Fisher Slopworks Co
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// Client authentication: every /v1/* route requires `Authorization: Bearer <API_KEY>`.
import { createHash, timingSafeEqual } from "node:crypto";
import { API_KEY } from "./config";
import { log } from "./log";
import { oaiError } from "./openai";

// Compare via fixed-length SHA-256 digests: constant-time and no length leak.
const digest = (s: string) => createHash("sha256").update(s).digest();
const safeEqual = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

// Pure check — testable without touching the environment.
export function isAuthorized(authHeader: string | null, key: string): boolean {
  const presented = (authHeader ?? "").match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  return !!presented && !!key && safeEqual(presented, key);
}

// Wrap a route handler so it runs only for requests carrying a valid key.
export const authed =
  (handler: (req: Request) => Response | Promise<Response>) =>
  (req: Request): Response | Promise<Response> => {
    if (isAuthorized(req.headers.get("authorization"), API_KEY))
      return handler(req);
    log("warn", "request.reject", {
      reason: "unauthorized",
      method: req.method,
      path: new URL(req.url).pathname,
    });
    return oaiError(401, "Invalid API key", "invalid_request_error");
  };
