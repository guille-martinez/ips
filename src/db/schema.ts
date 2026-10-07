import { sqliteTable, text, integer, uniqueIndex, index } from "drizzle-orm/sqlite-core";

/**
 * Portability notes (SQLite now, Postgres later):
 * - Timestamps are ISO-8601 UTC strings ("2026-10-07T09:30:00.000Z"). They sort
 *   lexically and map 1:1 to timestamptz.
 * - JSON columns are text in SQLite and become jsonb in Postgres.
 * - Full-text search lives in a separate FTS5 table (see drizzle/*_fts.sql).
 *   In Postgres it becomes a tsvector column + GIN index.
 */

export const SOURCES = [
  "slack",
  "gmail",
  "calendar",
  "granola",
  "linear",
  "notion",
  "attio",
  "metabase",
  "sheets",
] as const;
export type Source = (typeof SOURCES)[number];

export const KINDS = [
  "message",
  "email",
  "event",
  "note",
  "issue",
  "page",
  "record",
  "dashboard",
] as const;
export type Kind = (typeof KINDS)[number];

export type Participant = { name?: string; email?: string; handle?: string };

/** Raw facts from every source. Upserted on (source, external_id). Never edited by hand. */
export const items = sqliteTable(
  "items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    source: text("source").$type<Source>().notNull(),
    externalId: text("external_id").notNull(),
    kind: text("kind").$type<Kind>().notNull(),
    threadKey: text("thread_key"),
    author: text("author"),
    participants: text("participants", { mode: "json" }).$type<Participant[]>().notNull().default([]),
    title: text("title"),
    bodyText: text("body_text"),
    url: text("url"),
    occurredAt: text("occurred_at").notNull(),
    updatedAt: text("updated_at"),
    rawJson: text("raw_json", { mode: "json" }).$type<unknown>(),
    ingestedAt: text("ingested_at").notNull(),
  },
  (t) => [
    uniqueIndex("items_source_external_id").on(t.source, t.externalId),
    index("items_occurred_at").on(t.occurredAt),
    index("items_source_occurred_at").on(t.source, t.occurredAt),
    index("items_thread_key").on(t.threadKey),
  ],
);

/** Light identity map so one person matches across Slack, email, Linear and Attio. */
export const people = sqliteTable("people", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name"),
  emails: text("emails", { mode: "json" }).$type<string[]>().notNull().default([]),
  // e.g. { slack: "U123", linear: "uuid", attio: "uuid" }
  handles: text("handles", { mode: "json" }).$type<Record<string, string>>().notNull().default({}),
  updatedAt: text("updated_at").notNull(),
});

export const syncState = sqliteTable("sync_state", {
  source: text("source").$type<Source>().primaryKey(),
  cursor: text("cursor"),
  lastRunAt: text("last_run_at"),
  lastOkAt: text("last_ok_at"),
  lastError: text("last_error"),
});

/*
 * Later phases (not built in v1, don't block them):
 *
 * tasks:    id, title, owner (person id), waiting_on (person id, nullable),
 *           project_id (nullable), status, source_item_id (-> items.id), due_at, created_at
 * projects: id, name, role ('executor' | 'advisor'), context_md (Claude-maintained:
 *           summary, decisions, open loops, risks, last verified), created_at, updated_at
 * actions:  id, kind (slack_reply | email_draft | linear_create | ...), payload_json,
 *           status ('proposed' -> 'approved' -> 'executed' | 'rejected'), item_id,
 *           proposed_at, approved_at, executed_at, result_json
 */
