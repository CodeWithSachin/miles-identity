/**
 * The only file that constructs an `OpenFgaClient` for check/write calls at
 * runtime (AGENTS.md: "only authz/ talks to OpenFGA"). `push-model.ts` builds
 * its own separate, minimal client — see its own comment for why.
 *
 * Construction is lazy (inside the function body, never at module load) so
 * importing this file cannot crash a process that hasn't configured
 * FGA_API_URL/FGA_STORE_ID/FGA_MODEL_ID/FGA_API_TOKEN yet — same reasoning as
 * the lazy `getProvisionVendorUser` import in `src/auth.ts`.
 */

import { CredentialsMethod, OpenFgaClient } from "@openfga/sdk";
import { requireLater } from "@/lib/config";
import { log } from "@/lib/logger";

let cached: OpenFgaClient | undefined;

export function getFgaClient(): OpenFgaClient {
  cached ??= new OpenFgaClient({
    apiUrl: requireLater("FGA_API_URL"),
    storeId: requireLater("FGA_STORE_ID"),
    authorizationModelId: requireLater("FGA_MODEL_ID"),
    credentials: {
      method: CredentialsMethod.ApiToken,
      config: { token: requireLater("FGA_API_TOKEN") },
    },
  });
  return cached;
}

/**
 * `boolean` is the graph's real answer; `null` means OpenFGA could not be
 * reached or errored. Never throws — the only two callers of this function
 * (the shadow job) must be able to tell "the graph disagrees" apart from "the
 * graph didn't answer", and must never treat the latter as agreement
 * (security.md: deny by default, alert on unreachable — applied here to a
 * shadow-only decision, since nothing in this task enforces the graph yet).
 */
export async function checkRelation(user: string, relation: string, object: string): Promise<boolean | null> {
  try {
    const { allowed } = await getFgaClient().check({ user, relation, object });
    return allowed ?? null;
  } catch (error) {
    log.warn("fga_check_failed", { user, relation, object, reason: error instanceof Error ? error.name : "unknown" });
    return null;
  }
}
