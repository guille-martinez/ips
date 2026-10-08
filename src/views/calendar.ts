import type { SourceView } from "./types";
import { count, rows, todayBounds, toView } from "./helpers";

// Expects raw = Calendar event: { start: { dateTime | date }, end: { dateTime | date } }.
const upcoming = (hours: number) => {
  const now = new Date();
  return `occurred_at >= '${now.toISOString()}' and occurred_at < '${new Date(now.getTime() + hours * 3600_000).toISOString()}'`;
};

export const calendarView: SourceView = {
  source: "calendar",
  title: "Calendar",
  tile: () => {
    const { start, end } = todayBounds();
    return {
      stats: [
        { label: "today", value: count("calendar", `occurred_at >= '${start}' and occurred_at < '${end}'`) },
        { label: "next 7d", value: count("calendar", upcoming(24 * 7)) },
      ],
      // Next meetings, soonest first (the Today panel covers the rest of the day).
      items: rows("calendar", { where: upcoming(24 * 7), order: "occurred_at asc" }).map((r) => toView(r)),
    };
  },
};
