/**
 * `bun run fga:model` — compiles `model.fga` (the reviewed DSL, source of
 * truth per prompts/012 Assumption 2) to JSON via `@openfga/syntax-
 * transformer` and pushes it as a new authorization model version to
 * `FGA_STORE_ID`.
 *
 * Builds its own client rather than reusing `authz/client.ts#getFgaClient()`:
 * that function requires `FGA_MODEL_ID`, which doesn't exist until this
 * script's own call returns one — reusing it here would be circular.
 *
 * `FGA_STORE_ID` itself is assumed to already exist (prompts/012, Assumption
 * 3) — creating the store is a one-time ops action, out of scope here.
 */

import { CredentialsMethod, OpenFgaClient } from "@openfga/sdk";
import { transformer } from "@openfga/syntax-transformer";
import { requireLater } from "@/lib/config";

const MODEL_PATH = new URL("./model.fga", import.meta.url);

async function main(): Promise<void> {
  const dsl = await Bun.file(MODEL_PATH).text();
  const model = transformer.transformDSLToJSONObject(dsl);

  const client = new OpenFgaClient({
    apiUrl: requireLater("FGA_API_URL"),
    storeId: requireLater("FGA_STORE_ID"),
    credentials: {
      method: CredentialsMethod.ApiToken,
      config: { token: requireLater("FGA_API_TOKEN") },
    },
  });

  const { authorization_model_id } = await client.writeAuthorizationModel(model);

  // Deliberately console.log, not the structured logger — same reasoning as
  // loadConfigOrExit's crash line: must be readable with no JSON tooling to
  // hand, and this is a one-off operator script, not a running service.
  console.log(`Pushed new OpenFGA authorization model: ${authorization_model_id}`);
  console.log("Set FGA_MODEL_ID to this value.");
}

await main();
