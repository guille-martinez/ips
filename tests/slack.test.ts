import { expect, it, vi } from "vitest";
import fx from "./fixtures/slack/api.json";
import { makeSlack, renderText, tsToIso } from "@/connectors/slack";
import type { NewItem } from "@/connectors/types";

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
const NOW = 1791310000_000; // ~3h after the fixture messages

type Route = (q: URLSearchParams) => unknown;

function fakeSlack(routes: Record<string, Route>) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
    const u = new URL(String(url));
    expect(init?.method).toBe("GET");
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer xoxp-test");
    const method = u.pathname.replace("/api/", "");
    calls.push(`${method}?${u.searchParams}`);
    const route = routes[method];
    if (!route) throw new Error(`unexpected call ${method}`);
    return json(route(u.searchParams));
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const base: Record<string, Route> = {
  "auth.test": () => fx.auth_test,
  "users.list": () => fx.users_list,
  "conversations.list": (q) => (q.get("cursor") === "list2" ? fx.conversations_list_page2 : fx.conversations_list_page1),
};

async function drain(s: ReturnType<typeof makeSlack>, cursor: string | null) {
  const items: NewItem[] = [];
  let pages = 0;
  for (;;) {
    const r = await s.sync(cursor);
    items.push(...r.items);
    cursor = r.nextCursor;
    pages++;
    if (!r.hasMore) return { items, cursor, pages };
  }
}

it("backfills every conversation I'm in, paginates history, follows threads, then syncs incrementally", async () => {
  process.env.SLACK_USER_TOKEN = "xoxp-test";
  let run = 1;
  const { fetchImpl, calls } = fakeSlack({
    ...base,
    "conversations.history": (q) => {
      const ch = q.get("channel");
      if (ch === "C0GONE") return fx.not_in_channel;
      if (run === 1) {
        if (ch === "D0ANA") return q.get("cursor") === "im2" ? fx.history_im_page2 : fx.history_im_page1;
        if (ch === "G0MP") return fx.history_mpim;
        if (ch === "C0GEN") return fx.history_general;
      }
      if (ch === "D0ANA") {
        expect(q.get("oldest")).toBe("1791300200.000200");
        return fx.history_im_new;
      }
      return fx.empty_history;
    },
    "conversations.replies": (q) => {
      expect(q.get("ts")).toBe("1791300400.000400");
      if (run === 1) return fx.replies_general;
      expect(q.get("oldest")).toBe("1791300450.000450");
      return fx.replies_general_new;
    },
  });

  const s = makeSlack(fetchImpl, () => NOW);
  const r1 = await drain(s, null);

  // DMs first; #random (not a member) never visited; C0GONE skipped on not_in_channel.
  expect(calls.some((c) => c.includes("C0NOTME"))).toBe(false);
  expect(r1.pages).toBe(5);
  expect(r1.items.map((i) => i.externalId)).toEqual([
    "D0ANA:1791300200.000200",
    "D0ANA:1791300100.000100",
    "G0MP:1791300300.000300",
    "C0GEN:1791300400.000400",
    "C0GEN:1791300450.000450",
  ]);

  const [ask, mine, file, parent, reply] = r1.items;
  expect(ask.title).toBe("Can you check the invoice (https://example.com/inv/42) & reply?");
  expect(ask.author).toBe("Ana");
  expect(ask.threadKey).toBe("D0ANA:1791300200.000200");
  expect(ask.url).toBe("https://opereit.slack.com/archives/D0ANA/p1791300200000200");
  expect(ask.occurredAt).toBe(tsToIso("1791300200.000200"));
  expect(ask.participants?.map((p) => p.email)).toEqual(["ana@example.com"]);
  expect(ask.raw).toMatchObject({ channel: "D0ANA", channel_type: "im", channel_name: "Ana", from_me: false, mentions_me: false });

  expect(mine.raw).toMatchObject({ from_me: true });
  expect(mine.updatedAt).toBe(tsToIso("1791300150.000000"));

  expect(file.bodyText).toBe("[file: report.pdf]");
  expect(file.raw).toMatchObject({ channel_type: "mpim", channel_name: "ana, bo, me" });

  expect(parent.title).toBe("@Me deploy plan for #general?");
  expect(parent.raw).toMatchObject({ channel_type: "channel", channel_name: "#general", mentions_me: true });
  expect(parent.participants?.map((p) => p.handle)).toEqual(["ana", "me"]);
  expect(reply.threadKey).toBe("C0GEN:1791300400.000400");
  expect(reply.url).toBe("https://opereit.slack.com/archives/C0GEN/p1791300450000450?thread_ts=1791300400.000400&cid=C0GEN");

  const state1 = JSON.parse(r1.cursor!);
  expect(state1.queue).toBeUndefined();
  expect(state1.latest).toEqual({ D0ANA: "1791300200.000200", G0MP: "1791300300.000300", C0GEN: "1791300500.000500" });
  expect(state1.threads).toEqual({ "C0GEN:1791300400.000400": "1791300450.000450" });

  // Second run: new DM message, plus a new reply on a thread whose parent is older than the high-water mark.
  run = 2;
  const r2 = await drain(s, r1.cursor);
  expect(r2.items.map((i) => i.externalId)).toEqual(["D0ANA:1791308000.000800", "C0GEN:1791309000.000900"]);
  expect(JSON.parse(r2.cursor!).threads).toEqual({ "C0GEN:1791300400.000400": "1791309000.000900" });
});

