import type { SourceView } from "./types";
import { count, rows, sinceHours, toView } from "./helpers";

// Expects raw = Gmail message (format=full, part bodies stripped): { labelIds: [...], payload: { headers: [...] } }.
const has = (label: string) => `exists (select 1 from json_each(raw_json,'$.labelIds') where value = '${label}')`;
const UNREAD_INBOX = `${has("UNREAD")} and ${has("INBOX")}`;

// Rule-based noise filter for Pending: newsletters, notifications, Gmail's bulk categories and
// Google Calendar notifications (invites/accepts/declines; the Calendar source already has those).
const BULK = `(exists (select 1 from json_each(raw_json,'$.payload.headers') where lower(json_extract(value,'$.name')) in ('list-unsubscribe','list-id'))
  or exists (select 1 from json_each(raw_json,'$.labelIds') where value in ('CATEGORY_PROMOTIONS','CATEGORY_SOCIAL','CATEGORY_UPDATES','CATEGORY_FORUMS'))
  or exists (select 1 from json_each(raw_json,'$.payload.headers') where lower(json_extract(value,'$.name')) = 'from'
    and lower(json_extract(value,'$.value')) glob '*no*reply*')
  or exists (select 1 from json_each(raw_json,'$.payload.headers') where lower(json_extract(value,'$.name')) = 'sender'
    and lower(json_extract(value,'$.value')) glob '*calendar-notification@google.com*'))`;

export const gmailView: SourceView = {
  source: "gmail",
  title: "Gmail",
  tile: () => ({
    stats: [
      { label: "unread", value: count("gmail", `${UNREAD_INBOX} and not ${BULK}`) },
      { label: "24h", value: count("gmail", sinceHours(24)) },
    ],
    items: rows("gmail", { where: `${has("INBOX")} and not ${BULK}` }).map((r) => toView(r)),
  }),
  pending: () =>
    rows("gmail", { where: `${UNREAD_INBOX} and not ${BULK} and ${sinceHours(24 * 7)}`, limit: 15 }).map((r) => toView(r, { badge: "unread" })),
};
