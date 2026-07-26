import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  parseConfig,
  formatIssues,
  failingKeys,
  loadConfig,
  requireLater,
  redactedSummary,
  resetConfigCache,
  scrubValues,
  type RawEnv,
} from "@/lib/config";
import { ConfigError } from "@/lib/errors";
import { redact } from "@/lib/logger";

const VALID: RawEnv = {
  NODE_ENV: "test",
  PORT: "3000",
  TZ: "UTC",
  BASE_URL: "http://localhost:3000",
  DATABASE_URL: "postgres://postgres:postgres@localhost:5432/miles_identity_test",
  REDIS_URL: "redis://localhost:6379",
  BETTER_AUTH_SECRET: "0123456789012345678901234567890123456789",
  BETTER_AUTH_URL: "http://localhost:3000",
};

function withEnv(overrides: RawEnv): RawEnv {
  return { ...VALID, ...overrides };
}

/** Fail a parse and return the flat message list. */
function issuesFor(env: RawEnv): string[] {
  const result = parseConfig(env);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  return formatIssues(result.issues, env);
}

describe("parseConfig", () => {
  test("parses a valid environment", () => {
    const result = parseConfig(VALID);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    expect(result.value.NODE_ENV).toBe("test");
    expect(result.value.PORT).toBe(3000);
    expect(result.value.TZ).toBe("UTC");
  });

  test("applies defaults for PORT, ACCESS_TOKEN_TTL_SECONDS and PHONE_PLACEHOLDER_DOMAIN", () => {
    const { PORT: _port, ...withoutPort } = VALID;
    const result = parseConfig(withoutPort);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    expect(result.value.PORT).toBe(3000);
    expect(result.value.ACCESS_TOKEN_TTL_SECONDS).toBe(900);
    expect(result.value.PHONE_PLACEHOLDER_DOMAIN).toBe("phone.miles.com");
  });

  test("ignores keys that are not in the schema", () => {
    const result = parseConfig(withEnv({ TOTALLY_UNRELATED: "value" }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value).not.toHaveProperty("TOTALLY_UNRELATED");
  });

  test("rejects a missing required key, naming it", () => {
    const { BETTER_AUTH_SECRET: _omitted, ...missing } = VALID;

    const result = parseConfig(missing);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");

    expect(formatIssues(result.issues, missing).join("\n")).toContain("BETTER_AUTH_SECRET");
    expect(failingKeys(result.issues)).toContain("BETTER_AUTH_SECRET");
  });

  test("rejects BETTER_AUTH_SECRET under 32 characters", () => {
    const messages = issuesFor(withEnv({ BETTER_AUTH_SECRET: "tooshort" }));
    expect(messages.join("\n")).toContain("BETTER_AUTH_SECRET");
    expect(messages.join("\n")).toContain("32");
  });

  // Negative — guards every Bun.cron schedule added from step 14 onwards.
  test("rejects a non-UTC TZ", () => {
    const messages = issuesFor(withEnv({ TZ: "Asia/Kolkata" }));
    expect(messages.join("\n")).toContain("TZ");
    expect(messages.join("\n")).toContain("Bun.cron");
  });

  // Negative — the 5–15 minute token rule, made unrepresentable.
  test("rejects ACCESS_TOKEN_TTL_SECONDS above 900", () => {
    const messages = issuesFor(withEnv({ ACCESS_TOKEN_TTL_SECONDS: "3600" }));
    expect(messages.join("\n")).toContain("ACCESS_TOKEN_TTL_SECONDS");
    expect(messages.join("\n")).toContain("900");
  });

  test("accepts ACCESS_TOKEN_TTL_SECONDS at the 900 boundary", () => {
    const result = parseConfig(withEnv({ ACCESS_TOKEN_TTL_SECONDS: "900" }));
    expect(result.ok).toBe(true);
  });

  test("rejects a DATABASE_URL that is not a postgres scheme", () => {
    const messages = issuesFor(withEnv({ DATABASE_URL: "mysql://localhost:3306/db" }));
    expect(messages.join("\n")).toContain("DATABASE_URL");
  });

  test("rejects a REDIS_URL that is not a redis scheme", () => {
    const messages = issuesFor(withEnv({ REDIS_URL: "http://localhost:6379" }));
    expect(messages.join("\n")).toContain("REDIS_URL");
  });

  // Negative — the placeholder domain must never reach production.
  test("rejects temp.better-auth.com as PHONE_PLACEHOLDER_DOMAIN", () => {
    const messages = issuesFor(withEnv({ PHONE_PLACEHOLDER_DOMAIN: "temp.better-auth.com" }));
    expect(messages.join("\n")).toContain("PHONE_PLACEHOLDER_DOMAIN");
  });

  test("rejects an out-of-range PORT", () => {
    expect(parseConfig(withEnv({ PORT: "70000" })).ok).toBe(false);
    expect(parseConfig(withEnv({ PORT: "0" })).ok).toBe(false);
  });

  test("rejects an unknown NODE_ENV", () => {
    expect(parseConfig(withEnv({ NODE_ENV: "staging" })).ok).toBe(false);
  });
});

describe("DEV_OTP_BYPASS", () => {
  test("defaults to false", () => {
    const result = parseConfig(VALID);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.DEV_OTP_BYPASS).toBe(false);
  });

  test("parses true and false", () => {
    const trueResult = parseConfig(withEnv({ DEV_OTP_BYPASS: "true" }));
    expect(trueResult.ok).toBe(true);
    if (!trueResult.ok) throw new Error("unreachable");
    expect(trueResult.value.DEV_OTP_BYPASS).toBe(true);

    const falseResult = parseConfig(withEnv({ DEV_OTP_BYPASS: "false" }));
    expect(falseResult.ok).toBe(true);
    if (!falseResult.ok) throw new Error("unreachable");
    expect(falseResult.value.DEV_OTP_BYPASS).toBe(false);
  });

  // Security rule 14: a dev auth shortcut must be unrepresentable in production,
  // not merely discouraged — this is the negative test that proves it.
  test("rejects DEV_OTP_BYPASS=true when NODE_ENV=production", () => {
    const messages = issuesFor(withEnv({ DEV_OTP_BYPASS: "true", NODE_ENV: "production" }));
    expect(messages.join("\n")).toContain("DEV_OTP_BYPASS");
  });

  test("allows DEV_OTP_BYPASS=true under development and test", () => {
    expect(parseConfig(withEnv({ DEV_OTP_BYPASS: "true", NODE_ENV: "development" })).ok).toBe(true);
    expect(parseConfig(withEnv({ DEV_OTP_BYPASS: "true", NODE_ENV: "test" })).ok).toBe(true);
  });

  test("allows DEV_OTP_BYPASS=false under production", () => {
    expect(parseConfig(withEnv({ DEV_OTP_BYPASS: "false", NODE_ENV: "production" })).ok).toBe(true);
  });
});

