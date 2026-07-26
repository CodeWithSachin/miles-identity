/**
 * OTP sign-in logic. The alias-model and takeover-path guarantees live here,
 * driven through injected collaborators (an in-memory verification store, a faked
 * resolver, mocked senders). The resolver's real-Postgres truth — an unverified
 * handle resolves to null, a secondary verified alias resolves to the global id —
 * is proven in tests/identity/resolve.test.ts; this suite proves the flow acts
 * correctly on whatever the resolver returns.
 */

import { test, expect, describe, mock } from "bun:test";
import {
  startOtpSignin,
  verifyOtpSignin,
  type OtpStore,
  type StoredOtp,
} from "@/services/otp-signin";
import { hashOtp, otpIdentifier } from "@/services/otp";

const GLOBAL_ID = "usr_global_aaaaaaaaaaaaaaaaaa";

function memStore(): OtpStore & { map: Map<string, StoredOtp> } {
  const map = new Map<string, StoredOtp>();
  return {
    map,
    create: async (id, value, expiresAt) => void map.set(id, { value, expiresAt }),
    find: async (id) => map.get(id) ?? null,
    update: async (id, value) => {
      const record = map.get(id);
      if (record) map.set(id, { ...record, value });
    },
    delete: async (id) => void map.delete(id),
  };
}

function senders() {
  return {
    email: mock(async (_to: string, _otp: string): Promise<void> => {}),
    sms: mock(async (_to: string, _otp: string): Promise<void> => {}),
  };
}

const resolveTo = (id: string | null) => mock(async () => id);

describe("startOtpSignin", () => {
  // Takeover path 1: an unverified / unknown handle (resolver → null) must get
  // NEITHER an OTP nor a stored code.
  test("an unverified/unknown handle receives no OTP and stores nothing", async () => {
    const store = memStore();
    const send = senders();
    const outcome = await startOtpSignin("nobody@example.com", {
      resolveUser: resolveTo(null),
      store,
      senders: send,
    });
    expect(outcome).toBe("noop");
    expect(send.email).not.toHaveBeenCalled();
    expect(send.sms).not.toHaveBeenCalled();
    expect(store.map.size).toBe(0);
  });

  test("an unclassifiable handle receives no OTP", async () => {
    const store = memStore();
    const send = senders();
    const resolver = resolveTo(GLOBAL_ID);
    const outcome = await startOtpSignin("not-a-handle", { resolveUser: resolver, store, senders: send });
    expect(outcome).toBe("noop");
    expect(resolver).not.toHaveBeenCalled(); // never even queried
    expect(send.email).not.toHaveBeenCalled();
    expect(send.sms).not.toHaveBeenCalled();
  });

  // The OTP goes to the handle the user TYPED (normalised), by the handle's type.
  test("a verified email handle is sent an OTP at the typed address, via email", async () => {
    const store = memStore();
    const send = senders();
    const outcome = await startOtpSignin("  Alt@Example.com ", {
      resolveUser: resolveTo(GLOBAL_ID),
      store,
      senders: send,
    });
    expect(outcome).toBe("sent");
    expect(send.sms).not.toHaveBeenCalled();
    expect(send.email).toHaveBeenCalledTimes(1);
    expect(send.email.mock.calls[0]![0]).toBe("alt@example.com");
  });

  test("a verified phone handle is sent an OTP at the E.164 number, via SMS", async () => {
    const store = memStore();
    const send = senders();
    await startOtpSignin("9811100777", { resolveUser: resolveTo(GLOBAL_ID), store, senders: send });
    expect(send.email).not.toHaveBeenCalled();
    expect(send.sms).toHaveBeenCalledTimes(1);
    expect(send.sms.mock.calls[0]![0]).toBe("+919811100777");
  });

  // A failing gateway must not surface (that would leak existence) nor reject the
  // caller: the code is stored, the outcome is still "sent", the rejection is
  // swallowed and logged.
  // DEV_OTP_BYPASS (unrepresentable in production — src/lib/config.ts): the fixed
  // code replaces the random one and the gateway is never touched.
  test("devOtp uses the fixed code and never calls the sender", async () => {
    const store = memStore();
    const send = senders();
    const outcome = await startOtpSignin("user@example.com", {
      resolveUser: resolveTo(GLOBAL_ID),
      store,
      senders: send,
      devOtp: "000000",
    });
    expect(outcome).toBe("dev_bypass");
    expect(send.email).not.toHaveBeenCalled();
    expect(send.sms).not.toHaveBeenCalled();

    const result = await verifyOtpSignin("user@example.com", "000000", {
      resolveUser: resolveTo(GLOBAL_ID),
      store,
    });
    expect(result).toEqual({ ok: true, userId: GLOBAL_ID });
  });

  test("a send failure does not surface — outcome is still sent, code still stored", async () => {
    const store = memStore();
    const failing = {
      email: mock((_to: string, _otp: string) => Promise.reject(new Error("gateway down"))),
      sms: mock(async (_to: string, _otp: string): Promise<void> => {}),
    };
    const outcome = await startOtpSignin("user@example.com", {
      resolveUser: resolveTo(GLOBAL_ID),
      store,
      senders: failing,
    });
    await Promise.resolve(); // let the swallowed rejection settle
    expect(outcome).toBe("sent");
    expect(store.map.size).toBe(1);
  });
});

