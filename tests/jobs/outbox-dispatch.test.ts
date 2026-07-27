/**
 * The `applyEvent` dispatcher in `src/jobs/outbox-dispatch.ts` routes an
 * outbox row by `aggregate` to the right applier (`authz/tuples.ts` for
 * `vendor_access`, `integrations/salesforce.ts` for `salesforce_contact_link`,
 * prompts/013) or logs and skips an unknown one. Mocks both true externals
 * (OpenFGA, Salesforce) via `mock.module` — deliberately testing
 * `outbox-dispatch.ts` rather than `outbox-worker.ts` itself, since importing
 * the latter would also fire its top-level `Bun.cron(...)` registration
 * (testing-and-checks.md: `Bun.cron` itself is not unit-testable).
 */

import { test, expect, describe, mock, spyOn, afterAll } from "bun:test";
import type { OutboxRow } from "@/db/types";
import { log } from "@/lib/logger";

const applyOutboxEvent = mock(async () => {});
const applySalesforceContactLinkEvent = mock(async () => {});

mock.module("@/authz/client", () => ({ getFgaClient: () => ({}) }));
mock.module("@/authz/tuples", () => ({ applyOutboxEvent }));
mock.module("@/integrations/salesforce", () => ({ applySalesforceContactLinkEvent }));

const { applyEvent } = await import("@/jobs/outbox-dispatch");

afterAll(() => {
  mock.restore();
});

function row(overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: 1n,
    aggregate: "vendor_access",
    event_type: "granted",
    payload: {},
    attempts: 0,
    last_error: null,
    created_at: new Date(),
    processed_at: null,
    ...overrides,
  };
}

describe("applyEvent", () => {
  test("routes a vendor_access row to applyOutboxEvent", async () => {
    applyOutboxEvent.mockClear();
    await applyEvent(row({ aggregate: "vendor_access" }));
    expect(applyOutboxEvent).toHaveBeenCalledTimes(1);
    expect(applySalesforceContactLinkEvent).not.toHaveBeenCalled();
  });

  test("routes a salesforce_contact_link row to applySalesforceContactLinkEvent", async () => {
    applyOutboxEvent.mockClear();
    applySalesforceContactLinkEvent.mockClear();
    await applyEvent(row({ aggregate: "salesforce_contact_link" }));
    expect(applySalesforceContactLinkEvent).toHaveBeenCalledTimes(1);
    expect(applyOutboxEvent).not.toHaveBeenCalled();
  });

  test("an unknown aggregate logs a warning and does not throw", async () => {
    applyOutboxEvent.mockClear();
    applySalesforceContactLinkEvent.mockClear();
    const warn = spyOn(log, "warn").mockImplementation(() => {});

    await expect(applyEvent(row({ aggregate: "something_new" }))).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith("outbox_unknown_aggregate", { id: "1", aggregate: "something_new" });
    expect(applyOutboxEvent).not.toHaveBeenCalled();
    expect(applySalesforceContactLinkEvent).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
