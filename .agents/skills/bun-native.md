# Skill: bun-native

Verified against Bun 1.3.x docs, July 2026. Read before writing any runtime, database, job, or I/O code.

**The rule:** if Bun ships it, use it. Adding a package for something on this page is a review rejection.

---

## Postgres — `Bun.sql`

Tagged template literals. Native connection pooling, transactions, prepared statements, binary protocol.

```ts
import { sql, SQL } from "bun";

// Default client reads POSTGRES_URL / DATABASE_URL from env automatically.
const rows = await sql`
  SELECT id, name FROM "user"
  WHERE status = ${"active"}
  LIMIT ${10}
`;

// Explicit client when you need a second connection (e.g. the legacy source DB).
const legacy = new SQL(Bun.env.LEGACY_DATABASE_URL!);
```

- Interpolation is **parameterised**, not string-concatenated. Injection-safe by construction.
- Identifiers cannot be parameterised. Never interpolate a table or column name from input.
- Transactions:

```ts
await sql.begin(async tx => {
  const [row] = await tx`INSERT INTO enrolment ... RETURNING id`;
  await tx`INSERT INTO outbox (aggregate, event_type, payload)
           VALUES (${"enrolment"}, ${"created"}, ${{ id: row.id }})`;
});
```

  Domain write plus outbox row in **one** transaction. This is how tuple sync stays correct.

- Do **not** hand `Bun.sql` to Better Auth. It goes through Kysely and needs a `pg` `Pool`. Two clients, one database — that is the intended shape.

## Redis — `Bun.redis`

```ts
import { redis, RedisClient } from "bun";

await redis.set("session:abc", JSON.stringify(data), "EX", 900);
const raw = await redis.get("session:abc");
```

Automatic reconnect, command timeouts, message queueing. Use it for Better Auth `secondaryStorage` and for the revoked-`sub` deny list. No ioredis.

## Passwords — `Bun.password`

The single most useful native API for this project.

```ts
// argon2id by default, PHC-encoded
const hash = await Bun.password.hash(pw);

// bcrypt when you need MCF compatibility
const bc = await Bun.password.hash(pw, { algorithm: "bcrypt", cost: 12 });

// verify AUTO-DETECTS the algorithm from the hash string
await Bun.password.verify(pw, hash); // argon2id (PHC) ✓
await Bun.password.verify(pw, bc);   // bcrypt (MCF)  ✓
```

**Why this matters for the legacy import:** `verify` reads the algorithm out of the hash, so imported **bcrypt** hashes from the Node LMS and new **argon2id** hashes both work through one call. You only need a custom branch for Django's `pbkdf2_sha256$…`, which `Bun.CryptoHasher` can compute.

Bun also SHA-512s bcrypt inputs over 72 bytes instead of silently truncating — safer than most bcrypt libraries.

Never add `bcrypt`, `bcryptjs`, `argon2`, or `@node-rs/argon2`.

## HTTP server — `Bun.serve` with native routes

```ts
const server = Bun.serve({
  port: config.PORT,
  routes: {
    "/health": new Response("ok"),
    "/ready": async () => (await checkDeps()) ? new Response("ok") : new Response("degraded", { status: 503 }),
    "/api/identity/resolve": { POST: resolveHandler },
    "/api/auth/*": req => auth.handler(req),   // Better Auth catch-all
  },
  error(e) { return new Response("Internal Error", { status: 500 }); },
});
```

Static `Response` objects in `routes` are served without invoking a handler. Params via `/x/:id`, wildcards via `*`. No Express, Hono or Elysia — they add a layer with no feature we need.

## Scheduled jobs — `Bun.cron`

```ts
// in-process: shares the DB pool, no daemon, works everywhere
Bun.cron("*/15 * * * *", async () => { await reconcileTuples(); });
```