describe("verifyOtpSignin", () => {
  // Full round-trip: the session is minted for the GLOBAL id the resolver returns,
  // even though a secondary alias was typed. Then the code is consumed.
  test("a correct OTP resolves to the global user id and consumes the code", async () => {
    const store = memStore();
    const send = senders();
    const resolver = resolveTo(GLOBAL_ID);
    await startOtpSignin("alt@example.com", { resolveUser: resolver, store, senders: send });
    const otp = send.email.mock.calls[0]![1] as string;

    const result = await verifyOtpSignin("alt@example.com", otp, { resolveUser: resolver, store });
    expect(result).toEqual({ ok: true, userId: GLOBAL_ID });
    expect(await store.find(otpIdentifier("email", "alt@example.com"))).toBeNull();
  });

  // No session for a handle that does not resolve — same generic reject as a bad code.
  test("an unknown handle cannot verify", async () => {
    const store = memStore();
    const result = await verifyOtpSignin("nobody@example.com", "123456", {
      resolveUser: resolveTo(null),
      store,
    });
    expect(result).toEqual({ ok: false, reason: "invalid" });
  });

  test("a wrong OTP is rejected and increments the attempt counter", async () => {
    const store = memStore();
    const send = senders();
    const resolver = resolveTo(GLOBAL_ID);
    await startOtpSignin("user@example.com", { resolveUser: resolver, store, senders: send });
    const otp = send.email.mock.calls[0]![1] as string;
    const wrong = (otp[0] === "0" ? "1" : "0") + otp.slice(1);

    const result = await verifyOtpSignin("user@example.com", wrong, { resolveUser: resolver, store });
    expect(result).toEqual({ ok: false, reason: "invalid" });

    const stored = await store.find(otpIdentifier("email", "user@example.com"));
    expect(JSON.parse(stored!.value).attempts).toBe(1);
  });

  test("an expired OTP is rejected", async () => {
    const store = memStore();
    const id = otpIdentifier("email", "exp@example.com");
    await store.create(id, JSON.stringify({ hash: await hashOtp("123456"), attempts: 0 }), new Date(Date.now() - 1000));

    const result = await verifyOtpSignin("exp@example.com", "123456", { resolveUser: resolveTo(GLOBAL_ID), store });
    expect(result).toEqual({ ok: false, reason: "invalid" });
  });

  test("the code locks after the attempt cap and is deleted", async () => {
    const store = memStore();
    const id = otpIdentifier("email", "lock@example.com");
    await store.create(id, JSON.stringify({ hash: await hashOtp("123456"), attempts: 3 }), new Date(Date.now() + 60_000));

    const result = await verifyOtpSignin("lock@example.com", "123456", {
      resolveUser: resolveTo(GLOBAL_ID),
      store,
      maxAttempts: 3,
    });
    expect(result).toEqual({ ok: false, reason: "locked" });
    expect(await store.find(id)).toBeNull();
  });
});
