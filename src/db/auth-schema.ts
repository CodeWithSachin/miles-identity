/**
 * Better Auth schema tooling.
 *
 * Run under Bun — NOT `bunx auth generate/migrate`. That CLI loads the config with
 * jiti under Node, in a context with no `Bun` global, so it cannot evaluate a
 * Bun-native config (`getConfig()` reads `Bun.env`; the runtime uses `Bun.password`
 * and `Bun.redis`). `getMigrations()` is the same routine the CLI runs internally,
 * called here from Bun where every native API is available.
 *
 *   bun run auth:schema    → compile the schema SQL to better-auth-schema.sql (review it)
 *   bun run auth:migrate   → apply Better Auth's tables to DATABASE_URL
 *
 * Better Auth OWNS user/session/account/verification. Our own tables are migrated
 * separately by `src/db/migrate.ts`. The two paths never overlap. See
 * .agents/skills/better-auth.md and .agents/skills/postgres-migrations.md.
 */

import { getMigrations } from "better-auth/db/migration";
import { auth } from "@/auth";

const SCHEMA_FILE = new URL("./better-auth-schema.sql", import.meta.url).pathname;

const { compileMigrations, runMigrations } = await getMigrations(auth.options);

if (Bun.argv.includes("--apply")) {
  await runMigrations();
  console.log("[auth] Better Auth schema applied to the database");
} else {
  const ddl = await compileMigrations();
  await Bun.write(SCHEMA_FILE, ddl);
  console.log(`[auth] wrote ${SCHEMA_FILE} — review before applying with: bun run auth:migrate`);
}
