import { expect, it, vi } from "vitest";
import fx from "./fixtures/gmail/messages.json";
import { makeGmail, parseAddresses } from "@/connectors/gmail";

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const getToken = async () => "ya29.test";

function fakeGmail(opts: { historyStatus?: number } = {}) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
    const u = new URL(String(url));
    expect(init?.method).toBe("GET");
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer ya29.test");
    calls.push(u.pathname + u.search);
    const p = u.pathname.replace("/gmail/v1/users/me", "");
    if (p === "/profile") return json(fx.profile);
    if (p === "/messages") return json(u.searchParams.get("pageToken") === "p2" ? fx.list_page2 : fx.list_page1);
    if (p === "/history") return opts.historyStatus ? json({ error: "gone" }, opts.historyStatus) : json(fx.history);
    const m = (fx.messages as Record<string, unknown>)[p.split("/").pop()!];
    return m ? json(m) : json({ error: "not found" }, 404);
  }) as unknown as typeof fetch;
  return { g: makeGmail({ fetchImpl, getToken }), calls };
}

it("backfills the window page by page, then switches to history from the pre-backfill historyId", async () => {
  const { g, calls } = fakeGmail();
  const p1 = await g.sync(null);
  expect(p1.hasMore).toBe(true);
  expect(JSON.parse(p1.nextCursor!)).toEqual({ phase: "backfill", historyId: "322000", page: "p2" });
  expect(calls.find((c) => c.startsWith("/gmail/v1/users/me/messages?"))).toMatch(/q=after%3A\d+/);

  const ana = p1.items.find((i) => i.externalId === "1a1176cd367da257")!;
  expect(ana).toMatchObject({
    kind: "email",
    threadKey: "1a1176cd367da257",
    author: "Ana Lopez",
    title: "GLS refunds",
    url: "https://mail.google.com/mail/u/0/#all/1a1176cd367da257",
    occurredAt: "2026-10-07T17:32:44.000Z",
    bodyText: "Hi,\n\nCan you check the GLS refunds?\n\nAna",
  });
  expect(ana.participants?.map((p) => p.email)).toEqual(["ana@example.com", "me@example.com", "julio@example.com", "ops@example.com"]);
  // raw keeps labels and headers, but not the base64 bodies
  const raw = ana.raw as { labelIds: string[]; payload: { headers: unknown[] } };
  expect(raw.labelIds).toEqual(["UNREAD", "INBOX"]);
  expect(JSON.stringify(raw)).not.toContain('"data"');
  // HTML-only message falls back to stripped HTML
  expect(p1.items.find((i) => i.externalId === "1a11735a50a6e917")!.bodyText).toBe("Join us tomorrow\n\nThanks & bye");

  const p2 = await g.sync(p1.nextCursor);
  expect(p2.hasMore).toBe(false);
  expect(p2.items.map((i) => i.threadKey)).toEqual(["1a1170000000aaaa"]);
  expect(JSON.parse(p2.nextCursor!)).toEqual({ phase: "history", historyId: "322000" });
});

it("incremental run re-fetches added and relabelled messages, skips drafts, caps bodies", async () => {
  const { g, calls } = fakeGmail();
  const res = await g.sync(JSON.stringify({ phase: "history", historyId: "322000" }));
  expect(calls.some((c) => c.includes("startHistoryId=322000"))).toBe(true);
  expect(res.items.map((i) => i.externalId).sort()).toEqual(["1a1176cd367da257", "1a11800000000001"]);
  expect(res.items.find((i) => i.externalId === "1a11800000000001")!.bodyText!.length).toBe(20_001);
  expect(res.hasMore).toBe(false);
  expect(JSON.parse(res.nextCursor!)).toEqual({ phase: "history", historyId: "322200" });
});

it("falls back to a full backfill when the historyId has expired", async () => {
  const { g } = fakeGmail({ historyStatus: 404 });
  const res = await g.sync(JSON.stringify({ phase: "history", historyId: "1" }));
  expect(res).toEqual({ items: [], nextCursor: null, hasMore: true });
});

it("parses address headers with quoted commas", () => {
  expect(parseAddresses('"Ruiz, Julio" <Julio@Example.com>, b@x.com, undisclosed-recipients:;')).toEqual([
    { name: "Ruiz, Julio", email: "julio@example.com" },
    { email: "b@x.com" },
  ]);
});
