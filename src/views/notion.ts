import type { SourceView } from "./types";
import { count, rows, sinceHours, toView } from "./helpers";

// Expects raw = Notion page + `_open_todos: [{ text, mentions: [email | user id] }]` (see src/connectors/notion.ts).
// "Me" is NOTION_ME_EMAIL (optional): without it there is no Pending rule.
const me = () => process.env.NOTION_ME_EMAIL?.trim().toLowerCase() || null;
const esc = (s: string) => s.replace(/'/g, "''");

const todosForMe = (email: string) =>
  `exists (select 1 from json_each(raw_json,'$._open_todos') t, json_each(t.value,'$.mentions') m where lower(m.value) = '${esc(email)}')`;

const recent = "coalesce(updated_at, occurred_at) desc";

export const notionView: SourceView = {
  source: "notion",
  title: "Notion",
  tile: () => {
    const email = me();
    return {
      stats: [
        { label: "edited 7d", value: count("notion", sinceHours(24 * 7)) },
        ...(email ? [{ label: "pages w/ my to-dos", value: count("notion", todosForMe(email)) }] : []),
      ],
      items: rows("notion", { order: recent }).map((r) => toView(r)),
    };
  },
  pending: () => {
    const email = me();
    if (!email) return [];
    return rows("notion", {
      where: `${todosForMe(email)} and ${sinceHours(24 * 30)}`,
      limit: 20,
      order: recent,
      extra: `(select count(*) from json_each(raw_json,'$._open_todos') t, json_each(t.value,'$.mentions') m where lower(m.value) = '${esc(email)}') n`,
    }).map((r) => toView(r, { badge: `${r.n} to-do${r.n === 1 ? "" : "s"}` }));
  },
};
