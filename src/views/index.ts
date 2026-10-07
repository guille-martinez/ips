import type { Source } from "@/db/schema";
import type { SourceView, ViewItem } from "./types";
import { genericView } from "./helpers";
import { sheetsView } from "./sheets";
import { linearView } from "./linear";
import { gmailView } from "./gmail";
import { slackView } from "./slack";
import { granolaView } from "./granola";
import { calendarView } from "./calendar";

export const views: Record<Source, SourceView> = {
  calendar: calendarView,
  slack: slackView,
  gmail: gmailView,
  linear: linearView,
  granola: granolaView,
  sheets: sheetsView,
  notion: genericView("notion", "Notion"),
  attio: genericView("attio", "Attio"),
  metabase: genericView("metabase", "Metabase"),
};

/** Merged "needs me" list across every source. */
export function allPending(): ViewItem[] {
  return Object.values(views).flatMap((v) => v.pending?.() ?? []);
}