describe("secret handling", () => {
  // SECURITY: a config validation error must never echo the received value.
  test("never includes a received secret value in a validation error", () => {
    const sentinel = "SUPERSECRET-sentinel-value-do-not-print";
    const env = withEnv({ BETTER_AUTH_SECRET: sentinel.slice(0, 12) });
    const output = issuesFor(env).join("\n");

    expect(output).not.toContain(sentinel.slice(0, 12));
    expect(output).toContain("BETTER_AUTH_SECRET");
  });

  // SECURITY: the same protection for a connection string.
  test("never includes a database connection string in a validation error", () => {
    const url = "mysql://appuser:hunter2@db.internal:3306/prod";
    const output = issuesFor(withEnv({ DATABASE_URL: url })).join("\n");

    expect(output).not.toContain("hunter2");
    expect(output).not.toContain("db.internal");
    expect(output).toContain("DATABASE_URL");
  });

  test("scrubValues replaces configured values but leaves short ones alone", () => {
    const env: RawEnv = { BETTER_AUTH_SECRET: "a-long-secret-value", TZ: "UTC" };
    expect(scrubValues("leaked a-long-secret-value here", env)).toBe("leaked [redacted] here");
    // "UTC" is 3 chars — below the scrub floor, and not a secret.
    expect(scrubValues("TZ must be UTC", env)).toBe("TZ must be UTC");
  });
});

