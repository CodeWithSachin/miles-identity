/**
 * OTP sign-in logic (AGENTS.md: services/ = logic, takes and returns plain data,
 * no Request/Response). The `aliasOtp` Better Auth plugin is the thin HTTP adapter
 * over these two functions; everything security-relevant lives here so it is
 * testable without standing up the auth HTTP stack.
 *
 * Collaborators are injected so the mandated negative tests can drive them:
 *   - `resolveUser` is the verified-only, alias-aware resolver. Its real-Postgres
 *     behaviour (unverified → null, secondary alias → the global id) is proven in
 *     tests/identity/resolve.test.ts; here it is a seam.
 *   - `store` is Better Auth's Redis-backed verification store in production.
 *   - `senders` are the email/SMS integrations (true externals, mocked in tests).
 *
 * See .agents/skills/alias-identity.md: only a verified handle may receive an OTP
 * or authenticate, the OTP goes to the typed handle, the session is the global id.
 */

import { normaliseHandle } from "@/identity/normalise";
import { generateOtp, hashOtp, verifyOtpHash, otpIdentifier } from "@/services/otp";
import { log } from "@/lib/logger";
import type { IdentityType } from "@/db/types";

export type Sender = (to: string, otp: string) => Promise<void>;

export type StoredOtp = { value: string; expiresAt: Date };

export type OtpStore = {
  create(identifier: string, value: string, expiresAt: Date): Promise<void>;
  find(identifier: string): Promise<StoredOtp | null>;
  update(identifier: string, value: string): Promise<void>;
  delete(identifier: string): Promise<void>;
};

type Parsed = { type: IdentityType; value: string };

export type StartDeps = {
  resolveUser: (parsed: Parsed) => Promise<string | null>;
  store: OtpStore;
  senders: { email: Sender; sms: Sender };
  ttlSeconds?: number;
  /** Dev-only fixed code (DEV_OTP_BYPASS, unrepresentable in production — see
   * src/lib/config.ts). When set, it replaces the random code AND the sender is
   * never called, so a dev box needs no working email/SMS gateway. */
  devOtp?: string | undefined;
};

/** `sent` on a verified hit, `noop` for a miss or an unclassifiable handle,
 * `dev_bypass` when the fixed dev code was used instead of sending. The caller
 * (plugin) returns the SAME body regardless — the outcome is for logging. */
export type StartOutcome = "sent" | "noop" | "dev_bypass";

const DEFAULT_TTL_SECONDS = 300;
const DEFAULT_MAX_ATTEMPTS = 3;

export async function startOtpSignin(handle: string, deps: StartDeps): Promise<StartOutcome> {
  const parsed = normaliseHandle(handle);
  if (!parsed) return "noop";

  // Verified-only: an unverified/unknown handle resolves to null and gets nothing
  // (takeover path 1 — no OTP to an unverified handle).
  const userId = await deps.resolveUser(parsed);
  if (!userId) return "noop";

  const otp = deps.devOtp ?? generateOtp();
  const expiresAt = new Date(Date.now() + (deps.ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000);
  await deps.store.create(
    otpIdentifier(parsed.type, parsed.value),
    JSON.stringify({ hash: await hashOtp(otp), attempts: 0 }),
    expiresAt,
  );

  // Dev bypass: the code is fixed and already stored above, so verify still works.
  // The sender is never called — no gateway, no possibility of leaking the fixed
  // code onto a real SMS/email provider's logs.
  if (deps.devOtp !== undefined) return "dev_bypass";

  // The OTP goes to the handle the user TYPED. Fire-and-forget so send latency is
  // not an existence oracle and a slow gateway does not stall the response; a
  // failed send is logged (surfacing it would itself disclose existence).
  const send = parsed.type === "email" ? deps.senders.email : deps.senders.sms;
  void send(parsed.value, otp).catch((err) => log.error("otp_send_failed", err, { handleType: parsed.type }));

  return "sent";
}

export type VerifyDeps = {
  resolveUser: (parsed: Parsed) => Promise<string | null>;
  store: OtpStore;
  maxAttempts?: number;
};

/** `invalid` is the one generic reject — a bad handle, a missing/expired code and a
 * wrong code are indistinguishable. `locked` is the attempt-cap breach. */
export type VerifyResult =
  | { ok: true; userId: string }
  | { ok: false; reason: "invalid" | "locked" };

export async function verifyOtpSignin(
  handle: string,
  otp: string,
  deps: VerifyDeps,
): Promise<VerifyResult> {
  const parsed = normaliseHandle(handle);
  if (!parsed) return { ok: false, reason: "invalid" };

  // Re-resolve on verify: a handle unverified or merged away between start and
  // verify cannot complete, and the session is minted for the CURRENT global id.
  const userId = await deps.resolveUser(parsed);
  if (!userId) return { ok: false, reason: "invalid" };

  const identifier = otpIdentifier(parsed.type, parsed.value);
  const record = await deps.store.find(identifier);
  if (!record || record.expiresAt < new Date()) return { ok: false, reason: "invalid" };

  const { hash, attempts } = JSON.parse(record.value) as { hash: string; attempts: number };
  if (attempts >= (deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)) {
    await deps.store.delete(identifier);
    return { ok: false, reason: "locked" };
  }

  if (!(await verifyOtpHash(otp, hash))) {
    await deps.store.update(identifier, JSON.stringify({ hash, attempts: attempts + 1 }));
    return { ok: false, reason: "invalid" };
  }

  // One code, one login: consume before the session is issued.
  await deps.store.delete(identifier);
  return { ok: true, userId };
}
