/**
 * POST /api/internal/provision — the Salesforce Lead-conversion callout
 * (AGENTS.md roadmap step 12; prompts/013; .agents/skills/security.md).
 *
 * `/api/internal/*` is never reachable from the public internet: network
 * allowlisting is an infrastructure concern (out of scope for this file, same
 * category as provisioning `FGA_STORE_ID` itself — prompts/012's precedent),
 * but the signature check below is this endpoint's own, mandatory half of
 * "network allowlist AND signed requests, either alone is insufficient."
 *
 * Never added to `src/routes/docs.ts` or any Scalar spec, in any environment
 * (scalar-api-docs.md rule 2: "Never document /api/internal/*").
 */

import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { PRODUCT_IDS } from "@/db/types";
import { provisionFromSalesforce } from "@/services/salesforce-provisioning";
import { ValidationError } from "@/lib/errors";
import { requireLater } from "@/lib/config";
import { log } from "@/lib/logger";

const NO_STORE = { "cache-control": "no-store" } as const;

// A bare-body HMAC never expires; signing `{timestamp}.{rawBody}` bounds how
// long a captured, valid request stays replayable (prompts/013, Assumption 6).
const MAX_SKEW_SECONDS = 300;

export const provisionBodySchema = z.object({
  contactId: z.string().min(1),
  email: z.string().min(1),
  phone: z.string().min(1).optional(),
  firstName: z.string().min(1),
  lastName: z.string().min(1).optional(),
  products: z.array(z.enum(PRODUCT_IDS)),
});

/**
 * Timing-safe: both digests are hex-decoded to equal-length buffers before
 * `crypto.timingSafeEqual` — a length mismatch is treated as "no match", never
 * thrown past this function, so a malformed header can't leak timing either.
 */
export function verifyInternalSignature(
  rawBody: string,
  timestampHeader: string | null,
  signatureHeader: string | null,
  secret: string,
): boolean {
  if (timestampHeader === null || signatureHeader === null) return false;

  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > MAX_SKEW_SECONDS) return false;

  const expected = new Bun.CryptoHasher("sha256", secret).update(`${timestampHeader}.${rawBody}`).digest("hex");

  const expectedBuf = Buffer.from(expected, "hex");
  const actualBuf = Buffer.from(signatureHeader, "hex");
  if (expectedBuf.length !== actualBuf.length) return false;

  return timingSafeEqual(expectedBuf, actualBuf);
}

export type ProvisionServices = { provisionFromSalesforce: typeof provisionFromSalesforce };
const defaultServices: ProvisionServices = { provisionFromSalesforce };

export async function provisionRoute(
  req: Request,
  services: ProvisionServices = defaultServices,
): Promise<Response> {
  const rawBody = await req.text();

  const secret = requireLater("INTERNAL_WEBHOOK_SIGNING_SECRET");
  const signed = verifyInternalSignature(
    rawBody,
    req.headers.get("x-timestamp"),
    req.headers.get("x-signature"),
    secret,
  );
  if (!signed) {
    log.warn("internal_provision_unauthenticated", {});
    return Response.json({ error: "unauthenticated" }, { status: 401, headers: NO_STORE });
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
  }

  const body = provisionBodySchema.safeParse(parsedJson);
  if (!body.success) {
    return Response.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
  }

  try {
    const result = await services.provisionFromSalesforce(body.data);
    return Response.json({ userId: result.userId }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
    }
    throw error;
  }
}
