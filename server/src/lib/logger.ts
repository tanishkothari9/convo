/**
 * One line per meaningful event. Provider credentials, session cookies, and
 * customer session ids never appear here: an id that is also a credential is
 * logged as a short digest instead.
 */
import { createHash } from "node:crypto";

type Level = "info" | "warn" | "error";

function emit(level: Level, message: string, fields?: Record<string, unknown>) {
  const time = new Date().toISOString();
  const rest = fields
    ? " " +
      Object.entries(fields)
        .filter(([, v]) => v !== undefined)
        .map(
          ([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`,
        )
        .join(" ")
    : "";
  const line = `${time} ${level.toUpperCase().padEnd(5)} ${message}${rest}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  info: (message: string, fields?: Record<string, unknown>) =>
    emit("info", message, fields),
  warn: (message: string, fields?: Record<string, unknown>) =>
    emit("warn", message, fields),
  error: (message: string, fields?: Record<string, unknown>) =>
    emit("error", message, fields),
};

/** A stable short digest, for logging something that must not be logged whole. */
export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 10);
}
