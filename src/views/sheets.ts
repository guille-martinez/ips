import type { SourceView } from "./types";
import { count, rows, toView } from "./helpers";

// Expects raw = { tab: "Daily prios" | "Readings", status, deadline, owner, link } (see docs/fanout.md).
const OPEN = `json_extract(raw_json,'$.tab') = 'Daily prios' and json_extract(raw_json,'$.status') in ('Pending','WIP','Review','Blocked')`;
const READING = `json_extract(raw_json,'$.tab') = 'Readings' and json_extract(raw_json,'$.status') != 'Done'`;

export const sheetsView: SourceView = {
  source: "sheets",
  title: "Superbrain",
  tile: () => ({
    stats: [
      { label: "open tasks", value: count("sheets", OPEN) },
      { label: "WIP", value: count("sheets", `${OPEN} and json_extract(raw_json,'$.status') = 'WIP'`) },
      { label: "to read", value: count("sheets", READING) },
    ],
    items: rows("sheets", { where: READING, limit: 5 }).map((r) => toView(r, { badge: "read", subtitle: null })),
  }),
  pending: () =>
    rows("sheets", {
      where: OPEN,
      limit: 50,
      extra: "json_extract(raw_json,'$.status') status, json_extract(raw_json,'$.deadline') deadline",
      // WIP first, then by deadline
      order: "case json_extract(raw_json,'$.status') when 'WIP' then 0 when 'Blocked' then 1 when 'Review' then 2 else 3 end, json_extract(raw_json,'$.deadline') is null, json_extract(raw_json,'$.deadline')",
    }).map((r) => toView(r, { badge: String(r.status), due: (r.deadline as string) ?? null, subtitle: r.author })),
};
