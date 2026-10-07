import type { SourceView } from "./types";
import { count, rows, sinceHours, toView } from "./helpers";

// raw = Slack message plus { channel, channel_type: "im" | "mpim" | "channel" | "group", channel_name, from_me, mentions_me }.
const j = (alias: string, path: string) => `json_extract(${alias}.raw_json,'$.${path}')`;
const isDm = (a: string) => `${j(a, "channel_type")} in ('im','mpim')`;
const DM = isDm("items");

// Needs me: a DM/group DM or an @-mention from someone else, with no later message from me in the
// same conversation (the whole DM, or the thread for channel mentions). One row per conversation.
const AWAITING = `${sinceHours(48)} and ${j("items", "from_me")} = 0
  and (${DM} or ${j("items", "mentions_me")} = 1)
  and not exists (
    select 1 from items m where m.source = 'slack' and m.occurred_at > items.occurred_at
      and (case when ${DM} then ${j("m", "channel")} = ${j("items", "channel")} else m.thread_key = items.thread_key end)
      and (${DM} or ${j("m", "from_me")} = 1)
  )`;

export const slackView: SourceView = {
  source: "slack",
  title: "Slack",
  tile: () => ({
    stats: [
      { label: "DMs 24h", value: count("slack", `${DM} and ${sinceHours(24)}`) },
      { label: "msgs 24h", value: count("slack", sinceHours(24)) },
      { label: "mentions 24h", value: count("slack", `${j("items", "mentions_me")} = 1 and ${sinceHours(24)}`) },
    ],
    items: rows("slack", { extra: `${j("items", "channel_name")} ch` }).map((r) => toView(r, { badge: (r.ch as string) ?? null })),
  }),
  pending: () =>
    rows("slack", { where: AWAITING, limit: 10, extra: `${j("items", "channel_name")} ch, ${DM} dm` }).map((r) =>
      toView(r, { badge: r.dm ? `DM ${r.ch ?? ""}`.trim() : ((r.ch as string) ?? "mention") }),
    ),
};
