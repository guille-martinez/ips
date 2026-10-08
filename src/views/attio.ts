import type { SourceView, ViewItem } from "./types";
import { count, rows, sinceHours, toView } from "./helpers";

// Expects raw = Attio record or note plus `ips`, a flat summary the connector adds:
// deals { object: "deals", stage, phase: prospecting|active|won|lost, open, owner, close_date (YYYY-MM-DD) },
// companies { customer_type }, carriers { status: Pipeline|Live, company }, notes { parent_name }.
const IPS = (f: string) => `json_extract(raw_json,'$.ips.${f}')`;
const OBJ = (o: string) => `${IPS("object")} = '${o}'`;
const OPEN_DEAL = `${OBJ("deals")} and ${IPS("open")} = 1`;
const ACTIVE_DEAL = `${OBJ("deals")} and ${IPS("phase")} = 'active'`;
const CLOSE = IPS("close_date");
const STALE_DAYS = 14;
const ymd = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

export const attioView: SourceView = {
  source: "attio",
  title: "Attio",
  tile: () => ({
    stats: [
      { label: "active deals", value: count("attio", ACTIVE_DEAL) },
      { label: "closing 30d", value: count("attio", `${OPEN_DEAL} and ${CLOSE} <= '${ymd(30)}'`) },
      { label: "carriers live", value: count("attio", `${OBJ("carriers")} and ${IPS("status")} = 'Live'`) },
      { label: "notes 7d", value: count("attio", `kind = 'note' and ${sinceHours(24 * 7)}`) },
    ],
    items: rows("attio", {
      order: "coalesce(updated_at, occurred_at) desc",
      extra: `${IPS("object")} obj, ${IPS("stage")} stage, ${IPS("status")} status, ${IPS("customer_type")} ctype, ${IPS("parent_name")} parent`,
    }).map((r) =>
      toView(r, {
        badge: ((r.obj === "notes" ? "note" : (r.stage ?? r.status ?? r.ctype)) as string | null) ?? null,
        subtitle: (r.obj === "notes" ? (r.parent ?? r.author) : r.author) as string | null,
      }),
    ),
  }),
  // I don't own deals in Attio, so "pending" is pipeline visibility, not my to-dos:
  // open deals whose close date has passed or is within a week, then active deals gone quiet.
  pending: () => {
    const closing = rows("attio", {
      where: `${OPEN_DEAL} and ${CLOSE} is not null and ${CLOSE} <= '${ymd(7)}'`,
      limit: 20,
      order: `${CLOSE} asc`,
      extra: `${IPS("stage")} stage, ${CLOSE} due, ${IPS("owner")} owner`,
    }).map((r) => toView(r, { badge: r.stage as string, due: r.due as string, subtitle: r.owner as string | null }));
    const seen = new Set(closing.map((i) => i.id));
    const stale: ViewItem[] = rows("attio", {
      where: `${ACTIVE_DEAL} and coalesce(updated_at, occurred_at) < '${daysAgo(STALE_DAYS)}'`,
      limit: 10,
      order: "coalesce(updated_at, occurred_at) asc",
      extra: `${IPS("owner")} owner`,
    })
      .filter((r) => !seen.has(r.id))
      .map((r) => toView(r, { badge: `quiet ${STALE_DAYS}d+`, subtitle: r.owner as string | null }));
    return [...closing, ...stale];
  },
};
