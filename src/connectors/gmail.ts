import { HttpError } from "@/lib/readonly-http";
import { googleApi, googleConfigured, type GoogleDeps } from "@/lib/google-auth";
import type { Participant } from "@/db/schema";
import { backfillSince, type Connector, type NewItem } from "./types";

// Gmail REST v1. First run: messages.list over the backfill window, then history.list from
// the historyId captured before the backfill started. Every changed message is re-fetched
// with format=full, so label changes (read/archived) land in raw.labelIds.

type Header = { name: string; value: string };
type Part = { mimeType?: string; filename?: string; headers?: Header[]; body?: { data?: string; size?: number; attachmentId?: string }; parts?: Part[] };
export type GmailMessage = {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  internalDate: string;
  payload?: Part;
  sizeEstimate?: number;
};
type ListResponse = { messages?: { id: string; threadId: string }[]; nextPageToken?: string };
type HistoryRecord = {
  messages?: { id: string }[];
  messagesAdded?: { message: { id: string } }[];
  labelsAdded?: { message: { id: string } }[];
  labelsRemoved?: { message: { id: string } }[];
};
type HistoryResponse = { history?: HistoryRecord[]; nextPageToken?: string; historyId: string };

/**
 * backfill: listing the window; `historyId` was captured before it started, so nothing is missed.
 * history: incremental from `historyId`; `page` while paging one history.list call.
 */
type State = { phase: "backfill" | "history"; historyId: string; page?: string };

const PAGE_SIZE = 50;
const BODY_CAP = 20_000;
const CONCURRENCY = 8;

export function makeGmail(deps: GoogleDeps = {}): Connector {
  const api = googleApi("https://gmail.googleapis.com", deps);

  async function fetchMessages(ids: string[]): Promise<NewItem[]> {
    const out: NewItem[] = [];
    const queue = [...new Set(ids)];
    async function worker() {
      for (let id = queue.shift(); id; id = queue.shift()) {
        try {
          const m = await api.get<GmailMessage>(`/gmail/v1/users/me/messages/${encodeURIComponent(id)}`, { format: "full" });
          if (m.labelIds?.includes("DRAFT")) continue;
          out.push(toItem(m));
        } catch (e) {
          if (e instanceof HttpError && e.status === 404) continue; // deleted since it was listed
          throw e;
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    return out.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  }

  return {
    source: "gmail",
    label: "Gmail",
    configured: () => googleConfigured(),

    async checkAuth() {
      const p = await api.get<{ emailAddress: string; messagesTotal: number }>("/gmail/v1/users/me/profile");
      return { ok: true, identity: `${p.emailAddress} (${p.messagesTotal} messages)` };
    },

    async sync(cursor) {
      let state: State | null = cursor ? JSON.parse(cursor) : null;
      if (!state) {
        const p = await api.get<{ historyId: string }>("/gmail/v1/users/me/profile");
        state = { phase: "backfill", historyId: p.historyId };
      }

      if (state.phase === "backfill") {
        const after = Math.floor(backfillSince().getTime() / 1000);
        const list = await api.get<ListResponse>("/gmail/v1/users/me/messages", {
          q: `after:${after}`,
          maxResults: PAGE_SIZE,
          pageToken: state.page,
        });
        const items = await fetchMessages((list.messages ?? []).map((m) => m.id));
        const next: State = list.nextPageToken
          ? { phase: "backfill", historyId: state.historyId, page: list.nextPageToken }
          : { phase: "history", historyId: state.historyId };
        return { items, nextCursor: JSON.stringify(next), hasMore: !!list.nextPageToken };
      }

      let hist: HistoryResponse;
      try {
        hist = await api.get<HistoryResponse>("/gmail/v1/users/me/history", {
          startHistoryId: state.historyId,
          maxResults: PAGE_SIZE,
          pageToken: state.page,
        });
      } catch (e) {
        // historyId too old (Gmail keeps about a week): start over with a full-window backfill.
        if (e instanceof HttpError && e.status === 404) return { items: [], nextCursor: null, hasMore: true };
        throw e;
      }
      const ids = (hist.history ?? []).flatMap((h) => [
        ...(h.messagesAdded ?? []).map((x) => x.message.id),
        ...(h.labelsAdded ?? []).map((x) => x.message.id),
        ...(h.labelsRemoved ?? []).map((x) => x.message.id),
      ]);
      const items = await fetchMessages(ids);
      const next: State = hist.nextPageToken
        ? { phase: "history", historyId: state.historyId, page: hist.nextPageToken }
        : { phase: "history", historyId: hist.historyId };
      return { items, nextCursor: JSON.stringify(next), hasMore: !!hist.nextPageToken };
    },
  };
}

export function toItem(m: GmailMessage): NewItem {
  const h = (name: string) => m.payload?.headers?.find((x) => x.name.toLowerCase() === name)?.value ?? null;
  const from = parseAddresses(h("from") ?? "")[0];
  const participants: Participant[] = [];
  for (const p of [from, ...parseAddresses(h("to") ?? ""), ...parseAddresses(h("cc") ?? "")]) {
    if (p?.email && !participants.some((x) => x.email === p.email)) participants.push(p);
  }
  return {
    externalId: m.id,
    kind: "email",
    threadKey: m.threadId,
    author: from ? (from.name ?? from.email) : null,
    participants,
    title: h("subject") || "(no subject)",
    bodyText: extractBody(m.payload) ?? m.snippet ?? null,
    url: `https://mail.google.com/mail/u/0/#all/${m.threadId}`,
    occurredAt: new Date(Number(m.internalDate)).toISOString(),
    updatedAt: null,
    raw: stripBodies(m),
  };
}

/** "Ana <ana@x.com>, \"Bo, B\" <bo@x.com>, c@x.com" → participants. */
export function parseAddresses(header: string): Participant[] {
  const out: Participant[] = [];
  for (const part of header.match(/(?:"[^"]*"|[^,])+/g) ?? []) {
    const m = part.trim().match(/^(.*?)\s*<([^>]+)>$/);
    const email = (m ? m[2] : part).trim().toLowerCase();
    if (!email.includes("@")) continue;
    const name = m?.[1].replace(/^"|"$/g, "").trim();
    out.push(name ? { name, email } : { email });
  }
  return out;
}

const decode = (data: string) => Buffer.from(data, "base64url").toString("utf8");

function findPart(p: Part | undefined, mime: string): Part | undefined {
  if (!p) return undefined;
  if (p.mimeType === mime && p.body?.data && !p.filename) return p;
  for (const c of p.parts ?? []) {
    const hit = findPart(c, mime);
    if (hit) return hit;
  }
  return undefined;
}

/** text/plain if present, else a crude text rendering of text/html. Capped. */
export function extractBody(payload: Part | undefined): string | null {
  const plain = findPart(payload, "text/plain");
  let text: string | null = plain ? decode(plain.body!.data!) : null;
  if (!text) {
    const html = findPart(payload, "text/html");
    if (html) text = htmlToText(decode(html.body!.data!));
  }
  if (!text) return null;
  text = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return text.length > BODY_CAP ? `${text.slice(0, BODY_CAP)}…` : text;
}

function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ");
}

/** raw = the API message as-is, minus the base64 part bodies (already in bodyText; they'd double the DB size). */
function stripBodies(m: GmailMessage): GmailMessage {
  const strip = (p: Part): Part => ({
    ...p,
    body: p.body ? { size: p.body.size, attachmentId: p.body.attachmentId } : undefined,
    parts: p.parts?.map(strip),
  });
  return { ...m, payload: m.payload ? strip(m.payload) : undefined };
}

export const gmail = makeGmail();
