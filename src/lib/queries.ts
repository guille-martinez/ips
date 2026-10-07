import { and, desc, eq, gte, lte, sql, count, max } from "drizzle-orm";
import { getDb } from "@/db/client";
import { items, syncState, SOURCES, type Source } from "@/db/schema";
import { connectors } from "@/connectors";

export type SourceRow = {
  source: Source;
  label: string;
  configured: boolean;
  reason?: string;
  itemCount: number;
  latestItemAt: string | null;
  lastRunAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
};

export function getSources(): SourceRow[] {
  const db = getDb();
  const counts = new Map(
    db.select({ source: items.source, n: count(), latest: max(items.occurredAt) }).from(items).groupBy(items.source).all().map((r) => [r.source, r]),
  );
  const states = new Map(db.select().from(syncState).all().map((s) => [s.source, s]));
  return SOURCES.map((source) => {
    const c = connectors[source];
    const cfg = c.configured();
    const st = states.get(source);
    return {
      source,
      label: c.label,
      configured: cfg.ok,
      reason: cfg.ok ? undefined : cfg.reason,
      itemCount: counts.get(source)?.n ?? 0,
      latestItemAt: counts.get(source)?.latest ?? null,
      lastRunAt: st?.lastRunAt ?? null,
      lastOkAt: st?.lastOkAt ?? null,
      lastError: st?.lastError ?? null,
    };
  });
}

export type FeedFilters = { source?: string; person?: string; from?: string; to?: string; q?: string; limit?: number };

/** Turns free text into a safe FTS5 query: every word becomes a quoted prefix term (AND-ed). */
export function toFtsQuery(q: string): string | null {
  const terms = q.match(/[\p{L}\p{N}_@.-]+/gu) ?? [];
  return terms.length ? terms.map((t) => `"${t.replace(/"/g, "")}"*`).join(" ") : null;
}

export function getFeed(f: FeedFilters) {
  const db = getDb();
  const where = [];
  if (f.source && (SOURCES as readonly string[]).includes(f.source)) where.push(eq(items.source, f.source as Source));
  if (f.from) where.push(gte(items.occurredAt, new Date(f.from).toISOString()));
  if (f.to) where.push(lte(items.occurredAt, new Date(new Date(f.to).getTime() + 86_400_000 - 1).toISOString()));
  if (f.person) {
    const like = `%${f.person.toLowerCase()}%`;
    where.push(sql`(lower(${items.author}) like ${like} or lower(${items.participants}) like ${like})`);
  }
  const fts = f.q ? toFtsQuery(f.q) : null;
  if (fts) where.push(sql`${items.id} in (select rowid from items_fts where items_fts match ${fts})`);

  return db
    .select({
      id: items.id,
      source: items.source,
      kind: items.kind,
      author: items.author,
      title: items.title,
      bodyText: sql<string | null>`substr(${items.bodyText}, 1, 400)`,
      url: items.url,
      occurredAt: items.occurredAt,
    })
    .from(items)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(items.occurredAt))
    .limit(f.limit ?? 200)
    .all();
}

export function healthState(r: SourceRow): "ok" | "error" | "off" | "never" {
  if (!r.configured) return "off";
  if (r.lastError) return "error";
  if (r.lastOkAt) return "ok";
  return "never";
}
