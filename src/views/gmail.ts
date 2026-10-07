import type { SourceView } from "./types";
import { count, rows, sinceHours, toView } from "./helpers";

// Expects raw = Gmail message (format=full): { labelIds: [...] }.
const UNREAD_INBOX = `exists (select 1 from json_each(raw_json,'$.labelIds') where value = 'UNREAD')
  and exists (select 1 from json_each(raw_json,'$.labelIds') where value = 'INBOX')`;

export const gmailView: SourceView = {
  source: "gmail",
  title: "Gmail",
  tile: () => ({
    stats: [
      { label: "unread", value: count("gmail", UNREAD_INBOX) },
      { label: "24h", value: count("gmail", sinceHours(24)) },
    ],
    items: rows("gmail").map((r) => toView(r)),
  }),
  pending: () => rows("gmail", { where: `${UNREAD_INBOX} and ${sinceHours(24 * 7)}`, limit: 15 }).map((r) => toView(r, { badge: "unread" })),
};
