/**
 * GET /sign-in (src/routes/login.ts) — a static page, so this asserts the
 * response shape rather than any server logic.
 */

import { test, expect, describe } from "bun:test";
import { signInPage } from "@/routes/login";

describe("signInPage", () => {
  test("is a 200 HTML response", async () => {
    expect(signInPage.status).toBe(200);
    expect(signInPage.headers.get("content-type")).toContain("text/html");
  });

  test("is never cached — an auth page must never be stale", () => {
    expect(signInPage.headers.get("cache-control")).toBe("no-store");
  });

  test("contains Masterclass branding", async () => {
    const body = await signInPage.clone().text();
    expect(body).toContain("Masterclass");
  });

  test("calls only existing, already enumeration-safe endpoints", async () => {
    const body = await signInPage.clone().text();
    expect(body).toContain("/api/identity/resolve");
    expect(body).toContain("/api/auth/sign-in/email");
    expect(body).toContain("/api/auth/sign-in/otp/start");
    expect(body).toContain("/api/auth/sign-in/otp/verify");
  });
});