describe("loadConfig", () => {
  test("throws ConfigError listing the failing keys", () => {
    const { DATABASE_URL: _a, REDIS_URL: _b, ...broken } = VALID;

    let thrown: unknown;
    try {
      loadConfig(broken);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConfigError);
    const err = thrown as ConfigError;
    expect(err.keys).toContain("DATABASE_URL");
    expect(err.keys).toContain("REDIS_URL");
    expect(err.expose).toBe(false);
  });

  test("returns a frozen object", () => {
    const config = loadConfig(VALID);
    expect(Object.isFrozen(config)).toBe(true);
  });
});

describe("requireLater", () => {
  // requireLater reads the memoised config, which loads from Bun.env. Populate
  // tier 1 so the failure under test is the unset tier-2 key, not a missing DB URL.
  beforeEach(() => {
    for (const [key, value] of Object.entries(VALID)) {
      if (value !== undefined) Bun.env[key] = value;
    }
    delete Bun.env["SMS_PROVIDER_API_KEY"];
    resetConfigCache();
  });

  afterEach(() => {
    resetConfigCache();
  });

  // Negative — a later feature must fail loudly at wiring time, not pass undefined
  // into an SMS gateway at 02:00.
  test("throws ConfigError naming an unset tier-2 key", () => {
    let thrown: unknown;
    try {
      requireLater("SMS_PROVIDER_API_KEY");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as ConfigError).message).toContain("SMS_PROVIDER_API_KEY");
    expect((thrown as ConfigError).keys).toEqual(["SMS_PROVIDER_API_KEY"]);
  });

  test("returns the value when a tier-2 key is set", () => {
    Bun.env["SMS_PROVIDER_API_KEY"] = "a-real-looking-key";
    resetConfigCache();
    expect(requireLater("SMS_PROVIDER_API_KEY")).toBe("a-real-looking-key");
    delete Bun.env["SMS_PROVIDER_API_KEY"];
  });
});

describe("redactedSummary", () => {
  beforeEach(() => {
    for (const [key, value] of Object.entries(VALID)) {
      if (value !== undefined) Bun.env[key] = value;
    }
    resetConfigCache();
  });

  afterEach(() => {
    resetConfigCache();
  });

  // SECURITY: the boot log line must carry no secret.
  test("exposes only non-secret fields", () => {
    const summary = redactedSummary();
    expect(Object.keys(summary).sort()).toEqual(["baseUrl", "configuredCount", "nodeEnv", "port", "tz"]);

    const serialised = JSON.stringify(summary);
    expect(serialised).not.toContain(VALID["BETTER_AUTH_SECRET"] as string);
    expect(serialised).not.toContain("postgres://");
    expect(serialised).not.toContain("redis://");
  });

  // Regression: a field named `configuredKeys` was silently redacted by the
  // logger's denylist, because it matches "key" as a substring. Field names in
  // the boot summary must survive redaction.
  test("field names survive the logger's redaction denylist", () => {
    const summary = redactedSummary();
    const logged = redact(summary) as Record<string, unknown>;

    expect(logged["configuredCount"]).toBe(summary.configuredCount);
    expect(logged["nodeEnv"]).toBe(summary.nodeEnv);
    expect(logged["baseUrl"]).toBe(summary.baseUrl);
    for (const value of Object.values(logged)) expect(value).not.toBe("[redacted]");
  });
});
