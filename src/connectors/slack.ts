import { createReadOnlyClient } from "@/lib/readonly-http";
import type { Participant } from "@/db/schema";
import { backfillSince, requireEnv, type Connector, type NewItem } from "./types";

// Slack Web API with a user token (xoxp). Read-only methods only:
// auth.test, users.list, conversations.list, conversations.history, conversations.replies.
// Slack answers HTTP 200 with { ok: false, error } on failure, so every call goes through `call()`.

const WORKSPACE_URL = "https://opereit.slack.com";
/** Threads keep being re-polled for new replies until quiet this long: longer if I'm in them or it's a DM. */
const WATCH_MINE_SECONDS = 3 * 24 * 3600;
const WATCH_OTHER_SECONDS = 24 * 3600;
/** Channels with no message for this long are only checked every QUIET_RECHECK_SECONDS. */
const QUIET_AFTER_SECONDS = 7 * 24 * 3600;
const QUIET_RECHECK_SECONDS = 30 * 60;
/** Channel-level Slack errors that skip that channel instead of failing the whole sync. */
const SKIPPABLE = new Set(["channel_not_found", "not_in_channel", "is_archived", "access_denied"]);
/** Housekeeping events, not conversation. */
const SKIP_SUBTYPES = new Set([
  "channel_join", "channel_leave", "group_join", "group_leave", "channel_topic", "channel_purpose",
  "channel_name", "group_topic", "group_purpose", "group_name", "channel_archive", "channel_unarchive",
  "bot_add", "bot_remove", "pinned_item", "unpinned_item", "message_deleted", "message_changed",
  "joiner_notification", "mpdm_move", "tombstone", "channel_convert_to_public", "channel_convert_to_private",
]);

export type ChannelType = "im" | "mpim" | "channel" | "group";

type SlackUser = { id: string; name: string; deleted?: boolean; real_name?: string; profile?: { real_name?: string; display_name?: string; email?: string } };
type SlackChannel = { id: string; name?: string; is_im?: boolean; is_mpim?: boolean; is_private?: boolean; is_member?: boolean; is_archived?: boolean; user?: string };
type SlackFile = { id: string; name?: string; title?: string };
type SlackAttachment = { fallback?: string; title?: string; text?: string };
export type SlackMessage = {
  type: string;
  subtype?: string;
  ts: string;
  user?: string;
  bot_id?: string;
  username?: string;
  text?: string;
  thread_ts?: string;
  reply_count?: number;
  latest_reply?: string;
  edited?: { user: string; ts: string };
  files?: SlackFile[];
  attachments?: SlackAttachment[];
  [k: string]: unknown;
};
type Page = { response_metadata?: { next_cursor?: string } };
type HistoryResponse = Page & { messages: SlackMessage[]; has_more?: boolean };

class SlackError extends Error {
  constructor(public code: string, method: string) {
    super(`Slack ${method}: ${code}`);
  }
}

type ChannelMeta = { id: string; type: ChannelType; name: string; dmUser?: string };

/**
 * Cursor. One sync() page = history pages of one or more channels (up to `callBudget` calls),
 * persisted after every page so a crash resumes mid-cycle.
 * A cycle walks every conversation I'm in (DMs first, quiet channels only every 30 min); when the
 * queue empties, hasMore = false and the next run starts a new cycle with a fresh channel list.
 */
type Watched = { t: string; m?: 1 }; // newest reply ts seen; m = I'm in it (posted, mentioned, or a DM)
type State = {
  latest: Record<string, string>; // channelId → newest message ts ingested
  threads: Record<string, Watched>; // "channelId:thread_ts" → watched thread
  checked?: Record<string, number>; // quiet channelId → epoch seconds of last visit
  queue?: string[]; // channels still to visit this cycle; queue[0] is the current one
  page?: string; // conversations.history cursor for queue[0]
  maxTs?: string; // newest ts seen on queue[0] while paging
};

export type SlackOptions = {
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Min spacing between tier-3 calls (history/replies). Slack allows ~50/min per method. */
  paceMs?: number;
  /** API calls per sync() page. Quiet channels cost one call each, so several fit in one page. */
  callBudget?: number;
};

const TIER3 = new Set(["conversations.history", "conversations.replies"]);