it("stops watching a thread once it has been quiet for 3 days", async () => {
  process.env.SLACK_USER_TOKEN = "xoxp-test";
  const { fetchImpl, calls } = fakeSlack({
    ...base,
    "conversations.history": () => fx.empty_history,
    "conversations.replies": () => fx.replies_general,
  });
  const cursor = JSON.stringify({ latest: {}, threads: { "C0GEN:1791300400.000400": "1791300450.000450" } });
  const r = await drain(makeSlack(fetchImpl, () => NOW + 4 * 86_400_000), cursor);
  expect(calls.filter((c) => c.startsWith("conversations.replies")).length).toBe(1);
  expect(JSON.parse(r.cursor!).threads).toEqual({});
});

it("surfaces auth errors instead of skipping", async () => {
  process.env.SLACK_USER_TOKEN = "xoxp-test";
  const { fetchImpl } = fakeSlack({ ...base, "auth.test": () => fx.invalid_auth });
  await expect(makeSlack(fetchImpl).sync(null)).rejects.toThrow("invalid_auth");
  await expect(makeSlack(fetchImpl).checkAuth()).rejects.toThrow("invalid_auth");
});

it("checkAuth reports who I am", async () => {
  process.env.SLACK_USER_TOKEN = "xoxp-test";
  const { fetchImpl } = fakeSlack(base);
  expect(await makeSlack(fetchImpl).checkAuth()).toEqual({ ok: true, identity: "me on Example" });
});

it("renders Slack mrkdwn to plain text", () => {
  const users = new Map([["UANA", { id: "UANA", name: "ana", profile: { display_name: "Ana" } }]]);
  expect(renderText("hi <@UANA> <@UZZZ|zed> <!here> <!subteam^S1|@ops> <http://x.io> 1 &lt; 2", users)).toBe(
    "hi @Ana @zed @here @ops http://x.io 1 < 2",
  );
});

it("view: Pending shows unanswered DMs and mentions, one per conversation", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  process.env.IPS_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ips-slack-")), "test.db");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  try {
    const { getDb } = await import("@/db/client");
    const { upsertItems } = await import("@/sync/run");
    const { slackView } = await import("@/views/slack");
    const { toItem } = await import("@/connectors/slack");
    const users = new Map(fx.users_list.members.map((u) => [u.id, u]));
    const ctx = { me: "UME", users };
    const im = { id: "D0ANA", type: "im" as const, name: "Ana", dmUser: "UANA" };
    const mp = { id: "G0MP", type: "mpim" as const, name: "ana, bo, me" };
    const gen = { id: "C0GEN", type: "channel" as const, name: "#general" };
    upsertItems(getDb(), "slack", [
      toItem(fx.history_im_page1.messages[0], im, ctx), // Ana asks…
      toItem({ ...fx.history_im_page2.messages[0], ts: "1791300250.000000" }, im, ctx), // …I answer
      toItem(fx.history_im_new.messages[0], im, ctx), // Ana again → pending
      toItem(fx.history_mpim.messages[0], mp, ctx), // group DM, unanswered → pending
      toItem(fx.history_general.messages[1], gen, ctx), // mention…
      toItem(fx.replies_general_new.messages[1], gen, ctx), // …answered in thread
    ]);
    expect(slackView.pending!().map((p) => [p.title, p.badge])).toEqual([
      ["thanks!", "DM Ana"],
      ["[file: report.pdf]", "DM ana, bo, me"],
    ]);
    expect(slackView.tile().stats).toEqual([
      { label: "DMs 24h", value: 4 },
      { label: "msgs 24h", value: 6 },
      { label: "mentions 24h", value: 1 },
    ]);
  } finally {
    vi.useRealTimers();
  }
});
