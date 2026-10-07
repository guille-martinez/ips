-- Full-text search over items (external-content FTS5, kept in sync by triggers).
-- Postgres port: replace with a generated tsvector column + GIN index.
CREATE VIRTUAL TABLE `items_fts` USING fts5(
  title, body_text, author, participants,
  content='items', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
);
--> statement-breakpoint
CREATE TRIGGER `items_fts_ai` AFTER INSERT ON `items` BEGIN
  INSERT INTO items_fts(rowid, title, body_text, author, participants)
  VALUES (new.id, new.title, new.body_text, new.author, new.participants);
END;
--> statement-breakpoint
CREATE TRIGGER `items_fts_ad` AFTER DELETE ON `items` BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, body_text, author, participants)
  VALUES ('delete', old.id, old.title, old.body_text, old.author, old.participants);
END;
--> statement-breakpoint
CREATE TRIGGER `items_fts_au` AFTER UPDATE ON `items` BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, body_text, author, participants)
  VALUES ('delete', old.id, old.title, old.body_text, old.author, old.participants);
  INSERT INTO items_fts(rowid, title, body_text, author, participants)
  VALUES (new.id, new.title, new.body_text, new.author, new.participants);
END;