export function makeSlack({ fetchImpl, now = Date.now, paceMs = 1200, callBudget = 25 }: SlackOptions = {}): Connector {
  const api = createReadOnlyClient({
    baseUrl: "https://slack.com/api/",
    headers: () => ({ authorization: `Bearer ${process.env.SLACK_USER_TOKEN}` }),
    fetchImpl,
  });

  let calls = 0;
  const nextAt = new Map<string, number>(); // Slack rate limits are per method
  async function call<T>(method: string, query: Record<string, string | number | boolean | undefined>): Promise<T> {
    if (TIER3.has(method) && paceMs > 0) {
      const wait = (nextAt.get(method) ?? 0) - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      nextAt.set(method, Date.now() + paceMs);
    }
    calls++;
    const res = await api.get<{ ok: boolean; error?: string } & T>(method, query);
    if (!res.ok) throw new SlackError(res.error ?? "unknown_error", method);
    return res;
  }

  async function paged<T>(method: string, key: string, query: Record<string, string | number | boolean>): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    do {
      const res = await call<Page & Record<string, T[]>>(method, { ...query, cursor });
      out.push(...(res[key] ?? []));
      cursor = res.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return out;
  }

  // Per-cycle caches. Reloaded at the start of each cycle, or lazily after a process restart.
  let me: string | null = null;
  let users: Map<string, SlackUser> | null = null;
  let channels: Map<string, ChannelMeta> | null = null;

  async function loadCaches(force: boolean) {
    if (force || !me) me = (await call<{ user_id: string }>("auth.test", {})).user_id;
    if (force || !users) users = new Map((await paged<SlackUser>("users.list", "members", { limit: 200 })).map((u) => [u.id, u]));
    if (force || !channels) {
      const list = await paged<SlackChannel>("conversations.list", "channels", {
        types: "public_channel,private_channel,mpim,im",
        exclude_archived: true,
        limit: 200,
      });
      channels = new Map(list.filter((c) => c.is_im || c.is_mpim || c.is_member).map((c) => [c.id, channelMeta(c, users!, me!)]));
    }
  }

  const ctx = () => ({ me: me!, users: users! });

  /** conversations.replies for one thread, excluding the parent. `oldest` = last reply already seen. */
  async function replies(ch: ChannelMeta, threadTs: string, oldest?: string): Promise<SlackMessage[]> {
    const msgs = await paged<SlackMessage>("conversations.replies", "messages", {
      channel: ch.id,
      ts: threadTs,
      limit: 200,
      ...(oldest ? { oldest, inclusive: false } : {}),
    });
    return msgs.filter((m) => m.ts !== threadTs && (!oldest || tsGt(m.ts, oldest)));
  }

  /** One history page of queue[0] (plus its thread replies). Advances the queue when the channel is done. */
  async function visit(state: State, items: NewItem[]) {
    const ch = channels!.get(state.queue![0]);
    if (!ch) return advance(state); // left or archived since the queue was built
    try {
      const oldest = state.latest[ch.id] ?? toTs(backfillSince());
      const res = await call<HistoryResponse>("conversations.history", {
        channel: ch.id,
        oldest,
        limit: 200,
        cursor: state.page,
      });
      let maxTs = state.maxTs ?? oldest;
      const polled = new Set<string>();
      for (const m of res.messages) {
        if (tsGt(m.ts, maxTs)) maxTs = m.ts;
        if (keep(m)) items.push(toItem(m, ch, ctx()));
        if (m.reply_count && m.latest_reply) {
          const key = `${ch.id}:${m.ts}`;
          const seen = state.threads[key];
          polled.add(key);
          if (seen && !tsGt(m.latest_reply, seen.t)) continue;
          const thread = (await replies(ch, m.ts, seen?.t)).filter(keep).map((r) => toItem(r, ch, ctx()));
          items.push(...thread);
          const mine = !!seen?.m || isMine(ch, [toItem(m, ch, ctx()), ...thread]);
          watch(state, key, m.latest_reply, mine, now());
        }
      }

      const next = res.response_metadata?.next_cursor;
      if (res.has_more && next) {
        state.page = next;
        state.maxTs = maxTs;
        return;
      }
      // Channel done: commit the high-water mark, then re-poll its still-active older threads.
      state.latest[ch.id] = maxTs;
      for (const [key, seen] of Object.entries(state.threads)) {
        if (!key.startsWith(`${ch.id}:`) || polled.has(key)) continue;
        const fresh = await replies(ch, key.slice(ch.id.length + 1), seen.t);
        const thread = fresh.filter(keep).map((r) => toItem(r, ch, ctx()));
        items.push(...thread);
        const last = fresh.reduce((a, r) => (tsGt(r.ts, a) ? r.ts : a), seen.t);
        watch(state, key, last, !!seen.m || isMine(ch, thread), now());
      }
      state.checked ??= {};
      if (ageSeconds(maxTs, now()) > QUIET_AFTER_SECONDS) state.checked[ch.id] = Math.floor(now() / 1000);
      else delete state.checked[ch.id];
      advance(state);
    } catch (e) {
      if (!(e instanceof SlackError && SKIPPABLE.has(e.code))) throw e;
      advance(state);
    }
  }

  return {
    source: "slack",
    label: "Slack",
    configured: () => requireEnv("SLACK_USER_TOKEN"),

    async checkAuth() {
      const r = await call<{ user: string; team: string }>("auth.test", {});
      return { ok: true, identity: `${r.user} on ${r.team}` };
    },

    async sync(cursor) {
      const state: State = cursor ? JSON.parse(cursor) : { latest: {}, threads: {} };
      for (const [k, v] of Object.entries(state.threads)) if (typeof v === "string") state.threads[k] = { t: v, m: 1 }; // older cursor: keep watching (3d)
      const newCycle = !state.queue;
      await loadCaches(newCycle);
      if (newCycle) state.queue = queueOrder([...channels!.values()].filter((c) => due(state, c.id, now())));

      calls = 0;
      const items: NewItem[] = [];
      while (state.queue!.length && calls < callBudget) await visit(state, items);

      // Watched threads in channels I've left would never be pruned otherwise.
      for (const key of Object.keys(state.threads)) if (!channels!.has(key.split(":")[0])) delete state.threads[key];
      for (const id of Object.keys(state.checked ?? {})) if (!channels!.has(id)) delete state.checked![id];

      const more = !!state.queue!.length;
      if (!more) delete state.queue;
      return { items, nextCursor: JSON.stringify(state), hasMore: more };
    },
  };
}

