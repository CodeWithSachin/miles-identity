/**
 * Salesforce back-reference sync (prompts/013). The over-the-wire calls are a
 * true external — mocked here (testing-and-checks.md: "mock only true
 * externals"). Asserts the token-then-PATCH request shape, that a non-2xx from
 * either call fails loudly, and the outbox dispatch's aggregate guard.
 *
 * `bun test` runs with NODE_ENV=test and does not auto-load `.env.local` — this
 * file supplies the tier-1 config plus the Salesforce tier-2 vars directly,
 * mirroring tests/integrations/otp-senders.test.ts.
 */

import { test, expect, describe, beforeAll, afterAll, spyOn } from "bun:test";
import { applySalesforceContactLinkEvent, linkContactToUser } from "@/integrations/salesforce";
import { resetConfigCache } from "@/lib/config";
import { IntegrationError } from "@/lib/errors";
import type { OutboxRow } from "@/db/types";

const REQUIRED: Record<string, string> = {
  TZ: "UTC",
  BASE_URL: "http://localhost:3000",
  BETTER_AUTH_URL: "http://localhost:3000",
  BETTER_AUTH_SECRET: "test-secret-not-real-0000000000000000",
  DATABASE_URL: "postgres://postgres@127.0.0.1:5432/postgres",
  REDIS_URL: "redis://127.0.0.1:6379",
  SALESFORCE_INSTANCE_URL: "https://miles.my.salesforce.com",
  SALESFORCE_CLIENT_ID: "client-id",
  SALESFORCE_CLIENT_SECRET: "client-secret",
};

const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const [key, value] of Object.entries(REQUIRED)) {
    saved[key] = Bun.env[key];
    if (Bun.env[key] === undefined || Bun.env[key] === "") Bun.env[key] = value;
  }
  resetConfigCache();
});

afterAll(() => {
  for (const [key, previous] of Object.entries(saved)) {
    if (previous === undefined) delete Bun.env[key];
    else Bun.env[key] = previous;
  }
  resetConfigCache();
});

function row(overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: 1n,
    aggregate: "salesforce_contact_link",
    event_type: "link",
    payload: { contactId: "003xx0000000001", userId: "usr_1" },
    attempts: 0,
    last_error: null,
    created_at: new Date(),
    processed_at: null,
    ...overrides,
  };
}

describe("linkContactToUser", () => {
  test("fetches a token then PATCHes Internal_User_ID__c with a bearer header", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) {
        return new Response(JSON.stringify({ access_token: "tok-123" }), { status: 200 });
      }
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch);

    try {
      await linkContactToUser("003xx0000000001", "usr_1");
    } finally {
      fetchSpy.mockRestore();
    }

    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toContain("/services/oauth2/token");
    expect(calls[1]?.url).toBe(
      "https://miles.my.salesforce.com/services/data/v61.0/sobjects/Contact/003xx0000000001",
    );
    expect(calls[1]?.init.method).toBe("PATCH");
    expect((calls[1]?.init.headers as Record<string, string>).authorization).toBe("Bearer tok-123");
    expect(calls[1]?.init.body).toBe(JSON.stringify({ Internal_User_ID__c: "usr_1" }));
  });

  test("negative: a non-2xx token response throws IntegrationError before any PATCH", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 401 }));
    try {
      await expect(linkContactToUser("003xx0000000001", "usr_1")).rejects.toBeInstanceOf(IntegrationError);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("negative: a non-2xx PATCH response throws IntegrationError", async () => {
    let call = 0;
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
      call += 1;
      if (call === 1) return new Response(JSON.stringify({ access_token: "tok-123" }), { status: 200 });
      return new Response(null, { status: 500 });
    }) as unknown as typeof fetch);
    try {
      await expect(linkContactToUser("003xx0000000001", "usr_1")).rejects.toBeInstanceOf(IntegrationError);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("applySalesforceContactLinkEvent", () => {
  test("skips (no fetch call) for any other aggregate", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    try {
      await applySalesforceContactLinkEvent(row({ aggregate: "vendor_access" }));
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("dispatches a matching aggregate to linkContactToUser", async () => {
    let calls = 0;
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
      calls += 1;
      if (calls === 1) return new Response(JSON.stringify({ access_token: "tok-123" }), { status: 200 });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch);
    try {
      await applySalesforceContactLinkEvent(row());
      expect(calls).toBe(2);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
