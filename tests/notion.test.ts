import { beforeAll, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fx from "./fixtures/notion/api.json";
import { makeNotion } from "@/connectors/notion";

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
const STRATEGY = "11111111-1111-4111-8111-111111111111";

beforeAll(() => {
  // backfillSince() and the view's 30-day window are relative to now: pin the clock (Date only).
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-07T12:00:00.000Z"));
  process.env.IPS_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ips-test-")), "test.db");
});

function fakeNotion() {
  process.env.NOTION_TOKEN = "secret_test";
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = [];
  const fetchImpl = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
    const u = new URL(String(url));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method ?? "GET", path: u.pathname, body });
    expect(new Headers(init?.headers).get("notion-version")).toBeTruthy();
    if (u.pathname === "/v1/search") {
      expect(init?.method).toBe("POST");
      return json(body.start_cursor === "c2" ? fx.search_page2 : fx.search_page1);
    }
    expect(init?.method).toBe("GET");
    if (u.pathname === "/v1/users") return json(fx.users);
    if (u.pathname === "/v1/users/me") return json(fx.me);
    if (u.pathname === `/v1/blocks/${STRATEGY}/children`) return json(fx.blocks_strategy);
    if (u.pathname.startsWith("/v1/blocks/")) return json({ object: "list", results: [], has_more: false, next_cursor: null });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { n: makeNotion(fetchImpl), calls };
}

it("checkAuth reports the integration and workspace", async () => {
  const { n } = fakeNotion();
  expect(await n.checkAuth()).toEqual({ ok: true, identity: "integration IPS on workspace Example" });
});

it("first run pages through search, skips databases and trashed pages, maps blocks and to-dos", async () => {
  const { n, calls } = fakeNotion();
  const p1 = await n.sync(null);
  expect(p1.hasMore).toBe(true);
  expect(p1.items.map((i) => i.externalId)).toEqual([STRATEGY]);
  expect(calls[0].body).toMatchObject({ filter: { property: "object", value: "page" }, sort: { timestamp: "last_edited_time", direction: "descending" } });

  const it0 = p1.items[0];
  expect(it0.kind).toBe("page");
  expect(it0.title).toBe("Strategy Weekly #15");
  expect(it0.author).toBe("Ana");
  expect(it0.occurredAt).toBe("2026-10-02T16:41:00.000Z");
  expect(it0.url).toContain("notion.so");
  expect(it0.participants?.map((p) => p.email)).toEqual(["me@example.com", "ana@example.com"]);
  expect(it0.bodyText).toBe(
    [
      "Strategy Weekly #15",
      "## Action items for next week",
      "[ ] @Me Review the Slack thread on use cases",
      "[x] @Ana Share login",
      "---",
      "## Ops Input",
      "- Next 2 weeks, most focus on Claims",
    ].join("\n"),
  );
  expect((it0.raw as { _open_todos: unknown })._open_todos).toEqual([
    { text: "@Me Review the Slack thread on use cases", mentions: ["me@example.com"] },
  ]);
  expect(calls.some((c) => c.path.includes("33333333"))).toBe(false); // trashed: no block fetch

  // Page 2 contains a page older than the backfill window: stop there even though has_more is true.
  const p2 = await n.sync(p1.nextCursor);
  expect(p2.hasMore).toBe(false);
  expect(p2.items.map((i) => [i.externalId, i.title, i.author])).toEqual([["55555555-5555-4555-8555-555555555555", "(untitled page)", null]]);
  expect(p2.items[0].participants).toEqual([{ handle: "u-ghost" }]); // bots dropped, unknown users kept by id
  expect(JSON.parse(p2.nextCursor!)).toEqual({ since: "2026-10-02T16:41:00.000Z" });
  expect(calls.filter((c) => c.path === "/v1/users")).toHaveLength(1); // cached across pages
});

it("incremental run stops at the high-water mark and re-reads pages edited in the same minute", async () => {
  const { n, calls } = fakeNotion();
  const r = await n.sync(JSON.stringify({ since: "2026-10-02T16:41:00.000Z" }));
  expect(r.hasMore).toBe(false);
  expect(r.items.map((i) => i.externalId)).toEqual([STRATEGY]); // same-minute boundary is re-upserted
  expect(JSON.parse(r.nextCursor!)).toEqual({ since: "2026-10-02T16:41:00.000Z" });
  expect(calls.filter((c) => c.path === "/v1/search")).toHaveLength(1);

  const { n: n2 } = fakeNotion();
  const none = await n2.sync(JSON.stringify({ since: "2026-10-03T00:00:00.000Z" }));
  expect(none.items).toEqual([]);
  expect(none.hasMore).toBe(false);
  expect(JSON.parse(none.nextCursor!)).toEqual({ since: "2026-10-03T00:00:00.000Z" });
});

it("view: Pending lists pages with open to-dos that mention me", async () => {
  const { getDb } = await import("@/db/client");
  const { upsertItems } = await import("@/sync/run");
  const { notionView } = await import("@/views/notion");
  const { n } = fakeNotion();
  upsertItems(getDb(), "notion", (await n.sync(null)).items);

  delete process.env.NOTION_ME_EMAIL;
  expect(notionView.pending!()).toEqual([]);
  expect(notionView.tile().items.map((i) => i.title)).toEqual(["Strategy Weekly #15"]);

  process.env.NOTION_ME_EMAIL = "Me@Example.com";
  expect(notionView.pending!().map((i) => [i.title, i.badge])).toEqual([["Strategy Weekly #15", "1 to-do"]]);
  expect(notionView.tile().stats).toEqual([
    { label: "edited 7d", value: 1 },
    { label: "pages w/ my to-dos", value: 1 },
  ]);
  process.env.NOTION_ME_EMAIL = "ana@example.com"; // Ana's to-do is checked
  expect(notionView.pending!()).toEqual([]);
});
