/**
 * The ONLY place `Bun.env` is read. Everything else imports from here.
 *
 * Three tiers:
 *   1 required now      — the process refuses to start without them
 *   2 required later    — validated if present; `requireLater()` throws a named
 *                         ConfigError if read while unset, so a feature fails at
 *                         wiring time rather than silently at 02:00
 *   3 everything else   — ignored, never passed through
 *
 * Custom messages use `.refine(fn, { message })` rather than schema-level error
 * options, because refine's signature is stable across zod majors.
 */

import { z } from "zod";
import { ConfigError } from "./errors";

// ── helpers ───────────────────────────────────────────────────────────────────

const nonEmpty = z.string().min(0);

const httpUrl = nonEmpty.refine((v) => /^https?:\/\//.test(v), {
	message: "must be an http(s) URL",
});

// ── tier 1: required now ──────────────────────────────────────────────────────

const tier1 = {
	NODE_ENV: z.enum(["development", "test", "production"]),

	PORT: z.coerce
		.number()
		.int()
		.refine((v) => v >= 1 && v <= 65535, {
			message: "must be a port between 1 and 65535",
		})
		.default(3000),

	// Bun.cron in-process schedules are UTC. A process on any other zone silently
	// shifts every scheduled job — cheap to catch here, expensive to find later.
	TZ: nonEmpty.refine((v) => v === "UTC", {
		message:
			'must be "UTC" — Bun.cron in-process schedules are UTC, so a non-UTC process clock shifts every scheduled job',
	}),

	BASE_URL: httpUrl,

	DATABASE_URL: nonEmpty.refine((v) => /^postgres(ql)?:\/\//.test(v), {
		message: "must be a postgres:// or postgresql:// URL",
	}),

	REDIS_URL: nonEmpty.refine((v) => /^rediss?:\/\//.test(v), {
		message: "must be a redis:// or rediss:// URL",
	}),

	BETTER_AUTH_SECRET: nonEmpty.refine((v) => v.length >= 32, {
		message:
			"must be at least 32 characters (generate with: openssl rand -base64 32)",
	}),

	BETTER_AUTH_URL: httpUrl,
} as const;

// ── tier 2: optional now, validated if present ────────────────────────────────

