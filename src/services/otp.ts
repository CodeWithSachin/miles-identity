/**
 * Sign-in OTP primitives (AGENTS.md: services/ = logic, no Request/Response).
 *
 * The code is a secret: it is hashed before storage and never logged. Stored via
 * Better Auth's verification table (Redis-backed, TTL'd) by the alias-otp plugin;
 * this module owns only the code itself — generate, hash, verify, and the stable
 * identifier the stored row is keyed on.
 */

/** OTP length in digits. Six is the length every SMS/email template assumes. */
export const OTP_LENGTH = 6;

/**
 * A cryptographically-random numeric OTP, zero-padded to `length`. Rejection
 * sampling drops the tail of the u32 range that would bias the low digits — a
 * negligible skew for a 6-digit code, but avoiding it is one extra line, not
 * fifty, so we take the correct-on-edge-cases option.
 */
export function generateOtp(length: number = OTP_LENGTH): string {
  const ceiling = 10 ** length;
  const limit = Math.floor(0xffffffff / ceiling) * ceiling;
  const buf = new Uint32Array(1);
  let n: number;
  do {
    crypto.getRandomValues(buf);
    n = buf[0]!;
  } while (n >= limit);
  return (n % ceiling).toString().padStart(length, "0");
}

/** argon2id via Bun.password — a leaked verification row never reveals the code. */
export function hashOtp(otp: string): Promise<string> {
  return Bun.password.hash(otp);
}

export function verifyOtpHash(otp: string, hash: string): Promise<boolean> {
  return Bun.password.verify(otp, hash);
}

/**
 * The verification-row identifier for a sign-in OTP. Keyed on the NORMALISED
 * handle so the send path and the verify path address the same row. Deterministic
 * — the same (type, value) always maps to the same identifier.
 */
export function otpIdentifier(type: string, value: string): string {
  return `sign-in-otp:${type}:${value}`;
}
