/**
 * Salesforce back-reference sync (AGENTS.md roadmap step 12; prompts/013). A
 * true external — mocked in tests, real over the wire in production, same
 * category as `integrations/email.ts`/`sms.ts`.
 *
 * Two plain `fetch` calls (OAuth2 client-credentials, then one PATCH) — no
 * `jsforce` or any Salesforce SDK (prompts/013, Assumption 5: two `fetch`
 * calls don't need one, and AGENTS.md's stack table doesn't list one).
 *
 * `applySalesforceContactLinkEvent` is the dispatch target `src/jobs/outbox-
 * worker.ts` calls for a `salesforce_contact_link` outbox row — the write to
 * `user_product_access`/`user_identity` and this back-reference PATCH are
 * deliberately NOT one atomic operation (AGENTS.md: only a domain write PLUS
 * its own outbox row commit together; the outbox row is what makes the PATCH
 * itself retryable via the existing claim/attempts/last_error drain loop).
 *
 * `SALESFORCE_CLIENT_SECRET` and the access token it produces never leave this
 * module and are never logged (security.md).
 */

import { z } from "zod";
import { requireLater } from "@/lib/config";
import { IntegrationError } from "@/lib/errors";
import { log } from "@/lib/logger";
import type { OutboxRow } from "@/db/types";

const API_VERSION = "v61.0";

async function getSalesforceAccessToken(): Promise<string> {
  const instanceUrl = requireLater("SALESFORCE_INSTANCE_URL");
  const clientId = requireLater("SALESFORCE_CLIENT_ID");
  const clientSecret = requireLater("SALESFORCE_CLIENT_SECRET");

  const res = await fetch(`${instanceUrl}/services/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
  });
  if (!res.ok) {
    throw new IntegrationError("salesforce", `token endpoint responded ${res.status}`);
  }
  const body = (await res.json()) as { access_token?: unknown };
  if (typeof body.access_token !== "string" || body.access_token.length === 0) {
    throw new IntegrationError("salesforce", "token response had no access_token");
  }
  return body.access_token;
}

/**
 * Sets `Contact.Internal_User_ID__c` — link on the Contact id (`003…`), never
 * a Lead id (`00Q…`): the id changes on conversion, so the caller must already
 * have resolved to the post-conversion Contact id before calling this.
 */
export async function linkContactToUser(contactId: string, userId: string): Promise<void> {
  const instanceUrl = requireLater("SALESFORCE_INSTANCE_URL");
  const accessToken = await getSalesforceAccessToken();

  const res = await fetch(`${instanceUrl}/services/data/${API_VERSION}/sobjects/Contact/${contactId}`, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ Internal_User_ID__c: userId }),
  });
  if (!res.ok) {
    throw new IntegrationError("salesforce", `contact patch responded ${res.status}`);
  }
  // no token, no request body — only that a link was written.
  log.info("salesforce_contact_linked", { contactId, userId });
}

const SalesforceContactLinkPayload = z.object({
  contactId: z.string(),
  userId: z.string(),
});

/**
 * The outbox dispatch target for `aggregate: 'salesforce_contact_link'` rows
 * (prompts/013, Assumption 4). Mirrors `authz/tuples.ts`'s `applyOutboxEvent`
 * shape: skip (not throw) an aggregate this function doesn't own, so a future
 * aggregate can't jam this handler; a payload that fails to parse is a real
 * producer bug and is left to throw so `attempts`/`last_error` capture it.
 */
export async function applySalesforceContactLinkEvent(row: OutboxRow): Promise<void> {
  if (row.aggregate !== "salesforce_contact_link") return;

  const payload = SalesforceContactLinkPayload.parse(row.payload);
  await linkContactToUser(payload.contactId, payload.userId);
}
