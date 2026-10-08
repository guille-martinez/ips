import type { SourceView } from "./types";
import { count, rows, toView } from "./helpers";

// Expects raw = Linear Issue: { identifier, state: { name, type }, assignee: { isMe }, dueDate, team: { key } }.
// Most of the workspace is other teams' issues, so everything here is scoped to issues assigned to me.
const j = (path: string) => `json_extract(raw_json,'$.${path}')`;
const MINE = `${j("assignee.isMe")} = 1`;
const OPEN = `${j("state.type")} in ('triage','unstarted','started','backlog')`;
// Custom "Waiting on third party"-style states are type `started`, but they're on someone else.
const WAITING = `lower(${j("state.name")}) like '%waiting%'`;
const OVERDUE = `${j("dueDate")} < date('now','localtime')`;
const ACTIONABLE = `${j("state.type")} in ('triage','unstarted','started') and not ${WAITING}`;

const extra = `${j("state.name")} state, ${j("dueDate")} due`;
const asView = (r: ReturnType<typeof rows>[number]) => toView(r, { badge: r.state as string, due: (r.due as string) ?? null });

export const linearView: SourceView = {
  source: "linear",
  title: "Linear",
  tile: () => ({
    stats: [
      { label: "mine open", value: count("linear", `${MINE} and ${ACTIONABLE}`) },
      { label: "overdue", value: count("linear", `${MINE} and ${OPEN} and ${OVERDUE}`) },
      { label: "waiting", value: count("linear", `${MINE} and ${OPEN} and ${WAITING}`) },
    ],
    items: rows("linear", { where: `${MINE} and ${OPEN}`, order: "coalesce(updated_at, occurred_at) desc", extra }).map(asView),
  }),
  // Assigned to me and actionable (not waiting on a third party), plus anything of mine that's overdue
  // even if it sits in backlog. Due/overdue first, then in progress, then most recently touched.
  pending: () =>
    rows("linear", {
      where: `${MINE} and ${OPEN} and ((${ACTIONABLE}) or (${OVERDUE} and not ${WAITING}))`,
      limit: 30,
      extra,
      order: `${j("dueDate")} is null, ${j("dueDate")}, ${j("state.type")} = 'started' desc, coalesce(updated_at, occurred_at) desc`,
    }).map(asView),
};
