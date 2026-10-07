import { sql } from "drizzle-orm";
import type { DB } from "@/db/client";
import { items, syncState, type Source } from "@/db/schema";
import { connectors } from "@/connectors";
import type { NewItem } from "@/connectors/types";
import { redact } from "@/lib/redact";

const MAX_PAGES_PER_RUN = 50;
const running = new Set<Source>();

export type RunOutcome = { source: Source; status: "ok" | "skipped" | "error" | "busy"; upserted: number; message?: string };

/** Every timestamp is stored as ISO UTC ("…Z") so they sort and compare as plain strings. */
function utc(iso: string): string;
function utc(iso: string | null | undefined): string | null;
function utc(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid timestamp from connector: ${iso}`);
  return d.toISOString();
}

export function upsertItems(db: DB, source: Source, batch: NewItem[], now = new Date().toISOString()): number {
  if (!batch.length) return 0;
  const rows = batch.map((i) => ({
    source,
    externalId: i.externalId,
    kind: i.kind,
    threadKey: i.threadKey ?? null,
    author: i.author ?? null,
    participants: i.participants ?? [],
    title: i.title ?? null,
    bodyText: i.bodyText ?? null,
    url: i.url ?? null,
    occurredAt: utc(i.occurredAt),
    updatedAt: utc(i.updatedAt),
    rawJson: i.raw ?? null,
    ingestedAt: now,
  }));
  db.insert(items)
    .values(rows)
    .onConflictDoUpdate({
      target: [items.source, items.externalId],
      set: {
        kind: sql`excluded.kind`,
        threadKey: sql`excluded.thread_key`,
        author: sql`excluded.author`,
        participants: sql`excluded.participants`,
        title: sql`excluded.title`,
        bodyText: sql`excluded.body_text`,
        url: sql`excluded.url`,
        occurredAt: sql`excluded.occurred_at`,
        updatedAt: sql`excluded.updated_at`,
        rawJson: sql`excluded.raw_json`,
        ingestedAt: sql`excluded.ingested_at`,
      },
    })
    .run();
  return rows.length;
}

function saveState(db: DB, source: Source, patch: Partial<typeof syncState.$inferInsert>) {
  db.insert(syncState)
    .values({ source, ...patch })
    .onConflictDoUpdate({ target: syncState.source, set: patch })
    .run();
}

export async function runSource(db: DB, source: Source): Promise<RunOutcome> {
  const connector = connectors[source];
  if (running.has(source)) return { source, status: "busy", upserted: 0 };
  running.add(source);
  const startedAt = new Date().toISOString();
  let upserted = 0;
  try {
    const cfg = connector.configured();
    if (!cfg.ok) {
      saveState(db, source, { lastRunAt: startedAt, lastError: `Not configured: ${cfg.reason}` });
      return { source, status: "skipped", upserted, message: cfg.reason };
    }
    saveState(db, source, { lastRunAt: startedAt });
    let cursor = db.select().from(syncState).where(sql`${syncState.source} = ${source}`).get()?.cursor ?? null;

    for (let page = 0; page < MAX_PAGES_PER_RUN; page++) {
      const res = await connector.sync(cursor);
      db.transaction((tx) => {
        upserted += upsertItems(tx as unknown as DB, source, res.items);
        saveState(tx as unknown as DB, source, { cursor: res.nextCursor });
      });
      cursor = res.nextCursor;
      if (!res.hasMore) break;
    }
    saveState(db, source, { lastOkAt: new Date().toISOString(), lastError: null });
    return { source, status: "ok", upserted };
  } catch (err) {
    const message = redact(err instanceof Error ? err.message : String(err)).slice(0, 500);
    saveState(db, source, { lastError: message });
    return { source, status: "error", upserted, message };
  } finally {
    running.delete(source);
  }
}

export async function runAll(db: DB): Promise<RunOutcome[]> {
  // Sources are independent; run them concurrently.
  return Promise.all((Object.keys(connectors) as Source[]).map((s) => runSource(db, s)));
}
