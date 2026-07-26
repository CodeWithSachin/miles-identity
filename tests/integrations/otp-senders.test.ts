/**
 * OTP senders. The over-the-wire call is a true external (not exercised here — the
 * plugin injects a mock). What IS asserted: the right provider request is built,
 * a missing secret fails loudly, and neither the OTP nor the full recipient is
 * ever logged (security.md never-logged list).
 *
 * `bun test` runs with NODE_ENV=test and does not auto-load `.env.local`, so this
 * file supplies the tier-1 config `getConfig()` needs (dummy values — the senders
 * never connect to Postgres/Redis) and restores the environment afterwards so the
 * other suites see it untouched, mirroring tests/auth/instance.test.ts.
 */

import { test, expect, describe, beforeAll, afterAll, afterEach, spyOn } from "bun:test";
import { buildSmsRequest } from "@/integrations/sms";
import { sendEmailOtp } from "@/integrations/email";
import { resetConfigCache } from "@/lib/config";
import { ConfigError } from "@/lib/errors";

const REQUIRED: Record<string, string> = {
  TZ: "UTC",
  BASE_URL: "http://localhost:3000",
  BETTER_AUTH_URL: "http://localhost:3000",
  BETTER_AUTH_SECRET: "test-secret-not-real-0000000000000000",
  DATABASE_URL: "postgres://postgres@127.0.0.1:5432/postgres",
  REDIS_URL: "redis://127.0.0.1:6379",
  EMAIL_FROM: "no-reply@miles.com",
};

const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const [key, value] of Object.entries(REQUIRED)) {
    saved[key] = Bun.env[key];
    if (Bun.env[key] === undefined || Bun.env[key] === "") Bun.env[key] = value;
  }
});

afterAll(() => {
  for (const [key, previous] of Object.entries(saved)) {
    if (previous === undefined) delete Bun.env[key];
    else Bun.env[key] = previous;
  }
  resetConfigCache();
});

describe("buildSmsRequest", () => {
  test("targets msg91 with the auth key header", () => {
    const req = buildSmsRequest("msg91", "+919811100777", "123456", "KEY", "MILES");
    expect(req.url).toContain("msg91.com");
    expect((req.init.headers as Record<string, string>).authkey).toBe("KEY");
    expect(req.init.body).toContain("123456");
  });

  test("targets gupshup with the api key header and sender as source", () => {
    const req = buildSmsRequest("gupshup", "+919811100777", "123456", "KEY", "MILES");
    expect(req.url).toContain("gupshup.io");
    expect((req.init.headers as Record<string, string>).apikey).toBe("KEY");
    expect(req.init.body).toContain("source=MILES");
  });

  test("targets twilio's Messages API with bearer auth", () => {
    const req = buildSmsRequest("twilio", "+919811100777", "123456", "KEY", "MILES");
    expect(req.url).toContain("twilio.com");
    expect((req.init.headers as Record<string, string>).authorization).toBe("Bearer KEY");
    expect(req.init.body).toContain("From=MILES");
  });
});

describe("sendEmailOtp — missing secret fails loudly", () => {
  afterEach(() => {
    Bun.env.EMAIL_PROVIDER_API_KEY = saved.EMAIL_PROVIDER_API_KEY ?? "email-key-secret";
    resetConfigCache();
  });

  // The rest of the config is valid, so this fails specifically because the gateway
  // key is unset — requireLater throws before any fetch, never passing `undefined`
  // to the provider.
  test("throws a ConfigError when EMAIL_PROVIDER_API_KEY is unset", async () => {
    delete Bun.env.EMAIL_PROVIDER_API_KEY;
    resetConfigCache();
    await expect(sendEmailOtp("user@example.com", "123456")).rejects.toBeInstanceOf(ConfigError);
  });
});

describe("no secret, OTP, or full recipient in logs", () => {
  test("a successful email send logs neither the code nor the address", async () => {
    Bun.env.EMAIL_PROVIDER_API_KEY = "email-key-secret";
    resetConfigCache();

    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 202 }));
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    let logged = "";
    try {
      await sendEmailOtp("secret-user@example.com", "987654");
      logged = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    } finally {
      logSpy.mockRestore();
      fetchSpy.mockRestore();
    }

    expect(logged).toContain("otp_email_sent");
    expect(logged).not.toContain("987654");
    expect(logged).not.toContain("secret-user@example.com");
    expect(logged).not.toContain("email-key-secret");
  });
});
