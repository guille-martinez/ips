import type { SourceView } from "./types";
import { count, rows, toView } from "./helpers";

// Expects raw = Linear Issue: { identifier, state: { name, type }, assignee: { isMe }, dueDate, priority }.
const MINE_OPEN = `json_extract(raw_json,'$.assignee.isMe') = 1 and json_extract(raw_json,'$.state.type') in ('unstarted','started','triage','backlog')`;

export const linearView: SourceView = {
  source: "linear",
  title: "Linear",
  tile: () => ({
    stats: [
      { label: "mine open", value: count("linear", MINE_OPEN) },
      { label: "in progress", value: count("linear", `${MINE_OPEN} and json_extract(raw_json,'$.state.type') = 'started'`) },
    ],
    items: rows("linear", { order: "coalesce(updated_at, occurred_at) desc", extra: "json_extract(raw_json,'$.state.name') state" }).map((r) =>
      toView(r, { badge: r.state as string }),
    ),
  }),
  pending: () =>
    rows("linear", {
      where: `${MINE_OPEN} and json_extract(raw_json,'$.state.type') != 'backlog'`,
      limit: 30,
      extra: "json_extract(raw_json,'$.state.name') state, json_extract(raw_json,'$.dueDate') due",
      order: "json_extract(raw_json,'$.state.type') = 'started' desc, json_extract(raw_json,'$.dueDate') is null, json_extract(raw_json,'$.dueDate')",
    }).map((r) => toView(r, { badge: r.state as string, due: (r.due as string) ?? null })),
};
