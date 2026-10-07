import type { Source } from "@/db/schema";

/** A row shown on a tile or in the Pending strip. Same shape across every source. */
export type ViewItem = {
  id: number;
  source: Source;
  title: string;
  subtitle?: string | null;
  url?: string | null;
  at: string; // ISO UTC
  badge?: string | null; // e.g. "WIP", "DM", "unread", "ENG-981"
  due?: string | null;
};

export type Tile = {
  stats: { label: string; value: number | string }[];
  items: ViewItem[];
};

/**
 * Per-source presentation. Lives next to the connector conceptually: each phase-2
 * agent owns src/views/<source>.ts and adapts it to the raw shape its connector stores.
 */
export interface SourceView {
  source: Source;
  /** Short title shown on the tile. */
  title: string;
  tile(): Tile;
  /** Things that need me (rule-based, no LLM). Feeds the "Pending" panel. */
  pending?(): ViewItem[];
}
