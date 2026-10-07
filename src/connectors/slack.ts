import { createReadOnlyClient } from "@/lib/readonly-http";
import type { Participant } from "@/db/schema";
import { backfillSince, requireEnv, type Connector, type NewItem } from "./types";

// Slack Web API with a user token (xoxp). Read-only methods only:
// auth.test, users.list, conversations.list, conversations.history, conversations.replies.
// Slack answers HTTP 200 with { ok: false, error } on failure, so every call goes through `call()`.

const WORKSPACE_URL = "https://opereit.slack.com";
/** Threads keep being re-polled for new replies until they've been quiet this long. */
const THREAD_WATCH_SECONDS = 3 * 24 * 3600;
/** Channel-level Slack errors that skip that channel instead of failing the whole sync. */
const SKIPPABLE = new Set(["channel_not_found", "not_in_channel", "is_archived", "access_denied"]);
/** Housekeeping events, not conversation. */
const SKIP_SUBTYPES = new Set([
  "channel_join", "channel_leave", "group_join", "group_leave", "channel_topic", "channel_purpose",
  "channel_name", "group_topic", "group_purpose", "group_name", "channel_archive", "channel_unarchive",
  "bot_add", "bot_remove", "pinned_item", "unpinned_item", "message_deleted", "message_changed",
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
 * Cursor. One sync() page = one page of one channel's history, so a crash resumes mid-cycle.
 * A cycle walks every conversation I'm in (DMs first); when the queue empties, hasMore = false
 * and the next run starts a new cycle with a fresh channel list.
 */
type State = {
  latest: Record<string, string>; // channelId → newest message ts ingested
  threads: Record<string, string>; // "channelId:thread_ts" → newest reply ts seen (watched threads)
  queue?: string[]; // channels still to visit this cycle; queue[0] is the current one
  page?: string; // conversations.history cursor for queue[0]
  maxTs?: string; // newest ts seen on queue[0] while paging
};

export function makeSlack(fetchImpl?: typeof fetch, now: () => number = Date.now): Connector {
  const api = createReadOnlyClient({
    baseUrl: "https://slack.com/api/",
    headers: () => ({ authorization: `Bearer ${process.env.SLACK_USER_TOKEN}` }),
    fetchImpl,
  });

  async function call<T>(method: string, query: Record<string, string | number | boolean | undefined>): Promise<T> {
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
      channels = new Map(list.filter((c) => c.is_im || c.is_mpim || c.is_member).map((c) => [c.id, channelMeta(c, users!)]));
    }
  }

  const ctx = () => ({ me: me!, users: users!, now: now() });

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
      const newCycle = !state.queue;
      await loadCaches(newCycle);
      if (newCycle) state.queue = queueOrder([...channels!.values()]);

      const items: NewItem[] = [];
      const chId = state.queue![0];
      const ch = chId ? channels!.get(chId) : undefined;

      if (ch) {
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
              if (seen && !tsGt(m.latest_reply, seen)) continue;
              for (const r of await replies(ch, m.ts, seen)) if (keep(r)) items.push(toItem(r, ch, ctx()));
              watch(state, key, m.latest_reply, now());
            }
          }

          const next = res.response_metadata?.next_cursor;
          if (res.has_more && next) {
            state.page = next;
            state.maxTs = maxTs;
          } else {
            // Channel done: commit the high-water mark, then re-poll its still-active older threads.
            state.latest[ch.id] = maxTs;
            for (const [key, seen] of Object.entries(state.threads)) {
              if (!key.startsWith(`${ch.id}:`) || polled.has(key)) continue;
              const threadTs = key.slice(ch.id.length + 1);
              const fresh = await replies(ch, threadTs, seen);
              for (const r of fresh) if (keep(r)) items.push(toItem(r, ch, ctx()));
              watch(state, key, fresh.reduce((a, r) => (tsGt(r.ts, a) ? r.ts : a), seen), now());
            }
            advance(state);
          }
        } catch (e) {
          if (!(e instanceof SlackError && SKIPPABLE.has(e.code))) throw e;
          advance(state);
        }
      } else if (chId) {
        advance(state); // left or archived since the queue was built
      }

      // Watched threads in channels I've left would never be pruned otherwise.
      for (const key of Object.keys(state.threads)) if (!channels!.has(key.split(":")[0])) delete state.threads[key];

      const more = !!state.queue?.length;
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

function watch(state: State, key: string, lastReply: string, nowMs: number) {
  if (Number(lastReply.split(".")[0]) * 1000 >= nowMs - THREAD_WATCH_SECONDS * 1000) state.threads[key] = lastReply;
  else delete state.threads[key];
}

/** DMs and group DMs first: they matter most and the run may hit its page limit before the end. */
function queueOrder(chs: ChannelMeta[]): string[] {
  const rank = (c: ChannelMeta) => (c.type === "im" ? 0 : c.type === "mpim" ? 1 : 2);
  return chs.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id)).map((c) => c.id);
}

export function channelMeta(c: SlackChannel, users: Map<string, SlackUser>): ChannelMeta {
  if (c.is_im) return { id: c.id, type: "im", name: c.user ? displayName(users.get(c.user)) ?? c.user : "DM", dmUser: c.user };
  if (c.is_mpim) {
    // "mpdm-ana--bo--me-1" → "ana, bo, me"
    const handles = (c.name ?? "").replace(/^mpdm-/, "").replace(/-\d+$/, "").split("--").filter(Boolean);
    return { id: c.id, type: "mpim", name: handles.join(", ") || "group DM" };
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
