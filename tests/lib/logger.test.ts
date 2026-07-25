import { test, expect, describe } from "bun:test";
import { redact, log } from "@/lib/logger";

/** Capture stdout/stderr for one call. */
function capture(fn: () => void): string {
  const lines: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    fn();
  } finally {
    console.log = origLog;
    console.error = origError;
  }
  return lines.join("\n");
}

describe("redact", () => {
  test("redacts a denylisted key at the top level", () => {
    const out = redact({ userId: "usr_1", password: "hunter2" }) as Record<string, unknown>;
    expect(out["userId"]).toBe("usr_1");
    expect(out["password"]).toBe("[redacted]");
  });

  test("matches denylisted names case-insensitively and as substrings", () => {
    const out = redact({
      Authorization: "Bearer abc",
      accessToken: "abc",
      passwordHash: "$argon2id$...",
      OTP_CODE: "123456",
      apiKey: "k",
      samlAssertion: "<xml>",
      refresh_secret: "s",
      credentials: "c",
      sessionCookie: "sid=1",
    }) as Record<string, unknown>;

    for (const value of Object.values(out)) expect(value).toBe("[redacted]");
  });

  test("leaves non-denylisted fields intact", () => {
    const out = redact({ userId: "usr_1", event: "login", count: 3, ok: true }) as Record<string, unknown>;
    expect(out).toEqual({ userId: "usr_1", event: "login", count: 3, ok: true });
  });

  test("redacts a denylisted key nested in an object and an array", () => {
    const out = redact({
      outer: { inner: { token: "leak-me" } },
      list: [{ secret: "leak-me-too" }, { safe: "fine" }],
    }) as Record<string, unknown>;

    const outer = out["outer"] as Record<string, Record<string, unknown>>;
    expect(outer["inner"]?.["token"]).toBe("[redacted]");

    const list = out["list"] as Record<string, unknown>[];
    expect(list[0]?.["secret"]).toBe("[redacted]");
    expect(list[1]?.["safe"]).toBe("fine");
  });

  test("caps depth rather than recursing without bound", () => {
    const deep = { a: { b: { c: { d: { e: { f: "too far" } } } } } };
    expect(JSON.stringify(redact(deep))).toContain("[truncated]");
  });

  // Would hang the process without cycle detection.
  test("terminates on a cyclic object", () => {
    type Node = { name: string; self?: Node };
    const node: Node = { name: "loop" };
    node.self = node;

    const out = redact(node) as Record<string, unknown>;
    expect(out["name"]).toBe("loop");
    expect(JSON.stringify(out)).toContain("[circular]");
  });
});

describe("log", () => {
  test("emits one line of valid JSON per call", () => {
    const output = capture(() => log.info("test_event", { userId: "usr_1" }));
    expect(output.split("\n").filter(Boolean)).toHaveLength(1);

    const parsed = JSON.parse(output) as Record<string, unknown>;
    expect(parsed["event"]).toBe("test_event");
    expect(parsed["level"]).toBe("info");
    expect(parsed["userId"]).toBe("usr_1");
    expect(typeof parsed["ts"]).toBe("string");
  });

  // SECURITY: a connection string must never survive a log call.
  test("never emits a connection-string-shaped value", () => {
    const output = capture(() =>
      log.error("db_failed", undefined, {
        databaseKey: "postgres://appuser:hunter2@db.internal:5432/prod",
      }),
    );

    expect(output).not.toContain("hunter2");
    expect(output).not.toContain("db.internal");
    expect(output).toContain("[redacted]");
  });

  // SECURITY: tokens and OTPs are the highest-value things in this system.
  test("never emits a token or an OTP", () => {
    const output = capture(() =>
      log.info("login_attempt", {
        userId: "usr_9988",
        accessToken: "eyJhbGciOiJSUzI1NiJ9.payload.sig",
        otp: "483920",
      }),
    );

    expect(output).not.toContain("eyJhbGciOiJSUzI1NiJ9");
    expect(output).not.toContain("483920");
    expect(output).toContain("usr_9988");
  });

  test("error() records name, code and message for an AppError", async () => {
    const { ConfigError } = await import("@/lib/errors");
    const output = capture(() => log.error("boom", new ConfigError("bad config", ["PORT"])));

    const parsed = JSON.parse(output) as Record<string, unknown>;
    expect(parsed["errName"]).toBe("ConfigError");
    expect(parsed["errCode"]).toBe("CONFIG_INVALID");
    expect(parsed["errMessage"]).toBe("bad config");
    expect(parsed["level"]).toBe("error");
  });

  test("error() tolerates a non-Error value", () => {
    const output = capture(() => log.error("boom", "just a string"));
    const parsed = JSON.parse(output) as Record<string, unknown>;
    expect(parsed["errName"]).toBe("Unknown");
    expect(parsed["errMessage"]).toBe("just a string");
  });
});
