import { HttpError } from "@/lib/readonly-http";
import { googleApi, googleConfigured, type GoogleDeps } from "@/lib/google-auth";
import type { Participant } from "@/db/schema";
import { backfillSince, type Connector, type NewItem } from "./types";

// Calendar REST v3, primary calendar. Full sync: events.list over [backfill, now + 60d] with
// singleEvents=true (recurring meetings expanded into instances), then nextSyncToken.
// The window needs an end: without timeMax every weekly series expands out to ~2040.
// A sync token keeps the window it was created with, so once a week we redo the full
// sync to slide the window forward (about 500 events, cheap).

type When = { dateTime?: string; date?: string; timeZone?: string };
type Person = { email?: string; displayName?: string; self?: boolean; organizer?: boolean; responseStatus?: string };
export type CalEvent = {
  id: string;
  status: string; // confirmed | tentative | cancelled
  htmlLink?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: When;
  end?: When;
  updated?: string;
  organizer?: Person;
  creator?: Person;
  attendees?: Person[];
  eventType?: string;
  recurringEventId?: string;
  conferenceData?: unknown;
};
type ListResponse = { items?: CalEvent[]; nextPageToken?: string; nextSyncToken?: string };

/**
 * `windowEnd` = the timeMax the current token was created with.
 * `syncToken` once the full listing is done; `page` while paging either kind of listing.
 */
type State = { windowEnd?: string; syncToken?: string; page?: string };

const HORIZON_DAYS = 60;
const RESYNC_EVERY_DAYS = 7;
const DAY = 86_400_000;

export function makeCalendar(deps: GoogleDeps = {}): Connector {
  const api = googleApi("https://www.googleapis.com", deps);
  const EVENTS = "/calendar/v3/calendars/primary/events";

  return {
    source: "calendar",
    label: "Google Calendar",
    configured: () => googleConfigured(),

    async checkAuth() {
      const c = await api.get<{ id: string; timeZone?: string }>("/calendar/v3/calendars/primary");
      return { ok: true, identity: `${c.id} (${c.timeZone ?? "no tz"})` };
    },

    async sync(cursor) {
      let state: State = cursor ? JSON.parse(cursor) : {};
      // Slide the window: once a week (between pages only), drop the token and redo the full sync.
      const stale = !state.windowEnd || Date.parse(state.windowEnd) - Date.now() < (HORIZON_DAYS - RESYNC_EVERY_DAYS) * DAY;
      if (!state.page && stale) state = { windowEnd: new Date(Date.now() + HORIZON_DAYS * DAY).toISOString() };
      let res: ListResponse;
      try {
        res = await api.get<ListResponse>(EVENTS, {
          singleEvents: true,
          maxResults: 250,
          // A sync token can't be combined with timeMin/timeMax; the full sync's window is baked into it.
          timeMin: state.syncToken ? undefined : backfillSince().toISOString(),
          timeMax: state.syncToken ? undefined : state.windowEnd,
          syncToken: state.syncToken,
          pageToken: state.page,
        });
      } catch (e) {
        // 410 Gone: sync token expired. Full resync from the backfill window.
        if (e instanceof HttpError && e.status === 410) return { items: [], nextCursor: null, hasMore: true };
        throw e;
      }

      const items = (res.items ?? []).filter(keep).map(toItem);
      const next: State = res.nextPageToken ? { ...state, page: res.nextPageToken } : { windowEnd: state.windowEnd, syncToken: res.nextSyncToken };
      return { items, nextCursor: JSON.stringify(next), hasMore: !!res.nextPageToken };
    },
  };
}

/** Skip cancelled events, ones I declined, and working-location / birthday markers. */
export function keep(e: CalEvent): boolean {
  if (e.status === "cancelled") return false;
  if (e.attendees?.some((a) => a.self && a.responseStatus === "declined")) return false;
  if (e.eventType === "workingLocation" || e.eventType === "birthday") return false;
  return !!e.start;
}

export function toItem(e: CalEvent): NewItem {
  const participants: Participant[] = (e.attendees ?? [])
    .filter((a) => a.email && !a.email.endsWith("resource.calendar.google.com"))
    .map((a) => (a.displayName ? { name: a.displayName, email: a.email } : { email: a.email }));
  const org = e.organizer ?? e.creator;
  const body = [e.location ? `Location: ${e.location}` : null, e.description ? stripHtml(e.description) : null].filter(Boolean).join("\n\n");
  return {
    externalId: e.id,
    kind: "event",
    threadKey: e.id, // = Granola's calendar_event_id; the Today panel joins on it
    author: org?.displayName ?? org?.email ?? null,
    participants,
    title: e.summary || "(no title)",
    bodyText: body || null,
    url: e.htmlLink ?? null,
    occurredAt: e.start!.dateTime ?? e.start!.date!, // all-day events: a plain date, read as UTC midnight
    updatedAt: e.updated ?? null,
    raw: e,
  };
}

function stripHtml(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim()
    .slice(0, 5000);
}

export const calendar = makeCalendar();