function advance(state: State) {
  state.queue!.shift();
  delete state.page;
  delete state.maxTs;
}

function watch(state: State, key: string, lastReply: string, mine: boolean, nowMs: number) {
  if (ageSeconds(lastReply, nowMs) <= (mine ? WATCH_MINE_SECONDS : WATCH_OTHER_SECONDS)) state.threads[key] = mine ? { t: lastReply, m: 1 } : { t: lastReply };
  else delete state.threads[key];
}

/** DMs are always "mine"; in channels, a thread is mine once I post in it or am mentioned. */
function isMine(ch: ChannelMeta, items: NewItem[]): boolean {
  if (ch.type === "im" || ch.type === "mpim") return true;
  return items.some((i) => {
    const r = i.raw as { from_me: boolean; mentions_me: boolean };
    return r.from_me || r.mentions_me;
  });
}

/** Active channels every cycle; channels quiet for a week only every QUIET_RECHECK_SECONDS. */
function due(state: State, id: string, nowMs: number): boolean {
  const last = state.checked?.[id];
  return last === undefined || nowMs / 1000 - last >= QUIET_RECHECK_SECONDS;
}

const ageSeconds = (ts: string, nowMs: number) => nowMs / 1000 - Number(ts.split(".")[0]);

/** DMs and group DMs first: they matter most and the run may hit its page limit before the end. */
function queueOrder(chs: ChannelMeta[]): string[] {
  const rank = (c: ChannelMeta) => (c.type === "im" ? 0 : c.type === "mpim" ? 1 : 2);
  return chs.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id)).map((c) => c.id);
}

export function channelMeta(c: SlackChannel, users: Map<string, SlackUser>, me?: string): ChannelMeta {
  if (c.is_im) return { id: c.id, type: "im", name: c.user ? displayName(users.get(c.user)) ?? c.user : "DM", dmUser: c.user };
  if (c.is_mpim) {
    // "mpdm-ana--bo.x--me-1" → "Ana, Bo" (display names, without me)
    const byHandle = new Map([...users.values()].map((u) => [u.name, u]));
    const handles = (c.name ?? "").replace(/^mpdm-/, "").replace(/-\d+$/, "").split("--").filter(Boolean);
    const names = handles.filter((h) => !me || byHandle.get(h)?.id !== me).map((h) => displayName(byHandle.get(h)) ?? h);
    return { id: c.id, type: "mpim", name: names.join(", ") || "group DM" };
  }
  return { id: c.id, type: c.is_private ? "group" : "channel", name: `#${c.name ?? c.id}` };
}

