/**
 * Structured logging. One JSON line per call.
 *
 * No logging library — AGENTS.md: `console` with structured objects until there
 * is a measured reason otherwise.
 *
 * Redaction is a denylist on *key name*, applied before serialising, because the
 * cost of a leaked token in a log aggregator is unbounded. See skills/security.md
 * for the full "never logged" list.
 */

import { isAppError } from "./errors";

const DENY = [
  "password",
  "token",
  "secret",
  "otp",
  "hash",
  "authorization",
  "cookie",
  "assertion",
  "key",
  "credential",
] as const;

const REDACTED = "[redacted]";
const MAX_DEPTH = 5;

type Level = "info" | "warn" | "error";
export type Fields = Record<string, unknown>;

function isDenied(key: string): boolean {
  const lower = key.toLowerCase();
  return DENY.some(needle => lower.includes(needle));
}

/**
 * Replace denylisted values, cap depth, and tolerate cycles.
 * `seen` prevents a cyclic object from hanging the process.
 */
export function redact(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (value === null || typeof value !== "object") return value;

  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map(item => redact(item, depth + 1, seen));
  }

  const out: Fields = {};
  for (const [key, item] of Object.entries(value as Fields)) {
    out[key] = isDenied(key) ? REDACTED : redact(item, depth + 1, seen);
  }
  return out;
}

function emit(level: Level, event: string, fields?: Fields): void {
  const line = {
    ts: new Date().toISOString(),
    level,
    event,
    ...(fields ? (redact(fields) as Fields) : {}),
  };
  // Single call, single line. stdout for info/warn, stderr for error.
  const text = JSON.stringify(line);
  if (level === "error") console.error(text);
  else console.log(text);
}

/**
 * Describe an error for a log line without leaking a client-visible message.
 * Internal messages are logged server-side (that is the point of a log) but
 * `clientMessage()` is what may ever reach a response.
 */
function describeError(error: unknown): Fields {
  if (isAppError(error)) {
    return { errName: error.name, errCode: error.code, errMessage: error.message };
  }
  if (error instanceof Error) {
    return { errName: error.name, errMessage: error.message };
  }
  return { errName: "Unknown", errMessage: String(error) };
}

export const log = {
  info(event: string, fields?: Fields): void {
    emit("info", event, fields);
  },
  warn(event: string, fields?: Fields): void {
    emit("warn", event, fields);
  },
  error(event: string, error?: unknown, fields?: Fields): void {
    emit("error", event, { ...(error === undefined ? {} : describeError(error)), ...fields });
  },
};
