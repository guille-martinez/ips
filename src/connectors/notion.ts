import { createReadOnlyClient, HttpError } from "@/lib/readonly-http";
import type { Participant } from "@/db/schema";
import { backfillSince, requireEnv, type Connector, type NewItem } from "./types";

// Notion REST API with an internal integration token (Read content only).
// POST /v1/search sorted by last_edited_time desc (a read, allow-listed), then
// GET /v1/blocks/{id}/children for the first level of each page's content.

const NOTION_VERSION = "2022-06-28";
const BODY_CAP = 8000;

type RichText = {
  type: string;
  plain_text: string;
  mention?: { type: string; user?: { id: string } };
};
type PartialUser = { object: "user"; id: string };
type Page = {
  object: "page";
  id: string;
  url: string;
  created_time: string;
  last_edited_time: string;
  created_by: PartialUser;
  last_edited_by: PartialUser;
  archived?: boolean;
  is_archived?: boolean;
  in_trash?: boolean;
  parent: { type: string; [k: string]: unknown };
  properties: Record<string, Property>;
};
type PropUser = { id: string; name?: string | null; person?: { email?: string } };
type Property = {
  type: string;
  title?: RichText[];
  rich_text?: RichText[];
  status?: { name: string } | null;
  select?: { name: string } | null;
  multi_select?: { name: string }[];
  people?: PropUser[];
  date?: { start: string; end: string | null } | null;
  number?: number | null;
  checkbox?: boolean;
};
type SearchResponse = { results: (Page | { object: "database"; id: string; last_edited_time: string })[]; has_more: boolean; next_cursor: string | null };
type Block = { id: string; type: string; has_children?: boolean; [k: string]: unknown };
type BlocksResponse = { results: Block[]; has_more: boolean; next_cursor: string | null };
type User = { id: string; type: "person" | "bot"; name: string | null; person?: { email?: string } };
type UsersResponse = { results: User[]; has_more: boolean; next_cursor: string | null };
type BotUser = { name: string | null; bot?: { workspace_name?: string | null } };

/** An unchecked to-do on the page's first level, with the people it @mentions (email when known, else user id). */
export type OpenTodo = { text: string; mentions: string[] };

/**
 * Cursor: `since` = high-water mark of last_edited_time; `page` = search cursor while paging.
 * Notion rounds last_edited_time to the minute, so pages edited exactly at `since` are
 * fetched again on the next run (upsert makes that harmless) instead of being missed.
 */
type State = { since: string; page?: string | null; maxSeen?: string };

const USERS_TTL_MS = 3600_000;

export function makeNotion(fetchImpl?: typeof fetch): Connector {
  const api = createReadOnlyClient({
    baseUrl: "https://api.notion.com",
    headers: () => ({ authorization: `Bearer ${process.env.NOTION_TOKEN}`, "notion-version": NOTION_VERSION }),
    readPosts: [/^\/v1\/search$/],
    fetchImpl,
  });

  let users: { at: number; byId: Map<string, User> } | null = null;
  async function userMap(): Promise<Map<string, User>> {
    if (users && Date.now() - users.at < USERS_TTL_MS) return users.byId;
    const byId = new Map<string, User>();
    let start: string | null = null;
    do {
      const res: UsersResponse = await api.get<UsersResponse>("/v1/users", { page_size: 100, start_cursor: start ?? undefined });
      for (const u of res.results) byId.set(u.id, u);
      start = res.has_more ? res.next_cursor : null;
    } while (start);
    users = { at: Date.now(), byId };
    return byId;
  }

  async function firstLevelBlocks(pageId: string): Promise<Block[]> {
    try {
      // One page of up to 100 blocks is plenty for a capped body.
      const res = await api.get<BlocksResponse>(`/v1/blocks/${encodeURIComponent(pageId)}/children`, { page_size: 100 });
      return res.results;
    } catch (e) {
      // Visible in search but content not readable (e.g. permissions changed mid-run): keep the title only.
      if (e instanceof HttpError && (e.status === 404 || e.status === 403)) return [];
      throw e;
    }
  }

  return {
    source: "notion",
    label: "Notion",
    configured: () => requireEnv("NOTION_TOKEN"),

    async checkAuth() {
      const me = await api.get<BotUser>("/v1/users/me");
      const ws = me.bot?.workspace_name;
      return { ok: true, identity: `integration ${me.name ?? "(unnamed)"}${ws ? ` on workspace ${ws}` : ""}` };
    },

    async sync(cursor) {
      const state: State = cursor ? JSON.parse(cursor) : { since: backfillSince().toISOString() };
      const res = await api.postRead<SearchResponse>("/v1/search", {
        filter: { property: "object", value: "page" },
        sort: { direction: "descending", timestamp: "last_edited_time" },
        page_size: 50,
        start_cursor: state.page ?? undefined,
      });

      const people = await userMap();
      const items: NewItem[] = [];
      let maxSeen = state.maxSeen ?? state.since;
      let reachedOld = false;
      for (const r of res.results) {
        if (r.object !== "page") continue;
        if (Date.parse(r.last_edited_time) < Date.parse(state.since)) {
          reachedOld = true; // sorted newest first: everything after this is already ingested
          break;
        }
        if (r.last_edited_time > maxSeen) maxSeen = r.last_edited_time;
        if (r.archived || r.is_archived || r.in_trash) continue;
        items.push(toItem(r, await firstLevelBlocks(r.id), people));
      }

      const more = !reachedOld && res.has_more && !!res.next_cursor;
      const next: State = more ? { since: state.since, page: res.next_cursor, maxSeen } : { since: maxSeen };
      return { items, nextCursor: JSON.stringify(next), hasMore: more };
    },
  };
}

