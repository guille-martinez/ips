import { beforeAll, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ips-test-"));
  process.env.IPS_DB_PATH = path.join(dir, "test.db");
});

it("upserts on (source, external_id) and keeps FTS in sync", async () => {
  const { getDb } = await import("@/db/client");
  const { upsertItems } = await import("@/sync/run");
  const { getFeed } = await import("@/lib/queries");
  const db = getDb();
  const base = { externalId: "m1", kind: "message" as const, occurredAt: "2026-10-01T10:00:00.000Z", raw: {} };

  upsertItems(db, "slack", [{ ...base, title: "Invoices for Ecoalf" }]);
  upsertItems(db, "slack", [{ ...base, title: "Refunds for Nude" }]);

  expect(getFeed({}).length).toBe(1);
  expect(getFeed({ q: "refund" }).map((r) => r.title)).toEqual(["Refunds for Nude"]);
  expect(getFeed({ q: "ecoalf" }).length).toBe(0);
  expect(getFeed({ q: 'weird "quotes" OR (' }).length).toBe(0); // no FTS syntax errors
});