function keep(m: SlackMessage): boolean {
  if (m.type !== "message" || (m.subtype && SKIP_SUBTYPES.has(m.subtype))) return false;
  return !!(m.text?.trim() || m.files?.length || m.attachments?.length);
}

function displayName(u: SlackUser | undefined): string | undefined {
  if (!u) return undefined;
  return u.profile?.display_name || u.profile?.real_name || u.real_name || u.name;
}

/** Slack mrkdwn → plain text: resolve <@U…>, <#C…|name>, <url|label>, <!here>, and unescape. */
export function renderText(text: string, users: Map<string, SlackUser>): string {
  return text
    .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id: string, label?: string) => `@${displayName(users.get(id)) ?? label ?? id}`)
    .replace(/<#([CG][A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id: string, label?: string) => `#${label || id}`)
    .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g, (_, label?: string) => label ?? "@group")
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, "@$1")
    .replace(/<!date\^[^|>]*\|([^>]*)>/g, "$1")
    .replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, (_, url: string, label: string) => (label === url ? url : `${label} (${url})`))
    .replace(/<((?:https?|mailto):[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function toItem(m: SlackMessage, ch: ChannelMeta, ctx: { me: string; users: Map<string, SlackUser> }): NewItem {
  const { users } = ctx;
  const author = m.user ? users.get(m.user) : undefined;
  const authorName = displayName(author) ?? m.username ?? (m.bot_id ? "bot" : m.user) ?? null;

  const text = renderText(m.text ?? "", users);
  const extras = [
    ...(m.attachments ?? []).map((a) => [a.title, a.text ?? a.fallback].filter(Boolean).join(": ")).filter(Boolean),
    ...(m.files ?? []).map((f) => `[file: ${f.name ?? f.title ?? f.id}]`),
  ];
  const body = [text, ...extras].filter(Boolean).join("\n");
  const firstLine = body.split("\n").find((l) => l.trim()) ?? "";

  const mentioned = [...(m.text ?? "").matchAll(/<@([UW][A-Z0-9]+)/g)].map((x) => x[1]);
  const ids = [...new Set([m.user, ch.dmUser, ...mentioned].filter((x): x is string => !!x))];
  const participants: Participant[] = ids.map((id) => {
    const u = users.get(id);
    return { name: displayName(u), email: u?.profile?.email, handle: u?.name ?? id };
  });

  const threadTs = m.thread_ts ?? m.ts;
  const isReply = threadTs !== m.ts;
  const url = `${WORKSPACE_URL}/archives/${ch.id}/p${m.ts.replace(".", "")}${isReply ? `?thread_ts=${threadTs}&cid=${ch.id}` : ""}`;

  return {
    externalId: `${ch.id}:${m.ts}`,
    kind: "message",
    threadKey: `${ch.id}:${threadTs}`,
    author: authorName,
    participants,
    title: firstLine.length > 140 ? `${firstLine.slice(0, 139)}…` : firstLine || "(empty message)",
    bodyText: body || null,
    url,
    occurredAt: tsToIso(m.ts),
    updatedAt: m.edited ? tsToIso(m.edited.ts) : null,
    // The view reads channel_type / channel_name / from_me / mentions_me.
    raw: {
      ...m,
      channel: ch.id,
      channel_type: ch.type,
      channel_name: ch.name,
      from_me: m.user === ctx.me,
      mentions_me: mentioned.includes(ctx.me),
    },
  };
}

export const tsToIso = (ts: string) => new Date(Number(ts.split(".")[0]) * 1000 + Number((ts.split(".")[1] ?? "0").padEnd(6, "0").slice(0, 3))).toISOString();
const toTs = (d: Date) => `${Math.floor(d.getTime() / 1000)}.000000`;
/** Compare Slack ts strings exactly (they overflow double precision as numbers). */
const tsKey = (ts: string) => {
  const [s, f = ""] = ts.split(".");
  return `${s.padStart(12, "0")}.${f.padEnd(6, "0")}`;
};
const tsGt = (a: string, b: string) => tsKey(a) > tsKey(b);

export const slack = makeSlack();
