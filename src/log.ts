// SPDX-FileCopyrightText: 2026 The Fisher Slopworks Co
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { LOG_FORMAT, LOG_LEVEL } from "./config";

type LogLevel = "debug" | "info" | "warn" | "error";

export function log(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> = {},
) {
  if (level === "debug" && LOG_LEVEL !== "debug") return;
  let line: string;
  if (LOG_FORMAT === "json") {
    line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      event,
      ...fields,
    });
  } else {
    const kv = Object.entries(fields)
      .map(([k, v]) =>
        typeof v === "string" && !/\s/.test(v)
          ? `${k}=${v}`
          : `${k}=${JSON.stringify(v)}`,
      )
      .join(" ");
    line = `${new Date().toISOString().slice(11, 23)} ${level.toUpperCase().padEnd(5)} ${event}${kv ? "  " + kv : ""}`;
  }
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
