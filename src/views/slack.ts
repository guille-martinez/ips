import type { SourceView } from "./types";
import { count, rows, sinceHours, toView } from "./helpers";

// Expects raw = Slack message plus { channel_type: "im" | "mpim" | "channel" | "group", channel_name }.
const DM = `json_extract(raw_json,'$.channel_type') in ('im','mpim')`;

export const slackView: SourceView = {
  source: "slack",
  title: "Slack",
  tile: () => ({
    stats: [
      { label: "DMs 24h", value: count("slack", `${DM} and ${sinceHours(24)}`) },
      { label: "msgs 24h", value: count("slack", sinceHours(24)) },
    ],
    items: rows("slack", { extra: "json_extract(raw_json,'$.channel_name') ch" }).map((r) => toView(r, { badge: (r.ch as string) ?? null })),
  }),
  // v1 heuristic: recent DMs. Phase 2 (triage) replaces this with "awaiting my reply".
  pending: () => rows("slack", { where: `${DM} and ${sinceHours(48)}`, limit: 10 }).map((r) => toView(r, { badge: "DM" })),
};
