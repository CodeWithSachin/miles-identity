/**
 * POST /api/admin/access — grant or revoke a `user_product_access` row
 * (AGENTS.md roadmap step 8; .agents/skills/security.md).
 *
 * Every `/api/admin/*` handler performs its own explicit authorization check —
 * there is no middleware and no implicit default (security.md). The check lives
 * in `src/services/access.ts` and is scoped to the target `product_id`: an ADMIN
 * for one product cannot grant or revoke access on another.
 *
 * ponytail: role-check only, no 2FA gate here — the Better Auth `twoFactor`
 * plugin isn't mounted yet (later roadmap step). Add the 2FA requirement for
 * ADMIN/VENDOR_ADMIN callers once it lands.
 */

import { z } from "zod";
import { auth } from "@/auth";
import { PRODUCT_IDS, ROLES } from "@/db/types";
import { grantProductAccess, revokeProductAccess } from "@/services/access";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";

const NO_STORE = { "cache-control": "no-store" } as const;

const grantSchema = z.object({
  action: z.literal("grant"),
  user_id: z.string().min(1),
  product_id: z.enum(PRODUCT_IDS),
  role: z.enum(ROLES),
  vendor_id: z.string().min(1).optional(),
});

const revokeSchema = z.object({
  action: z.literal("revoke"),
  user_id: z.string().min(1),
  product_id: z.enum(PRODUCT_IDS),
  role: z.enum(ROLES),
});

// Exported: the same objects the Scalar spec derives from (src/routes/docs.ts) —
// one definition, not a parallel one. See .agents/skills/scalar-api-docs.md.
export const bodySchema = z.discriminatedUnion("action", [grantSchema, revokeSchema]);

export const responseSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  product_id: z.enum(PRODUCT_IDS),
  role: z.enum(ROLES),
  vendor_id: z.string().nullable(),
  status: z.enum(["active", "revoked"]),
  granted_by: z.string().nullable(),
  granted_at: z.string(),
  revoked_at: z.string().nullable(),
});

/** A session lookup, injectable so route tests don't need a live Better Auth session store. */
export type SessionResolver = (req: Request) => Promise<{ userId: string } | null>;

const defaultSessionResolver: SessionResolver = async req => {
  const session = await auth.api.getSession({ headers: req.headers });
  return session ? { userId: session.user.id } : null;
};

/** Injectable so route tests exercise status-code mapping without a live database. */
export type AccessServices = {
  grantProductAccess: typeof grantProductAccess;
  revokeProductAccess: typeof revokeProductAccess;
};

const defaultServices: AccessServices = { grantProductAccess, revokeProductAccess };

export async function adminAccessRoute(
  req: Request,
  getSession: SessionResolver = defaultSessionResolver,
  services: AccessServices = defaultServices,
): Promise<Response> {
  const session = await getSession(req);
  if (!session) {
    return Response.json({ error: "unauthenticated" }, { status: 401, headers: NO_STORE });
  }

  const body = bodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return Response.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
  }

  const actorUserId = session.userId;
  const { action, user_id, product_id, role } = body.data;

  try {
    const row =
      action === "grant"
        ? await services.grantProductAccess(actorUserId, {
            userId: user_id,
            productId: product_id,
            role,
            vendorId: body.data.vendor_id,
          })
        : await services.revokeProductAccess(actorUserId, { userId: user_id, productId: product_id, role });

    return Response.json(
      responseSchema.parse({
        id: row.id,
        user_id: row.user_id,
        product_id: row.product_id,
        role: row.role,
        vendor_id: row.vendor_id,
        status: row.status,
        granted_by: row.granted_by,
        granted_at: row.granted_at.toISOString(),
        revoked_at: row.revoked_at ? row.revoked_at.toISOString() : null,
      }),
      { headers: NO_STORE },
    );
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return Response.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
    }
    if (error instanceof NotFoundError) {
      return Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
    }
    if (error instanceof ValidationError) {
      return Response.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
    }
    throw error;
  }
}
