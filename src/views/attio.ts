import type { SourceView } from "./types";
import { count, rows, sinceHours, toView } from "./helpers";

// Expects raw = Attio record or note plus `ips`, a flat summary the connector adds:
// deals { object: "deals", stage, open, owner, close_date (YYYY-MM-DD), acv, company },
// companies { object: "companies", customer_type }, notes { object: "notes", parent_name }.
const OBJ = (o: string) => `json_extract(raw_json,'$.ips.object') = '${o}'`;
const OPEN_DEAL = `${OBJ("deals")} and json_extract(raw_json,'$.ips.open') = 1`;
const CLOSE = `json_extract(raw_json,'$.ips.close_date')`;
const ymd = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

export const attioView: SourceView = {
  source: "attio",
  title: "Attio",
  tile: () => ({
    stats: [
      { label: "open deals", value: count("attio", OPEN_DEAL) },
      { label: "closing 30d", value: count("attio", `${OPEN_DEAL} and ${CLOSE} <= '${ymd(30)}'`) },
      { label: "changed 7d", value: count("attio", sinceHours(24 * 7)) },
    ],
    items: rows("attio", {
      extra: `json_extract(raw_json,'$.ips.object') obj, json_extract(raw_json,'$.ips.stage') stage, json_extract(raw_json,'$.ips.customer_type') ctype`,
    }).map((r) => toView(r, { badge: ((r.obj === "notes" ? "note" : (r.stage ?? r.ctype)) as string) ?? null })),
  }),
  // I'm not a deal owner in Attio, so "pending" is pipeline visibility: open deals whose
  // expected close date has passed or is within a week.
  pending: () =>
    rows("attio", {
      where: `${OPEN_DEAL} and ${CLOSE} is not null and ${CLOSE} <= '${ymd(7)}'`,
      limit: 20,
      order: `${CLOSE} asc`,
      extra: `json_extract(raw_json,'$.ips.stage') stage, ${CLOSE} due, json_extract(raw_json,'$.ips.owner') owner`,
    }).map((r) => toView(r, { badge: r.stage as string, due: r.due as string, subtitle: r.owner as string | null })),
};
