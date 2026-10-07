// Fake data so the UI can be built before connectors exist.
// Usage: npm run seed            (insert fake items for every source)
//        npm run seed -- --clear (delete all fake items)
// Fake items have external_id starting with "fake-" so they never collide with real ones.
import "@/lib/load-env";
import { like } from "drizzle-orm";
import { getDb } from "@/db/client";
import { items, SOURCES, type Kind, type Source } from "@/db/schema";
import { upsertItems } from "@/sync/run";
import type { NewItem } from "@/connectors/types";

const db = getDb();

if (process.argv.includes("--clear")) {
  const res = db.delete(items).where(like(items.externalId, "fake-%")).run();
  console.log(`deleted ${res.changes} fake items`);
  process.exit(0);
}

const people = [
  { name: "Martina Navarro", email: "martina@example.com", handle: "@martina" },
  { name: "Miquel Berenguer", email: "miquel@example.com", handle: "@miquel" },
  { name: "Oceane Landes", email: "oceane@example.com", handle: "@oceane" },
  { name: "Julio Ruiz", email: "julio@example.com", handle: "@julio" },
];

const kindBySource: Record<Source, Kind> = {
  slack: "message",
  gmail: "email",
  calendar: "event",
  granola: "note",
  linear: "issue",
  notion: "page",
  attio: "record",
  sheets: "record",
};

const topics = [
  "UPS claims without claim number",
  "GLS refunds for Nude",
  "Padel Nuestro UPS accounts",
  "August invoicing",
  "Ops weekly cadence",
  "DHL Express onboarding",
  "Hiring: ops analyst pipeline",
  "Amphora DHL Parcel refile",
];

const now = Date.now();
const today = new Date();
today.setHours(0, 0, 0, 0);
const at = (h: number, m = 0) => new Date(today.getTime() + (h * 60 + m) * 60_000).toISOString();

// Raw shapes mimic what each real connector stores, so the views (src/views/*) work on fake data.
function rawFor(source: Source, i: number, topic: string): { raw: unknown; occurredAt?: string; title?: string } {
  switch (source) {
    case "sheets": {
      const status = ["Pending", "WIP", "Done", "Pending", "Blocked", "Done", "Review"][i % 7];
      const deadline = i % 3 === 0 ? new Date(now + (i - 4) * 86_400_000).toISOString().slice(0, 10) : null;
      return i < 9
        ? { raw: { fake: true, tab: "Daily prios", status, deadline } }
        : { raw: { fake: true, tab: "Readings", status: "Pending" }, title: `[fake] Reading: ${topic}` };
    }
    case "linear": {
      const state = [{ name: "In Progress", type: "started" }, { name: "Todo", type: "unstarted" }, { name: "Done", type: "completed" }][i % 3];
      return { raw: { fake: true, identifier: `ENG-${900 + i}`, state, assignee: { isMe: i % 2 === 0 }, dueDate: i === 0 ? new Date(now).toISOString().slice(0, 10) : null } };
    }
    case "gmail":
      return { raw: { fake: true, labelIds: i % 3 === 0 ? ["INBOX", "UNREAD"] : ["INBOX"] } };
    case "slack":
      return { raw: { fake: true, channel_type: i % 4 === 0 ? "im" : "channel", channel_name: i % 4 === 0 ? null : "#deployment" } };
    case "calendar": {
      if (i >= 5) return { raw: { fake: true } };
      const start = [9, 10.5, 12, 15, 17][i];
      const s = at(Math.floor(start), (start % 1) * 60);
      return { occurredAt: s, raw: { fake: true, end: { dateTime: new Date(new Date(s).getTime() + 45 * 60_000).toISOString() } } };
    }
    default:
      return { raw: { fake: true } };
  }
}

let n = 0;
let total = 0;
for (const source of SOURCES) {
  const real = db.$client.prepare("select count(*) n from items where source = ? and external_id not like 'fake-%'").get(source) as { n: number };
  if (real.n > 0) {
    console.log(`skip ${source}: has real data`);
    n++;
    continue;
  }
  const batch: NewItem[] = [];
  for (let i = 0; i < 12; i++) {
    const p = people[(i + n) % people.length];
    const topic = topics[(i * 3 + n) % topics.length];
    const ts = new Date(now - (i * 7 + n) * 3600_000).toISOString();
    const extra = rawFor(source, i, topic);
    batch.push({
      externalId: `fake-${source}-${i}`,
      kind: kindBySource[source],
      threadKey: `fake-thread-${source}-${i}`,
      author: p.name,
      participants: [p, people[(i + 1) % people.length]],
      title: extra.title ?? `[fake] ${topic}`,
      bodyText: `Fake ${source} ${kindBySource[source]} about ${topic.toLowerCase()}. Replace by running real connectors.`,
      url: null,
      occurredAt: extra.occurredAt ?? ts,
      updatedAt: ts,
      raw: extra.raw,
    });
  }
  total += upsertItems(db, source, batch);
  n++;
}
console.log(`seeded ${total} fake items`);
