/**
 * Salesforce provisioning on Lead conversion — roadmap step 12 (prompts/013).
 * Business logic only (AGENTS.md: services/ = logic, no Request/Response); HTTP
 * shaping and signature verification live in `src/routes/internal/provision.ts`.
 *
 * "Resolve-or-create" (prompts/013, Assumption 2, confirmed on plan approval):
 * a first-time `contactId` whose email is already claimed by an existing
 * identity — any verification state — resolves to that identity's owner and
 * attaches `salesforce_contact_id` there, instead of creating a second user.
 * This is not a login-time auto-link (security.md takeover path 3 is about an
 * authentication event silently establishing a session) — nothing here
 * authenticates anyone; it only attaches non-authenticating metadata and
 * grants additional coarse, `NORMAL`-only product access, which is the whole
 * point of the alias-identity model (one verified-or-unverified handle = one
 * person).
 *
 * Idempotent on `contactId` (postgres-migrations.md: "idempotency key on
 * contactId so retried callouts don't duplicate"): a repeat callout for a
 * `contactId` already linked to a user re-runs the (already idempotent)
 * identity/access/outbox writes rather than creating a second user.
 *
 * Collaborators are injected (same DI shape as `src/services/vendor-sso.ts`).
 * `createUser` goes through Better Auth's `internalAdapter`, the same
 * mechanism `src/services/legacy-import.ts` uses to set an `input:false`
 * additional field (`salesforceContactId`, `status`) server-side — that write
 * is NOT part of the `Bun.sql` transaction below (a second connection pool
 * entirely; same accepted window as `legacy-import.ts`'s `createUser`
 * followed by `createAccount`/`createVerifiedIdentity`).
 */

import { sql, type SQL } from "bun";
import { normaliseEmail, normalisePhone } from "@/identity/normalise";
import {
  createUnverifiedIdentity as dbCreateUnverifiedIdentity,
  findUserIdByAnyHandle as dbFindUserIdByAnyHandle,
  findUserIdBySalesforceContactId as dbFindUserIdBySalesforceContactId,
  identityValueExists as dbIdentityValueExists,
  insertSalesforceContactLinkOutboxRow as dbInsertSalesforceContactLinkOutboxRow,
  linkSalesforceContactId as dbLinkSalesforceContactId,
} from "@/db/identity";
import { grantAccess as dbGrantAccess } from "@/db/access";
import type { ProductId } from "@/db/types";
import { ValidationError } from "@/lib/errors";
import { log } from "@/lib/logger";

/** The Better-Auth-owned system actor for a Salesforce-driven grant — no `user` row initiates it. */
const SYSTEM_ACTOR = "system:salesforce-provisioning";

export type ProvisionFromSalesforceInput = {
  contactId: string;
  email: string;
  phone?: string | undefined;
  firstName: string;
  lastName?: string | undefined;
  products: ProductId[];
};

async function defaultCreateUser(input: {
  email: string;
  name: string;
  salesforceContactId: string;
}): Promise<{ id: string }> {
  const { auth } = await import("@/auth");
  const ctx = await auth.$context;
  return ctx.internalAdapter.createUser({
    email: input.email,
    name: input.name,
    salesforceContactId: input.salesforceContactId,
    status: "invited",
  });
}

export type ProvisionFromSalesforceDeps = {
  findUserIdBySalesforceContactId: typeof dbFindUserIdBySalesforceContactId;
  identityValueExists: typeof dbIdentityValueExists;
  findUserIdByAnyHandle: typeof dbFindUserIdByAnyHandle;
  linkSalesforceContactId: typeof dbLinkSalesforceContactId;
  createUser: (input: { email: string; name: string; salesforceContactId: string }) => Promise<{ id: string }>;
  createUnverifiedIdentity: typeof dbCreateUnverifiedIdentity;
  grantAccess: typeof dbGrantAccess;
  insertSalesforceContactLinkOutboxRow: typeof dbInsertSalesforceContactLinkOutboxRow;
  sql: SQL;
};

const defaultDeps: ProvisionFromSalesforceDeps = {
  findUserIdBySalesforceContactId: dbFindUserIdBySalesforceContactId,
  identityValueExists: dbIdentityValueExists,
  findUserIdByAnyHandle: dbFindUserIdByAnyHandle,
  linkSalesforceContactId: dbLinkSalesforceContactId,
  createUser: defaultCreateUser,
  createUnverifiedIdentity: dbCreateUnverifiedIdentity,
  grantAccess: dbGrantAccess,
  insertSalesforceContactLinkOutboxRow: dbInsertSalesforceContactLinkOutboxRow,
  sql,
};

function displayName(input: { firstName: string; lastName?: string | undefined }, email: string): string {
  const joined = `${input.firstName} ${input.lastName ?? ""}`.trim();
  return joined.length > 0 ? joined : email;
}

/**
 * Resolves (idempotent replay or existing-email match) or creates the `usr_`
 * user this Salesforce contact provisions, attaches unverified identities and
 * `NORMAL`-only product access, and queues the back-reference sync.
 *
 * `role` is hardcoded to `NORMAL` in every grant below — the input type has no
 * role field at all, so there is no path from a Salesforce-supplied value to
 * ADMIN or VENDOR access (AGENTS.md/security.md: "Admin and Vendor users never
 * come from Salesforce").
 */
export async function provisionFromSalesforce(
  input: ProvisionFromSalesforceInput,
  deps: ProvisionFromSalesforceDeps = defaultDeps,
): Promise<{ userId: string }> {
  const email = normaliseEmail(input.email);

  let userId = await deps.findUserIdBySalesforceContactId(input.contactId);

  if (userId === null) {
    if (await deps.identityValueExists("email", email)) {
      const existing = await deps.findUserIdByAnyHandle("email", email);
      if (existing === null) {
        throw new ValidationError(`email is claimed but no owning user was found for contact ${input.contactId}`);
      }
      const linked = await deps.linkSalesforceContactId(existing, input.contactId);
      if (!linked) {
        // findUserIdBySalesforceContactId above already returned null for this
        // contactId, so a failed link here means `existing` already carries a
        // DIFFERENT contact id — a real data conflict, never silently overwritten.
        throw new ValidationError(`user ${existing} is already linked to a different Salesforce contact`);
      }
      userId = existing;
    } else {
      const created = await deps.createUser({
        email,
        name: displayName(input, email),
        salesforceContactId: input.contactId,
      });
      userId = created.id;
    }
  }

  const resolvedUserId = userId;
  const phone = input.phone ? normalisePhone(input.phone) : null;

  await deps.sql.begin(async (tx) => {
    await deps.createUnverifiedIdentity({ userId: resolvedUserId, type: "email", value: email, source: "salesforce" }, tx);
    if (phone !== null) {
      await deps.createUnverifiedIdentity({ userId: resolvedUserId, type: "phone", value: phone, source: "salesforce" }, tx);
    }
    for (const productId of input.products) {
      await deps.grantAccess(
        { userId: resolvedUserId, productId, role: "NORMAL", vendorId: null, grantedBy: SYSTEM_ACTOR },
        tx,
      );
    }
    await deps.insertSalesforceContactLinkOutboxRow({ contactId: input.contactId, userId: resolvedUserId }, tx);
  });

  log.info("salesforce_user_provisioned", { userId: resolvedUserId, contactId: input.contactId });

  return { userId: resolvedUserId };
}
