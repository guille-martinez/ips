import { expect, it, vi } from "vitest";
import fx from "./fixtures/calendar/events.json";
import { makeCalendar } from "@/connectors/calendar";

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

function fakeCalendar(opts: { gone?: boolean } = {}) {
  const calls: URL[] = [];
  const fetchImpl = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
    const u = new URL(String(url));
    expect(init?.method).toBe("GET");
    calls.push(u);
    if (u.pathname === "/calendar/v3/calendars/primary") return json(fx.calendar);
    const sp = u.searchParams;
    if (sp.get("syncToken")) return opts.gone ? json({ error: "gone" }, 410) : json(fx.incremental);
    return json(sp.get("pageToken") === "pg2" ? fx.page2 : fx.page1);
  }) as unknown as typeof fetch;
  return { c: makeCalendar({ fetchImpl, getToken: async () => "t" }), calls };
}

it("first run pages from timeMin, skips declined and working-location events, then stores the sync token", async () => {
  const { c, calls } = fakeCalendar();
  const p1 = await c.sync(null);
  expect(calls[0].searchParams.get("singleEvents")).toBe("true");
  expect(calls[0].searchParams.get("timeMin")).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  // bounded window, or weekly series expand for decades
  const windowEnd = calls[0].searchParams.get("timeMax")!;
  expect(Date.parse(windowEnd) - Date.now()).toBeGreaterThan(59 * 86_400_000);
  expect(p1.hasMore).toBe(true);
  expect(p1.items).toHaveLength(1);
  expect(p1.items[0]).toMatchObject({
    externalId: "48omasscsqki1o40f9c9k4uos3_20261007T180000Z",
    threadKey: "48omasscsqki1o40f9c9k4uos3_20261007T180000Z",
    kind: "event",
    title: "Weekly: GM & PC",
    author: "pablo@example.com",
    occurredAt: "2026-10-07T20:00:00+02:00",
    url: "https://www.google.com/calendar/event?eid=abc",
    bodyText: "02.05.03 GM & PC\nAgenda",
  });
  expect(p1.items[0].participants?.map((p) => p.email)).toEqual(["me@example.com", "pablo@example.com"]);
  expect((p1.items[0].raw as { end: { dateTime: string } }).end.dateTime).toBe("2026-10-07T20:45:00+02:00");

  const p2 = await c.sync(p1.nextCursor);
  expect(calls[1].searchParams.get("pageToken")).toBe("pg2");
  expect(calls[1].searchParams.get("timeMax")).toBe(windowEnd);
  expect(p2.items.map((i) => [i.externalId, i.occurredAt])).toEqual([
    ["4d61imufq55mnks6vfcv32nknh", "2026-10-08T08:30:00+02:00"],
    ["allday1", "2026-10-12"],
  ]);
  expect(p2.hasMore).toBe(false);
  expect(JSON.parse(p2.nextCursor!)).toEqual({ windowEnd, syncToken: "sync1" });
});

const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

it("incremental run uses the sync token without a window and skips cancelled events", async () => {
  const { c, calls } = fakeCalendar();
  const windowEnd = inDays(58);
  const res = await c.sync(JSON.stringify({ windowEnd, syncToken: "sync1" }));
  expect(calls[0].searchParams.get("timeMin")).toBeNull();
  expect(calls[0].searchParams.get("timeMax")).toBeNull();
  expect(res.items.map((i) => i.externalId)).toEqual(["new1"]);
  expect(res.items[0].participants).toEqual([{ name: "Bo", email: "bo@example.com" }]);
  expect(JSON.parse(res.nextCursor!)).toEqual({ windowEnd, syncToken: "sync2" });
});

it("drops the token and redoes the full sync once the window is a week old", async () => {
  const { c, calls } = fakeCalendar();
  await c.sync(JSON.stringify({ windowEnd: inDays(52), syncToken: "sync1" }));
  expect(calls[0].searchParams.get("syncToken")).toBeNull();
  expect(Date.parse(calls[0].searchParams.get("timeMax")!) - Date.now()).toBeGreaterThan(59 * 86_400_000);
});

it("resyncs from scratch on 410 Gone", async () => {
  const { c } = fakeCalendar({ gone: true });
  expect(await c.sync(JSON.stringify({ windowEnd: inDays(58), syncToken: "old" }))).toEqual({ items: [], nextCursor: null, hasMore: true });
});

it("checkAuth returns the primary calendar", async () => {
  const { c } = fakeCalendar();
  expect(await c.checkAuth()).toEqual({ ok: true, identity: "me@example.com (Europe/Madrid)" });
});
