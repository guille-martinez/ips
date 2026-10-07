CREATE TABLE `items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`external_id` text NOT NULL,
	`kind` text NOT NULL,
	`thread_key` text,
	`author` text,
	`participants` text DEFAULT '[]' NOT NULL,
	`title` text,
	`body_text` text,
	`url` text,
	`occurred_at` text NOT NULL,
	`updated_at` text,
	`raw_json` text,
	`ingested_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `items_source_external_id` ON `items` (`source`,`external_id`);--> statement-breakpoint
CREATE INDEX `items_occurred_at` ON `items` (`occurred_at`);--> statement-breakpoint
CREATE INDEX `items_source_occurred_at` ON `items` (`source`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `items_thread_key` ON `items` (`thread_key`);--> statement-breakpoint
CREATE TABLE `people` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text,
	`emails` text DEFAULT '[]' NOT NULL,
	`handles` text DEFAULT '{}' NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_state` (
	`source` text PRIMARY KEY NOT NULL,
	`cursor` text,
	`last_run_at` text,
	`last_ok_at` text,
	`last_error` text
);
