/**
 * Email OTP delivery (AGENTS.md: integrations/ = email provider). A true external
 * — mocked in tests, real over the wire in production.
 *
 * `EMAIL_PROVIDER_API_KEY` and `EMAIL_FROM` never leave this module and are never
 * logged; neither is the OTP or the recipient address (security.md never-logged
 * list). Read through `requireLater` so a missing key fails loudly at send time,
 * not silently with `undefined`.
 *
 * ponytail / FLAGGED: the config names no specific email vendor (only an API key
 * and a From address), so `PROVIDER_ENDPOINT` below is a placeholder host, not a
 * live URL. Point it at the chosen transactional provider's send endpoint and
 * adjust the payload to that provider's contract before go-live. Tests inject a
 * mock sender, so this transport is never exercised under test.
 */

import { requireLater } from "@/lib/config";
import { IntegrationError } from "@/lib/errors";
import { log } from "@/lib/logger";

// Placeholder — replace with the real transactional-email provider endpoint.
const PROVIDER_ENDPOINT = "https://email-provider.invalid/v1/send";

/** Send a sign-in OTP by email. Throws `IntegrationError` on a non-2xx response. */
export async function sendEmailOtp(to: string, otp: string): Promise<void> {
  const apiKey = requireLater("EMAIL_PROVIDER_API_KEY");
  const from = requireLater("EMAIL_FROM");

  const res = await fetch(PROVIDER_ENDPOINT, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      from,
      to,
      subject: "Your Miles sign-in code",
      text: `Your Miles verification code is ${otp}. It expires in 5 minutes.`,
    }),
  });
  if (!res.ok) {
    throw new IntegrationError("email", `provider responded ${res.status}`);
  }
  // no recipient, no code — only that an email OTP was dispatched.
  log.info("otp_email_sent", { handleType: "email" });
}