const plain = (rt: RichText[] | undefined) => (rt ?? []).map((t) => t.plain_text).join("");

export function pageTitle(p: Page): string {
  const prop = Object.values(p.properties).find((v) => v.type === "title");
  return plain(prop?.title).trim();
}

function richTextOf(b: Block): RichText[] | undefined {
  const inner = b[b.type] as { rich_text?: RichText[] } | undefined;
  return inner?.rich_text;
}

/** One line of plain text per first-level block. Images, files and embeds are skipped. */
export function blockText(b: Block): string | null {
  const inner = b[b.type] as Record<string, unknown> | undefined;
  const text = plain(richTextOf(b));
  switch (b.type) {
    case "heading_1":
      return `# ${text}`;
    case "heading_2":
      return `## ${text}`;
    case "heading_3":
      return `### ${text}`;
    case "bulleted_list_item":
      return `- ${text}`;
    case "numbered_list_item":
      return `1. ${text}`;
    case "to_do":
      return `[${inner?.checked ? "x" : " "}] ${text}`;
    case "quote":
      return `> ${text}`;
    case "child_page":
    case "child_database":
      return `[${b.type === "child_page" ? "page" : "database"}] ${(inner?.title as string) ?? ""}`;
    case "divider":
      return "---";
    default:
      return text || null;
  }
}

/** Database-row properties as "Name: value" lines, so status, people and dates are searchable. */
export function propertyLines(p: Page): string[] {
  const out: string[] = [];
  for (const [name, v] of Object.entries(p.properties)) {
    let val: string | null = null;
    if (v.type === "rich_text") val = plain(v.rich_text).trim();
    else if (v.type === "status") val = v.status?.name ?? null;
    else if (v.type === "select") val = v.select?.name ?? null;
    else if (v.type === "multi_select") val = (v.multi_select ?? []).map((o) => o.name).join(", ");
    else if (v.type === "people") val = (v.people ?? []).map((u) => u.name ?? u.person?.email ?? "").filter(Boolean).join(", ");
    else if (v.type === "date") val = v.date ? [v.date.start, v.date.end].filter(Boolean).join(" → ") : null;
    else if (v.type === "number") val = v.number == null ? null : String(v.number);
    else if (v.type === "checkbox") val = v.checkbox ? "yes" : null;
    if (val) out.push(`${name}: ${val}`);
  }
  return out;
}

function mentionedUsers(rt: RichText[] | undefined): string[] {
  return (rt ?? []).flatMap((t) => (t.type === "mention" && t.mention?.type === "user" && t.mention.user ? [t.mention.user.id] : []));
}

export function toItem(p: Page, blocks: Block[], people: Map<string, User>): NewItem {
  const propPeople = Object.values(p.properties).flatMap((v) => (v.type === "people" ? (v.people ?? []) : []));
  const fromProps = new Map(propPeople.map((u): [string, User] => [u.id, { id: u.id, type: "person", name: u.name ?? null, person: u.person }]));
  const lookup = (id: string) => people.get(id) ?? fromProps.get(id);
  const who = (id: string): Participant | null => {
    const u = lookup(id);
    if (u?.type === "bot") return null;
    return u ? { name: u.name ?? undefined, email: u.person?.email } : { handle: id };
  };
  const participants: Participant[] = [];
  const ids = [p.created_by.id, p.last_edited_by.id, ...propPeople.map((u) => u.id), ...blocks.flatMap((b) => mentionedUsers(richTextOf(b)))];
  for (const id of new Set(ids)) {
    const w = who(id);
    if (w) participants.push(w);
  }

  const openTodos: OpenTodo[] = blocks
    .filter((b) => b.type === "to_do" && !(b.to_do as { checked?: boolean }).checked)
    .map((b) => ({
      text: plain(richTextOf(b)).trim(),
      mentions: mentionedUsers(richTextOf(b)).map((id) => lookup(id)?.person?.email ?? id),
    }))
    .filter((t) => t.text);

  const title = pageTitle(p) || "(untitled page)";
  const lines = blocks.map(blockText).filter((l): l is string => !!l && !!l.trim());
  const body = [title, ...propertyLines(p), ...lines].join("\n").slice(0, BODY_CAP);
  const editor = people.get(p.last_edited_by.id);

  return {
    externalId: p.id,
    kind: "page",
    threadKey: null,
    author: editor?.type === "person" ? (editor.name ?? editor.person?.email ?? null) : null,
    participants,
    title,
    bodyText: body,
    url: p.url,
    // A page's "event" is its latest edit: that is what puts it on the Feed and the tile.
    occurredAt: p.last_edited_time,
    updatedAt: p.last_edited_time,
    // The page object as-is, plus derived open to-dos for the Pending rule (see src/views/notion.ts).
    raw: { ...p, _open_todos: openTodos },
  };
}

export const notion = makeNotion();
