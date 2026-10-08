import type { SourceView, ViewItem } from "./types";
import { count, rows, sinceHours, toView } from "./helpers";

// Expects raw = Notion page object (properties as the API returns them) plus
// `_open_todos: [{ text, mentions: [email | user id] }]` (see src/connectors/notion.ts).
// "Me" is NOTION_ME_EMAIL (optional): without it there are no Pending rules.
const me = () => process.env.NOTION_ME_EMAIL?.trim().toLowerCase() || null;
const esc = (s: string) => s.replace(/'/g, "''");

/** Unchecked first-level to-dos that @mention me. */
const todosForMe = (email: string) =>
  `(select count(*) from json_each(raw_json,'$._open_todos') t, json_each(t.value,'$.mentions') m where lower(m.value) = '${esc(email)}')`;

const inPeopleProp = (email: string, keyLike: string[]) =>
  `exists (select 1 from json_each(raw_json,'$.properties') p, json_each(p.value,'$.people') u
    where (${keyLike.map((k) => `p.key like '%${k}%'`).join(" or ")}) and lower(json_extract(u.value,'$.person.email')) = '${esc(email)}')`;

const statusExpr = `(select json_extract(s.value,'$.status.name') from json_each(raw_json,'$.properties') s where json_extract(s.value,'$.type') = 'status' limit 1)`;

/** Database rows waiting on my review: status says "review", I'm a reviewer/stakeholder, and I haven't approved. */
const reviewForMe = (email: string) =>
  `${statusExpr} like '%review%' and ${inPeopleProp(email, ["review", "stakeholder"])} and not ${inPeopleProp(email, ["approved"])}`;

const recent = "coalesce(updated_at, occurred_at) desc";

export const notionView: SourceView = {
  source: "notion",
  title: "Notion",
  tile: () => {
    const email = me();
    return {
      stats: [
        { label: "edited 7d", value: count("notion", sinceHours(24 * 7)) },
        ...(email ? [{ label: "to review", value: count("notion", reviewForMe(email)) }] : []),
      ],
      items: rows("notion", { order: recent, extra: `${statusExpr} status` }).map((r) => toView(r, { badge: (r.status as string) ?? null })),
    };
  },
  pending: () => {
    const email = me();
    if (!email) return [];
    const reviews = rows("notion", { where: reviewForMe(email), limit: 20, order: recent, extra: `${statusExpr} status` }).map((r) =>
      toView(r, { badge: r.status as string }),
    );
    const todos = rows("notion", {
      where: `${todosForMe(email)} > 0 and ${sinceHours(24 * 30)}`,
      limit: 20,
      order: recent,
      extra: `${todosForMe(email)} n`,
    }).map((r) => toView(r, { badge: `${r.n} to-do${r.n === 1 ? "" : "s"}` }));
    const seen = new Set<number>();
    return [...reviews, ...todos].filter((v: ViewItem) => !seen.has(v.id) && !!seen.add(v.id));
  },
};
