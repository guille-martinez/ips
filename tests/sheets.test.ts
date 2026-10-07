import { beforeEach, expect, it, vi } from "vitest";
import fx from "./fixtures/sheets/values.json";
import { makeSheets, parseDate, rowsToItems } from "@/connectors/sheets";

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });

beforeEach(() => {
  process.env.SUPERBRAIN_SHEET_ID = "sheet123";
  process.env.SUPERBRAIN_TABS = "Daily prios,Readings";
});

function fakeSheets() {
  const ranges: string[] = [];
  const fetchImpl = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
    const u = new URL(String(url));
    expect(init?.method).toBe("GET");
    const m = u.pathname.match(/\/values\/(.+)$/);
    if (!m) return json(fx.meta);
    const tab = decodeURIComponent(m[1]).replace(/^'|'$/g, "");
    ranges.push(tab);
    return json((fx as Record<string, unknown>)[tab]);
  }) as unknown as typeof fetch;
  return { s: makeSheets({ fetchImpl, getToken: async () => "t" }), ranges };
}

it("snapshots only the allow-listed tabs into the shape the view reads", async () => {
  const { s, ranges } = fakeSheets();
  const res = await s.sync(null);
  expect(ranges).toEqual(["Daily prios", "Readings"]);
  expect(res).toMatchObject({ nextCursor: null, hasMore: false });
  const byId = Object.fromEntries(res.items.map((i) => [i.externalId, i]));
  expect(Object.keys(byId)).toEqual(["Daily prios:T1", "Daily prios:T2", "Daily prios:T2#5", "Daily prios:row6", "Readings:Shape Up", "Readings:Untitled status"]);
  expect(byId["Daily prios:T1"]).toMatchObject({
    kind: "record",
    title: "Refile Amphora DHL claims",
    author: "Me",
    url: "https://example.com/doc",
    occurredAt: "2026-10-09",
    raw: { tab: "Daily prios", status: "WIP", deadline: "2026-10-09", owner: "Me", link: "https://example.com/doc" },
  });
  expect(byId["Daily prios:T2"].url).toBe("https://docs.google.com/spreadsheets/d/sheet123/edit");
  expect(byId["Readings:Shape Up"]).toMatchObject({ title: "Shape Up", url: "https://basecamp.com/shapeup", raw: { tab: "Readings", status: "Pending" } });
  expect(byId["Readings:Untitled status"].raw).toEqual({ tab: "Readings", status: null });
});

it("refuses to read a passwords tab even if it is listed", async () => {
  process.env.SUPERBRAIN_TABS = "Daily prios,Passwords";
  const { s, ranges } = fakeSheets();
  await expect(s.sync(null)).rejects.toThrow(/not allow-listed/);
  expect(ranges).not.toContain("Passwords");
});

it("checkAuth reads tab titles only and reports missing tabs", async () => {
  const { s } = fakeSheets();
  expect(await s.checkAuth()).toEqual({ ok: true, identity: '"Superbrain", tabs Daily prios, Readings' });
  process.env.SUPERBRAIN_TABS = "Daily prios,Backlog";
  expect(await s.checkAuth()).toEqual({ ok: false, error: '"Superbrain" has no tab named Backlog' });
});

it("parses the sheet's D/M/YY dates", () => {
  expect(parseDate("9/10/26")).toBe("2026-10-09");
  expect(parseDate("31/1/2027")).toBe("2027-01-31");
  expect(parseDate("2026-10-09")).toBe("2026-10-09");
  expect(parseDate("13/13/26")).toBeNull();
  expect(parseDate("soon")).toBeNull();
  expect(rowsToItems("Daily prios", [], "x")).toEqual([]);
});