- **No-overlap guarantee:** the next fire is computed only after the handler's promise settles. A 20-minute reconciliation on a 15-minute schedule will not stack. This is exactly what we want for the OpenFGA reconciliation job.
- Schedules are **UTC** for in-process jobs. Run the process with `TZ=UTC` so nothing is ambiguous.
- Errors surface as `unhandledRejection`; register a listener or the process exits. The job itself keeps running.
- Under `bun --hot`, jobs are stopped and re-registered on save — no leaked timers.
- OS-level form (`Bun.cron(path, schedule, title)`) is **not** supported in Windows containers, and uses local time. For our deployment, use in-process only.

No node-cron, croner, BullMQ or Agenda.

## Cookies — `Bun.Cookie` / `Bun.CookieMap`

Native parse and serialise. `req.cookies` on `Bun.serve` requests. No `cookie` or `cookie-parser`.

## CSRF — `Bun.CSRF`

Native token generate and verify. Use it on the login and consent forms. No csurf.

## Secrets — `Bun.secrets`

OS-keychain-backed credential storage for local development. Production secrets still come from the deploy environment into validated config.

## Env vars

Bun loads `.env`, `.env.local`, `.env.<NODE_ENV>` automatically. Read via `Bun.env`.

**Read them in exactly one place** — `lib/config.ts` — validate with zod, export typed. Never `Bun.env.FOO` anywhere else. No dotenv.

## IDs — `Bun.randomUUIDv7()`

Time-ordered UUIDs. Better index locality than v4 for our insert-heavy tables. Prefix them: `usr_`, `vnd_`, `mrg_`. No uuid or nanoid.

## Hashing — `Bun.CryptoHasher`

```ts
// Django PBKDF2 verification for the legacy import
const [algo, iterations, salt, expected] = djangoHash.split("$");
```

Supports sha256/512, sha3, blake2b, HMAC mode via `new Bun.CryptoHasher("sha256", key)`. Note HMAC instances are single-use after `digest()`. No crypto-js.

`Bun.hash.*` (wyhash, xxHash3, crc32…) is **non-cryptographic** — fine for cache keys and shard selection, never for anything security-bearing.

## Tests — `bun test`

Jest-compatible API, TypeScript native, no config.

```ts
import { test, expect, mock, spyOn, beforeEach } from "bun:test";
```

Coverage thresholds live in `bunfig.toml`. `bun test --watch` while developing. No Jest, Vitest, sinon.

Caveat: in-process `Bun.cron` is anchored to the real clock — `setSystemTime` and fake timers do not move it. Test the job's handler function directly, not the schedule.

## Shell — `Bun.$`

```ts
import { $ } from "bun";
const out = await $`pg_dump --schema-only ${dbUrl}`.text();
```

No execa, shelljs, zx.

## Files, globs, streams

`Bun.file(path)`, `Bun.write(path, data)`, `new Bun.Glob("**/*.sql").scan()`. No fs-extra, glob, fast-glob.

## Config formats

Bun natively imports and parses YAML, TOML, JSON5 and JSONL. The OpenFGA model can live in a YAML file imported directly. No yaml, js-yaml, toml packages.

## Build

```bash
bun build src/index.ts --target=bun --outdir=dist --minify --sourcemap
bun build src/index.ts --compile --outfile=dist/miles-identity   # single binary
```

No tsup, esbuild, webpack, tsx, ts-node.

## Package management

- `bun install`, `bun add`, `bun remove`, `bun update`
- `bun audit` — advisory scan, part of `bun run check`
- `bun outdated`, `bun why <pkg>` before adding anything
- `linker = "isolated"` in bunfig — strict isolation, catches phantom dependencies
- `bun.lock` is text and committed; lockfile diffs are reviewable

## Observability

`Bun.serve` exposes built-in metrics — use those before reaching for an APM agent.

---

## TypeScript 7 note

TypeScript is on **7.x**, which **no longer auto-discovers `@types` packages.** `tsconfig.json` must contain:

```json
{ "compilerOptions": { "types": ["bun"] } }
```

Without it, `Bun` is an unknown global and every native API above fails to typecheck. If you see "Cannot find name 'Bun'", this is why — do not work around it with `declare global` or `any`.
