import { afterEach, beforeEach, expect, it, vi } from "vitest";
import self from "./fixtures/attio/self.json";
import members from "./fixtures/attio/workspace_members.json";
import companies from "./fixtures/attio/companies.json";
import deals from "./fixtures/attio/deals.json";
import notes from "./fixtures/attio/notes.json";
import { makeAttio } from "@/connectors/attio";

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

// A full first page of 500 old companies, so the real fixture lands on page 2.
const filler = Array.from({ length: 500 }, (_, i) => {
  const c = clone(companies.data[1]);
  c.id.record_id = `filler-${i}`;
  return c;
});

function fakeApi(fx: { deals: typeof deals }) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
    const u = new URL(String(url));
    calls.push(`${init?.method} ${u.pathname}${u.search}`);
    expect(String((init?.headers as Record<string, string>).authorization)).toBe("Bearer attio_test");
    if (u.pathname === "/v2/self") return json(self);
    if (u.pathname === "/v2/workspace_members") return json(members);
    if (u.pathname === "/v2/notes") return json(u.searchParams.get("offset") === "0" ? notes : { data: [] });
    const m = u.pathname.match(/^\/v2\/objects\/(\w+)\/records\/query$/);
    if (m && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      if (m[1] === "companies") return json({ data: body.offset === 0 ? filler : companies.data });
      if (m[1] === "deals") return json(fx.deals);
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

async function fullPass(c: ReturnType<typeof makeAttio>, cursor: string | null) {
  const items = [];
  let pages = 0;
  for (;;) {
    const r = await c.sync(cursor);
    items.push(...r.items);
    cursor = r.nextCursor;
    pages++;
    if (!r.hasMore) return { items, cursor, pages };
  }
}

beforeEach(() => {
  process.env.ATTIO_API_KEY = "attio_test";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-08T12:00:00Z"));
});
afterEach(() => vi.useRealTimers());

it("first pass: pages companies, takes every deal, backfills notes, maps fields", async () => {
  const { fetchImpl, calls } = fakeApi({ deals });
  const { items, cursor, pages } = await fullPass(makeAttio(fetchImpl), null);

  expect(pages).toBe(4); // companies ×2, deals, notes
  expect(calls.filter((c) => c.startsWith("POST")).every((c) => c.includes("/records/query"))).toBe(true);
  expect(calls.some((c) => /PUT|PATCH|DELETE/.test(c))).toBe(false);

  // Old company (May) and old note (July) fall outside the 30-day backfill; the old lost deal is kept.
  expect(items.map((i) => i.externalId)).toEqual([
    "companies:e1d9e3eb-0fbc-48cc-9fe9-7ce99df93c47",
    "deals:216768ad-a4e4-47d1-8dd9-8c5134f18836",
    "deals:9b6fe754-8b8a-4a67-9cc9-b42c0cdf1fd0",
    "notes:28bf9296-c203-44ea-8caf-4ba4e59e7e66",
  ]);

  const [company, deal, lost, note] = items;
  // The 18:50 email interaction doesn't count as an edit; the 15:00 customer_type change does.
  expect(company.occurredAt).toBe("2026-10-07T15:00:00.000Z");
  expect(company.bodyText).toContain("Prospect · harbor.example · 1 deal");

  expect(deal.title).toBe("Harbor Logistics");
  expect(deal.author).toBe("Alex Seller");
  expect(deal.participants).toEqual([{ name: "Alex Seller", email: "alex@example.com" }]);
  expect(deal.url).toBe("https://app.attio.com/opereit/deal/216768ad-a4e4-47d1-8dd9-8c5134f18836");
  expect(deal.bodyText).toContain("Stage: Committed · Owner: Alex Seller · Company: Harbor Logistics · ACV: 5000 EUR · Expected close: 2026-10-16");
  expect((deal.raw as { ips: unknown }).ips).toMatchObject({ object: "deals", stage: "Committed", open: true, close_date: "2026-10-16", acv: 5000 });
  expect((lost.raw as { ips: { open: boolean } }).ips.open).toBe(false);
  expect(lost.bodyText).toContain("Lost reason: Wrong timing");

  expect(note.kind).toBe("note");
  expect(note.threadKey).toBe("attio:companies:e1d9e3eb-0fbc-48cc-9fe9-7ce99df93c47");
  expect(note.threadKey).toBe(company.threadKey);
  expect((note.raw as { ips: { parent_name: string } }).ips.parent_name).toBe("Harbor Logistics");

  expect(JSON.parse(cursor!)).toMatchObject({ since: "2026-10-07T16:56:37.000Z", step: 3 });
});

it("incremental pass emits only records edited since the mark", async () => {
  const first = fakeApi({ deals });
  const { cursor } = await fullPass(makeAttio(first.fetchImpl), null);

  const unchanged = await fullPass(makeAttio(fakeApi({ deals }).fetchImpl), cursor);
  expect(unchanged.items).toEqual([]);

  const edited = clone(deals);
  edited.data[1].values.stage[0].active_from = "2026-10-08T10:00:00.000000000Z";
  const changed = await fullPass(makeAttio(fakeApi({ deals: edited }).fetchImpl), unchanged.cursor);
  expect(changed.items.map((i) => i.externalId)).toEqual(["deals:9b6fe754-8b8a-4a67-9cc9-b42c0cdf1fd0"]);
  expect(changed.items[0].occurredAt).toBe("2026-10-08T10:00:00.000Z");
});

it("never moves the mark past the start of the pass", async () => {
  const future = clone(deals);
  future.data[0].values.stage[0].active_from = "2026-10-09T00:00:00.000000000Z";
  const { cursor } = await fullPass(makeAttio(fakeApi({ deals: future }).fetchImpl), null);
  expect(JSON.parse(cursor!).since).toBe("2026-10-08T11:55:00.000Z");
});

it("checkAuth reports the workspace", async () => {
  const a = makeAttio(fakeApi({ deals }).fetchImpl);
  await expect(a.checkAuth()).resolves.toMatchObject({ ok: true, identity: expect.stringContaining("workspace Opereit") });
});

it("view: tile counts open deals, pending flags open deals closing within a week", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  process.env.IPS_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ips-attio-")), "test.db");
  const { getDb } = await import("@/db/client");
  const { upsertItems } = await import("@/sync/run");
  const { attioView } = await import("@/views/attio");

  const { items } = await fullPass(makeAttio(fakeApi({ deals }).fetchImpl), null);
  upsertItems(getDb(), "attio", items);

  const tile = attioView.tile();
  expect(tile.stats.find((s) => s.label === "open deals")?.value).toBe(1);
  expect(tile.items.find((i) => i.title === "Harbor Logistics" && i.badge === "Committed")).toBeTruthy();

  expect(attioView.pending!()).toEqual([]); // closes 2026-10-16, more than a week out
  vi.setSystemTime(new Date("2026-10-12T12:00:00Z"));
  const pending = attioView.pending!();
  expect(pending.map((p) => [p.title, p.badge, p.due, p.subtitle])).toEqual([["Harbor Logistics", "Committed", "2026-10-16", "Alex Seller"]]);
});
