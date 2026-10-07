import { createReadOnlyClient, HttpError } from "@/lib/readonly-http";
import { backfillSince, requireEnv, type Connector, type NewItem } from "./types";

// Official Granola API (Business/Enterprise plans): https://docs.granola.ai/introduction
// GET /v1/notes?updated_after=…&cursor=…  then GET /v1/notes/{id} for the full note.

type NoteSummary = { id: string; updated_at: string; deleted_at: string | null };
type ListResponse = { notes: NoteSummary[]; hasMore: boolean; cursor: string | null };
type Note = {
  id: string;
  title: string | null;
  web_url: string;
  owner: { name: string | null; email: string };
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  calendar_event: {
    event_title: string | null;
    invitees: { email: string }[];
    organiser: string | null;
    calendar_event_id: string | null;
    scheduled_start_time: string | null;
    scheduled_end_time: string | null;
  } | null;
  attendees: { name: string | null; email: string }[];
  summary_text: string | null;
  summary_markdown: string | null;
  private_notes_text: string | null;
};

/** Cursor: `since` = high-water mark of updated_at; `page` = API cursor while paging. */
type State = { since: string; page?: string | null; maxSeen?: string };

export function makeGranola(fetchImpl?: typeof fetch): Connector {
  const api = createReadOnlyClient({
    baseUrl: "https://public-api.granola.ai",
    headers: () => ({ authorization: `Bearer ${process.env.GRANOLA_API_KEY}` }),
    fetchImpl,
  });

  return {
    source: "granola",
    label: "Granola",
    configured: () => requireEnv("GRANOLA_API_KEY"),

    async checkAuth() {
      const res = await api.get<ListResponse>("/v1/notes", { page_size: 1 });
      return { ok: true, identity: res.notes.length ? "API key works, notes visible" : "API key works (no notes yet)" };
    },

    async sync(cursor) {
      const state: State = cursor ? JSON.parse(cursor) : { since: backfillSince().toISOString() };
      const list = await api.get<ListResponse>("/v1/notes", {
        updated_after: state.since,
        page_size: 30,
        cursor: state.page ?? undefined,
      });

      const items: NewItem[] = [];
      let maxSeen = state.maxSeen ?? state.since;
      for (const s of list.notes) {
        if (s.updated_at > maxSeen) maxSeen = s.updated_at;
        if (s.deleted_at) continue;
        try {
          items.push(toItem(await api.get<Note>(`/v1/notes/${encodeURIComponent(s.id)}`)));
        } catch (e) {
          // Listed but not fetchable yet (e.g. meeting still processing). Picked up when it next updates.
          if (e instanceof HttpError && e.status === 404) continue;
          throw e;
        }
      }

      const more = list.hasMore && !!list.cursor;
      const next: State = more ? { since: state.since, page: list.cursor, maxSeen } : { since: maxSeen };
      return { items, nextCursor: JSON.stringify(next), hasMore: more };
    },
  };
}

export function toItem(n: Note): NewItem {
  const ev = n.calendar_event;
  const participants = n.attendees.map((a) => ({ name: a.name ?? undefined, email: a.email }));
  for (const inv of ev?.invitees ?? []) {
    if (!participants.some((p) => p.email === inv.email)) participants.push({ name: undefined, email: inv.email });
  }
  const body = [n.summary_markdown ?? n.summary_text, n.private_notes_text ? `My notes:\n${n.private_notes_text}` : null]
    .filter(Boolean)
    .join("\n\n");
  return {
    externalId: n.id,
    kind: "note",
    threadKey: ev?.calendar_event_id ?? null, // links the note to its Calendar event
    author: n.owner.name ?? n.owner.email,
    participants,
    title: n.title ?? ev?.event_title ?? "(untitled meeting)",
    bodyText: body || null,
    url: n.web_url,
    occurredAt: ev?.scheduled_start_time ?? n.created_at,
    updatedAt: n.updated_at,
    raw: n,
  };
}

export const granola = makeGranola();
