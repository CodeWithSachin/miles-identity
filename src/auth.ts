/**
 * The single Better Auth instance. One file, one `betterAuth()` — a second means
 * two session stores. See .agents/skills/better-auth.md.
 *
 * Better Auth reaches Postgres through Kysely, which requires a `pg` `Pool`. This
 * is the ONE place `pg` is allowed (AGENTS.md tech-stack exception). Everything WE
 * write goes through `Bun.sql` in `src/db/` — two clients, one database, by design.
 *
 * Step 3 scope: email+password only. The OAuth provider, JWT, OTP, 2FA, admin and
 * SSO plugins are later roadmap steps — do not add them here.
 */

import { betterAuth } from "better-auth";
import { Pool } from "pg";
import { getConfig } from "@/lib/config";

const config = getConfig();

/**
 * The Better Auth CLI (`bunx auth generate` / `migrate`) loads THIS config with
 * jiti under Node, which cannot resolve a top-level `import … from "bun"`. Our
 * redis wrapper pulls in `bun`, so it is reached lazily here — inside the
 * `secondaryStorage` callbacks the CLI never evaluates — while the real runtime
 * under `Bun.serve` resolves and module-caches it on first use.
 */
const getRedis = async () => (await import("@/lib/redis")).redis;

/**
 * Password hashing wired to `Bun.password` (argon2id). `verify` reads the algorithm
 * out of the hash string, so an imported bcrypt hash verifies through the same call
 * (the Django PBKDF2 branch is step 9). Exported so the wiring is unit-testable
 * without standing up the database. See .agents/skills/better-auth.md.
 */
export const passwordHasher = {
  hash: (password: string): Promise<string> => Bun.password.hash(password),
  verify: ({ password, hash }: { password: string; hash: string }): Promise<boolean> =>
    Bun.password.verify(password, hash),
};

export const auth = betterAuth({
  // The one sanctioned `pg` use: Better Auth's own tables, via Kysely.
  database: new Pool({ connectionString: config.DATABASE_URL }),
  baseURL: config.BETTER_AUTH_URL,
  secret: config.BETTER_AUTH_SECRET,

  // 2–3x on /get-session by joining session+user in one query. Kysely/pg supports it.
  experimental: { joins: true },

  emailAndPassword: {
    enabled: true,
    password: passwordHasher,
  },

  // Server-controlled extensions to the `user` row. `input: false` means a client
  // cannot set them. Declared here so the Better-Auth-owned `user` table carries
  // them from creation — a later step must never ALTER a BA table to add a column.
  // `fieldName` maps camelCase → the snake_case columns in the AGENTS.md data model.
  user: {
    additionalFields: {
      salesforceContactId: {
        type: "string",
        required: false,
        input: false,
        unique: true,
        fieldName: "salesforce_contact_id",
      },
      status: {
        type: "string",
        required: false,
        input: false,
        defaultValue: "active",
      },
      mergedIntoUserId: {
        type: "string",
        required: false,
        input: false,
        fieldName: "merged_into_user_id",
      },
    },
  },

  // Postgres stays the source of truth so revocation is deleting a row — instant.
  session: { storeSessionInDatabase: true },

  // Redis in front of the session table so page views do not each hit Postgres.
  // Keys and values are session data — never logged. See .agents/skills/better-auth.md.
  secondaryStorage: {
    get: async (key) => (await getRedis()).get(key),
    set: async (key, value, ttl) => {
      const redis = await getRedis();
      if (ttl !== undefined) await redis.set(key, value, "EX", ttl);
      else await redis.set(key, value);
    },
    delete: async (key) => {
      await (await getRedis()).del(key);
    },
  },
});
