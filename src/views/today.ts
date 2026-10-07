import { getDb } from "@/db/client";
import { todayBounds } from "./helpers";

export type Meeting = {
  key: string;
  title: string;
  start: string;
  end: string | null;
  url: string | null; // calendar link
  noteUrl: string | null; // Granola note
  people: string[];
};

/**
 * Today's meetings: Calendar events, joined with Granola notes on the Google event id
 * (calendar.thread_key = event id = granola.thread_key). Until the Calendar connector
 * exists, Granola notes scheduled today stand in for events.
 */
export function todayMeetings(): Meeting[] {
  const { start, end } = todayBounds();
  const db = getDb().$client;
  const q = (source: string) =>
    db
      .prepare(
        `select thread_key, title, url, occurred_at, participants,
          coalesce(json_extract(raw_json,'$.end.dateTime'), json_extract(raw_json,'$.calendar_event.scheduled_end_time')) end_at
         from items where source = ? and occurred_at >= ? and occurred_at < ? order by occurred_at`,
      )
      .all(source, start, end) as { thread_key: string | null; title: string; url: string | null; occurred_at: string; participants: string; end_at: string | null }[];

  const notes = q("granola");
  const noteByEvent = new Map(notes.filter((n) => n.thread_key).map((n) => [n.thread_key!, n]));
  const out: Meeting[] = [];
  const seen = new Set<string>();
  const iso = (t: string | null) => (t ? new Date(t).toISOString() : null); // raw times may carry offsets
  const people = (p: string) => (JSON.parse(p) as { name?: string; email?: string }[]).map((x) => x.name || x.email || "").filter(Boolean);

  for (const ev of q("calendar")) {
    const key = ev.thread_key ?? ev.url ?? ev.title;
    seen.add(key);
    const note = ev.thread_key ? noteByEvent.get(ev.thread_key) : undefined;
    out.push({ key, title: ev.title, start: ev.occurred_at, end: iso(ev.end_at), url: ev.url, noteUrl: note?.url ?? null, people: people(ev.participants) });
  }
  for (const n of notes) {
    const key = n.thread_key ?? n.url ?? n.title;
    if (seen.has(key)) continue;
    out.push({ key, title: n.title, start: n.occurred_at, end: iso(n.end_at), url: null, noteUrl: n.url, people: people(n.participants) });
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}
