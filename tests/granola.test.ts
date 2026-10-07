import { expect, it, vi } from "vitest";
import fx from "./fixtures/granola/notes.json";
import { makeGranola } from "@/connectors/granola";

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });

it("pages through notes, skips deleted ones and advances the high-water mark", async () => {
  process.env.GRANOLA_API_KEY = "grn_test";
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
    const u = new URL(String(url));
    expect(init?.method).toBe("GET");
    calls.push(u.pathname + u.search);
    if (u.pathname === "/v1/notes") return json(u.searchParams.get("cursor") === "c2" ? fx.list_page2 : fx.list_page1);
    return json({ ...fx.note, id: u.pathname.split("/").pop() });
  }) as unknown as typeof fetch;

  const g = makeGranola(fetchImpl);
  const p1 = await g.sync(null);
  expect(p1.hasMore).toBe(true);
  expect(p1.items.map((i) => i.externalId)).toEqual(["not_aaa"]);
  const it0 = p1.items[0];
  expect(it0.threadKey).toBe("evt123");
  expect(it0.participants?.map((p) => p.email)).toEqual(["ana@example.com", "bo@example.com"]);
  expect(it0.bodyText).toContain("follow up with Bo");

  const p2 = await g.sync(p1.nextCursor);
  expect(p2.hasMore).toBe(false);
  expect(JSON.parse(p2.nextCursor!)).toEqual({ since: "2026-10-03T11:00:00Z" });
  expect(calls.some((c) => c.includes("/v1/notes/not_del"))).toBe(false);
});
