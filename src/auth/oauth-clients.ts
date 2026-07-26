/**
 * The four trusted first-party OAuth clients. Pure data — no DB, no Better Auth
 * import — so both `seed-oauth-clients.ts` (which writes these into the
 * `oauthClient` table) and its test can use the exact same definitions.
 *
 * There is no `trustedClients` option on `@better-auth/oauth-provider` (checked
 * against the installed 1.6.25 source) — clients are just rows in `oauthClient`,
 * written here by an explicit sync script rather than the plugin's own
 * session-gated `/oauth2/create-client` endpoint. See .agents/skills/better-auth.md
 * and the roadmap-step-6 plan for why.
 */

import { requireLater } from "@/lib/config";

export type TrustedClientDefinition = {
  clientId: string;
  type: "web" | "native";
  redirectUris: string[];
  /** Undefined for public (native) clients — they hold no secret. */
  clientSecret: string | undefined;
};

function splitUrls(value: string): string[] {
  return value.split(",").map((u) => u.trim());
}

export function trustedClients(): TrustedClientDefinition[] {
  return [
    {
      clientId: "lms-web",
      type: "web",
      redirectUris: splitUrls(requireLater("LMS_WEB_REDIRECT_URLS")),
      clientSecret: requireLater("LMS_WEB_CLIENT_SECRET"),
    },
    {
      clientId: "masterclass-web",
      type: "web",
      redirectUris: splitUrls(requireLater("MASTERCLASS_WEB_REDIRECT_URLS")),
      clientSecret: requireLater("MASTERCLASS_WEB_CLIENT_SECRET"),
    },
    {
      clientId: "miles-one-app",
      type: "native",
      redirectUris: [requireLater("MILES_ONE_APP_REDIRECT_URL")],
      clientSecret: undefined,
    },
    {
      clientId: "masterclass-app",
      type: "native",
      redirectUris: [requireLater("MASTERCLASS_APP_REDIRECT_URL")],
      clientSecret: undefined,
    },
  ];
}