const tier2 = {
	// Security rule is 5–15 minutes. The library default is 3600s, so the cap is
	// enforced in the schema — exceeding it is made unrepresentable, not commented.
	ACCESS_TOKEN_TTL_SECONDS: z.coerce
		.number()
		.int()
		.refine((v) => v >= 60 && v <= 900, {
			message:
				"must be between 60 and 900 seconds (security rule: 5–15 minute access tokens)",
		})
		.default(900),

	PHONE_PLACEHOLDER_DOMAIN: nonEmpty
		.refine((v) => v !== "temp.better-auth.com", {
			message:
				"must not be the Better Auth placeholder domain temp.better-auth.com",
		})
		.default("phone.miles.com"),

	EMAIL_FROM: nonEmpty.refine((v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v), {
		message: "must be an email address",
	}),

	LEGACY_LMS_DATABASE_URL: nonEmpty,
	LEGACY_MILES_ONE_DATABASE_URL: nonEmpty,
	LEGACY_MASTERCLASS_DATABASE_URL: nonEmpty,

	LMS_WEB_CLIENT_SECRET: nonEmpty,
	MASTERCLASS_WEB_CLIENT_SECRET: nonEmpty,
	LMS_WEB_REDIRECT_URLS: nonEmpty.refine(
		(v) => v.split(",").every((u) => /^https?:\/\//.test(u.trim())),
		{ message: "must be a comma-separated list of http(s) URLs" },
	),
	MASTERCLASS_WEB_REDIRECT_URLS: nonEmpty.refine(
		(v) => v.split(",").every((u) => /^https?:\/\//.test(u.trim())),
		{ message: "must be a comma-separated list of http(s) URLs" },
	),
	MILES_ONE_APP_REDIRECT_URL: nonEmpty,
	MASTERCLASS_APP_REDIRECT_URL: nonEmpty,

	FGA_API_URL: httpUrl,
	FGA_STORE_ID: nonEmpty,
	FGA_MODEL_ID: nonEmpty,
	FGA_API_TOKEN: nonEmpty,

	EMAIL_PROVIDER_API_KEY: nonEmpty,

	SMS_PROVIDER: z.enum(["gupshup", "msg91", "twilio"]),
	SMS_PROVIDER_API_KEY: nonEmpty,
	SMS_SENDER_ID: nonEmpty,

	// Sign-in OTP becomes a fixed code and the email/SMS gateway is never called —
	// lets a dev box test sign-in without a working provider. Security rule 14: a
	// dev auth shortcut must be unrepresentable in production, so this is rejected
	// below, not merely discouraged, whenever NODE_ENV=production.
	DEV_OTP_BYPASS: z.enum(["true", "false"]).transform((v) => v === "true").default(false),

	SALESFORCE_INSTANCE_URL: httpUrl,
	SALESFORCE_CLIENT_ID: nonEmpty,
	SALESFORCE_CLIENT_SECRET: nonEmpty,
	INTERNAL_WEBHOOK_SIGNING_SECRET: nonEmpty.refine((v) => v.length >= 32, {
		message: "must be at least 32 characters",
	}),

	GOOGLE_CLIENT_ID: nonEmpty,
	GOOGLE_CLIENT_SECRET: nonEmpty,
} as const;

const schema = z
	.object({
		...tier1,
		...z.object(tier2).partial().shape,
	})
	// The one cross-field rule in this schema: a dev-only auth shortcut must be
	// unrepresentable in production, not merely discouraged (security rule 14).
	.refine((data) => !(data.DEV_OTP_BYPASS && data.NODE_ENV === "production"), {
		message: "must not be enabled when NODE_ENV=production",
		path: ["DEV_OTP_BYPASS"],
	});

export type Config = z.infer<typeof schema>;
export type Tier2Key = keyof typeof tier2;

/** Keys whose *values* must never appear in a log line or an error message. */
const SCHEMA_KEYS: readonly string[] = [
	...Object.keys(tier1),
	...Object.keys(tier2),
];

export type RawEnv = Record<string, string | undefined>;

// ── scrubbing ─────────────────────────────────────────────────────────────────

/**
 * Remove any configured value from a string before it is logged or printed.
 *
 * Belt and braces: the messages above are written not to echo input, but a zod
 * upgrade could start including received values in a built-in message. This makes
 * "a secret leaked through a validation error" structurally impossible rather
 * than merely unlikely.
 *
 * Values shorter than 4 characters are skipped — they would over-match.
 */
export function scrubValues(text: string, env: RawEnv): string {
	let out = text;
	for (const key of SCHEMA_KEYS) {
		const value = env[key];
		if (typeof value === "string" && value.length >= 4) {
			out = out.split(value).join("[redacted]");
		}
	}
	return out;
}

// ── parsing ───────────────────────────────────────────────────────────────────

export type ParseResult =
	| { ok: true; value: Config }
	| { ok: false; issues: readonly z.core.$ZodIssue[] };

/** Pure. Does not read `Bun.env`, does not log, does not exit. */
export function parseConfig(env: RawEnv): ParseResult {
	const result = schema.safeParse(env);
	return result.success
		? { ok: true, value: result.data }
		: { ok: false, issues: result.error.issues };
}

/** Pure. `KEY — reason`, scrubbed of every configured value. */
export function formatIssues(
	issues: readonly z.core.$ZodIssue[],
	env: RawEnv,
): string[] {
	return issues.map((issue) => {
		const key = issue.path.length > 0 ? issue.path.join(".") : "(root)";
		const reason =
			issue.code === "invalid_type" ? "is required" : issue.message;
		return scrubValues(`${key} — ${reason}`, env);
	});
}

/** Failing key names only, for a ConfigError. Never values. */
export function failingKeys(issues: readonly z.core.$ZodIssue[]): string[] {
	return [
		...new Set(
			issues.map((i) => (i.path.length > 0 ? String(i.path[0]) : "(root)")),
		),
	];
}

/** Throws ConfigError on invalid config. Used by tests and by loadConfigOrExit. */
export function loadConfig(env: RawEnv): Config {
	const result = parseConfig(env);
	if (result.ok) return Object.freeze(result.value);
	throw new ConfigError(
		`invalid configuration:\n  ${formatIssues(result.issues, env).join("\n  ")}`,
		failingKeys(result.issues),
	);
}

// ── process-level access ──────────────────────────────────────────────────────

let cached: Config | undefined;

/**
 * Print the failing keys and reasons, then exit 1.
 * A config error is not recoverable and must not be caught and retried.
 */
export function loadConfigOrExit(env: RawEnv = Bun.env): Config {
	try {
		cached = loadConfig(env);
		return cached;
	} catch (error) {
		if (error instanceof ConfigError) {
			// Deliberately console.error, not the logger: the logger is fine, but this
			// must be readable in a crash-loop log with no JSON tooling to hand.
			console.error(`[config] ${error.message}`);
			process.exit(1);
		}
		throw error;
	}
}

/** Memoised config. Loads from `Bun.env` on first call. */
export function getConfig(): Config {
	cached ??= loadConfig(Bun.env);
	return cached;
}

/** Test-only: drop the memo so a suite can load a different environment. */
export function resetConfigCache(): void {
	cached = undefined;
}

/**
 * Read a tier-2 key, throwing a named ConfigError if it is unset.
 * Lets a later feature fail loudly at wiring time instead of passing `undefined`
 * into an SMS gateway at 02:00.
 */
export function requireLater<K extends Tier2Key>(
	key: K,
): NonNullable<Config[K]> {
	const value = getConfig()[key];
	if (value === undefined || value === null || value === "") {
		throw new ConfigError(
			`${String(key)} is required for this feature but is not set`,
			[String(key)],
		);
	}
	return value as NonNullable<Config[K]>;
}

/**
 * Non-secret values only. Safe for the boot log line.
 *
 * Field names deliberately avoid the logger's redaction denylist — a field called
 * `configuredKeys` gets redacted on the way out because the denylist matches "key"
 * as a substring. Hence `configuredCount`.
 */
export function redactedSummary(): {
	nodeEnv: Config["NODE_ENV"];
	port: number;
	tz: string;
	baseUrl: string;
	configuredCount: number;
} {
	const c = getConfig();
	return {
		nodeEnv: c.NODE_ENV,
		port: c.PORT,
		tz: c.TZ,
		baseUrl: c.BASE_URL,
		// A count, not the names — enough to spot "why is tier 2 empty in prod".
		configuredCount: SCHEMA_KEYS.filter(
			(k) => Bun.env[k] !== undefined && Bun.env[k] !== "",
		).length,
	};
}
