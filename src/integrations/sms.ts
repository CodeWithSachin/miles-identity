/**
 * SMS OTP delivery (AGENTS.md: integrations/ = SMS gateway). A true external —
 * mocked in tests, real over the wire in production.
 *
 * Secrets (`SMS_PROVIDER`, `SMS_PROVIDER_API_KEY`, `SMS_SENDER_ID`) never leave
 * this module: read through `requireLater`, put on the outbound request, and
 * NEVER logged. The OTP and the destination number are never logged either
 * (security.md: full phone numbers and OTP codes are on the never-logged list).
 */

import { requireLater } from "@/lib/config";
import { IntegrationError } from "@/lib/errors";
import { log } from "@/lib/logger";

type SmsProvider = "gupshup" | "msg91" | "twilio";

export type SmsRequest = { url: string; init: RequestInit };

function messageBody(otp: string): string {
  return `Your Miles verification code is ${otp}. It expires in 5 minutes.`;
}

/**
 * Build the provider-specific send request. Pure and exhaustive — only the one
 * configured `SMS_PROVIDER` is ever built at runtime, but every branch is here so
 * a config value can never fall through to `undefined`.
 *
 * ponytail: payload shapes follow each vendor's transactional-SMS API. Confirm
 * against the live account before go-live — Twilio in particular authenticates
 * with an Account SID + auth token and addresses `/Accounts/{SID}/Messages.json`;
 * this maps our single API key to the auth token and expects the SID to be folded
 * into the base via the provider console. Wire a dedicated var if the account
 * separates them.
 */
export function buildSmsRequest(
  provider: SmsProvider,
  to: string,
  otp: string,
  apiKey: string,
  senderId: string,
): SmsRequest {
  switch (provider) {
    case "msg91":
      return {
        url: "https://control.msg91.com/api/v5/otp",
        init: {
          method: "POST",
          headers: { authkey: apiKey, "content-type": "application/json" },
          body: JSON.stringify({ mobile: to, otp, sender: senderId }),
        },
      };
    case "gupshup":
      return {
        url: "https://api.gupshup.io/sm/api/v1/msg",
        init: {
          method: "POST",
          headers: { apikey: apiKey, "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            channel: "sms",
            source: senderId,
            destination: to,
            message: messageBody(otp),
          }).toString(),
        },
      };
    case "twilio":
      return {
        url: "https://api.twilio.com/2010-04-01/Messages.json",
        init: {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ To: to, From: senderId, Body: messageBody(otp) }).toString(),
        },
      };
  }
}

/** Send a sign-in OTP by SMS. Throws `IntegrationError` on a non-2xx response. */
export async function sendSmsOtp(to: string, otp: string): Promise<void> {
  const provider = requireLater("SMS_PROVIDER") as SmsProvider;
  const apiKey = requireLater("SMS_PROVIDER_API_KEY");
  const senderId = requireLater("SMS_SENDER_ID");

  const { url, init } = buildSmsRequest(provider, to, otp, apiKey, senderId);
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new IntegrationError("sms", `provider ${provider} responded ${res.status}`);
  }
  // provider name only — never the number, never the code.
  log.info("otp_sms_sent", { handleType: "phone", provider });
}
