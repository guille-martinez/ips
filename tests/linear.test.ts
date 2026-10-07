import { expect, it, vi } from "vitest";
import fx from "./fixtures/linear/issues.json";
import { makeLinear } from "@/connectors/linear";

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });

type Call = { query: string; variables: { filter?: { updatedAt: Record<string, string> }; first?: number } };

function setup(respond: (c: Call) => unknown) {
  process.env.LINEAR_API_KEY = "lin_api_test";
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
    expect(String(url)).toBe("https://api.linear.app/graphql");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).authorization).toBe("lin_api_test");
    const c = JSON.parse(String(init?.body)) as Call;
    expect(c.query).not.toMatch(/\bmutation\b/);
    calls.push(c);
    return json(respond(c));
  }) as unknown as typeof fetch;
  return { l: makeLinear(fetchImpl), calls };
}

it("checkAuth returns who I am", async () => {
  const { l } = setup(() => fx.viewer);
  expect(await l.checkAuth()).toEqual({ ok: true, identity: "me@example.com on workspace Acme" });
});

it("first run backfills, pages by updatedAt floor, then advances the high-water mark", async () => {
  const { l, calls } = setup((c) => (c.variables.filter?.updatedAt.lte ? fx.page2 : fx.page1));

  const p1 = await l.sync(null);
  expect(p1.hasMore).toBe(true);
  expect(calls[0].variables.filter?.updatedAt.lte).toBeUndefined();
  const since = calls[0].variables.filter!.updatedAt.gt;
  expect(Date.now() - Date.parse(since)).toBeGreaterThan(29 * 86_400_000); // ~30-day backfill

  const [a, b] = p1.items;
  expect(a).toMatchObject({
    externalId: "f8049a49-0000-4000-8000-000000000246",
    kind: "issue",
    title: "DEP-246 Set up meeting with carrier AM to get credentials",
    author: "Colleague",
    threadKey: "DEP-246",
    url: "https://linear.app/acme/issue/DEP-246/set-up-meeting-with-carrier-am-to-get-credentials",
    occurredAt: "2026-10-07T11:10:54.037Z",
    updatedAt: "2026-10-07T15:53:53.850Z",
  });
  expect(a.participants?.map((p) => p.email)).toEqual(["me@example.com", "colleague@example.com"]);
  expect(a.raw).toMatchObject({ state: { type: "started" }, assignee: { isMe: true }, identifier: "DEP-246" });
  expect(b.participants).toHaveLength(1); // assignee == creator, deduped
  expect(b.bodyText).toBeNull();

  // Page 2 asks for issues at or below the oldest updatedAt from page 1, same lower bound.
  const p2 = await l.sync(p1.nextCursor);
  expect(calls[1].variables.filter?.updatedAt).toEqual({ gt: since, lte: "2026-10-07T07:16:24.383Z" });
  expect(p2.hasMore).toBe(false);
  expect(p2.items[0]).toMatchObject({ threadKey: "DEP-198", author: null, participants: [] });
  expect(JSON.parse(p2.nextCursor!)).toEqual({ since: "2026-10-07T15:53:53.850Z" });
});

it("incremental run only asks for issues updated after the cursor", async () => {
  const { l, calls } = setup(() => fx.empty);
  const r = await l.sync(JSON.stringify({ since: "2026-10-07T15:53:53.850Z" }));
  expect(calls[0].variables).toEqual({ filter: { updatedAt: { gt: "2026-10-07T15:53:53.850Z" } }, first: 100 });
  expect(r).toEqual({ items: [], nextCursor: JSON.stringify({ since: "2026-10-07T15:53:53.850Z" }), hasMore: false });
});

it("switches to a strict floor when a full page shares the same updatedAt", async () => {
  const floor = "2026-10-07T07:16:24.383Z";
  const tie = { ...fx.page1.data.issues.nodes[1], updatedAt: floor };
  const { l, calls } = setup(() => ({ data: { issues: { pageInfo: { hasNextPage: true }, nodes: [tie] } } }));
  const r = await l.sync(JSON.stringify({ since: "2026-10-01T00:00:00Z", floor, maxSeen: "2026-10-07T15:53:53.850Z" }));
  expect(JSON.parse(r.nextCursor!)).toMatchObject({ floor, strict: true });
  await l.sync(r.nextCursor);
  expect(calls[1].variables.filter?.updatedAt).toEqual({ gt: "2026-10-01T00:00:00Z", lt: floor });
});
