import type { Kind, Participant, Source } from "@/db/schema";

/** What a connector emits. The runner adds ingested_at and upserts on (source, externalId). */
export type NewItem = {
  externalId: string;
  kind: Kind;
  threadKey?: string | null;
  author?: string | null;
  participants?: Participant[];
  title?: string | null;
  bodyText?: string | null;
  url?: string | null;
  occurredAt: string; // ISO-8601 UTC
  updatedAt?: string | null;
  raw: unknown;
};

export type AuthResult =
  | { ok: true; identity: string } // e.g. "guillermo@opereit.ai on workspace Opereit"
  | { ok: false; error: string };

export type SyncResult = {
  items: NewItem[];
  /** Persisted after every page, so a crash resumes from the last good page. */
  nextCursor: string | null;
  /** True if the runner should call sync(nextCursor) again right away. */
  hasMore?: boolean;
};

export interface Connector {
  source: Source;
  label: string;
  /** Cheap, offline: are the required env vars / token files present? */
  configured(): { ok: true } | { ok: false; reason: string };
  /** One read-only call that proves the credentials work. */
  checkAuth(): Promise<AuthResult>;
  /** Pull one page of changes since `cursor` (null = first run / backfill). */
  sync(cursor: string | null): Promise<SyncResult>;
}

/** Helper for connectors that only need env vars. */
export function requireEnv(...names: string[]): { ok: true } | { ok: false; reason: string } {
  const missing = names.filter((n) => !process.env[n]);
  return missing.length ? { ok: false, reason: `Missing ${missing.join(", ")} in .env.local` } : { ok: true };
}

export function backfillSince(): Date {
  const days = Number(process.env.IPS_BACKFILL_DAYS ?? 30);
  return new Date(Date.now() - days * 24 * 3600 * 1000);
}
