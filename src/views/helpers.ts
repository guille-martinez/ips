import { getDb } from "@/db/client";
import type { Source } from "@/db/schema";
import type { SourceView, ViewItem } from "./types";

type Row = { id: number; source: Source; title: string | null; author: string | null; url: string | null; occurred_at: string };

/** Plain SQL over items. `where` may use json_extract(raw_json, '$.…') against the source's raw shape. */
export function rows(source: Source, opts: { where?: string; order?: string; limit?: number; extra?: string } = {}) {
  const sql = `select id, source, title, author, url, occurred_at${opts.extra ? `, ${opts.extra}` : ""}
    from items where source = ? ${opts.where ? `and (${opts.where})` : ""}
    order by ${opts.order ?? "occurred_at desc"} limit ${opts.limit ?? 5}`;
  return getDb().$client.prepare(sql).all(source) as (Row & Record<string, unknown>)[];
}

export function count(source: Source, where?: string): number {
  const r = getDb().$client.prepare(`select count(*) n from items where source = ? ${where ? `and (${where})` : ""}`).get(source) as { n: number };
  return r.n;
}

export const sinceHours = (h: number) => `occurred_at >= '${new Date(Date.now() - h * 3600_000).toISOString()}'`;

export function toView(r: Row, extra: Partial<ViewItem> = {}): ViewItem {
  return { id: r.id, source: r.source, title: r.title || "(untitled)", subtitle: r.author, url: r.url, at: r.occurred_at, ...extra };
}

/** Default tile for sources without a custom view: activity counts + latest items. */
export function genericView(source: Source, title: string): SourceView {
  return {
    source,
    title,
    tile: () => ({
      stats: [
        { label: "24h", value: count(source, sinceHours(24)) },
        { label: "7d", value: count(source, sinceHours(24 * 7)) },
      ],
      items: rows(source).map((r) => toView(r)),
    }),
  };
}

export function todayBounds(): { start: string; end: string } {
  const s = new Date();
  s.setHours(0, 0, 0, 0);
  const e = new Date(s.getTime() + 86_400_000);
  return { start: s.toISOString(), end: e.toISOString() };
}
