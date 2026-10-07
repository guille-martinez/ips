# Phase 2: one agent per connector

Phase 1 is done: the schema, the runner, the worker, the dashboard (`/`) with Today, Pending
and one tile per source, the source deep-dives (`/s/<source>`), the Everything feed and the
Sources page. **Granola is already real**: use `src/connectors/granola.ts` +
`tests/granola.test.ts` as the reference implementation.

The other connectors are stubs in `src/connectors/<source>.ts`. Run one Orca agent per row
below, each in its own worktree. The three Google sources share an OAuth helper, so one agent
does all of them.

Each agent owns **two** things for its source:
1. the connector (`src/connectors/<source>.ts`), and
2. its view (`src/views/<source>.ts`): the tile stats, the tile items and the `pending()`
   rules that feed the dashboard's Pending panel. Some views already exist and read specific
   `raw_json` fields (listed below). Either store raw that way, or adapt the view.

| Agent | Files it owns |
|---|---|
| slack | `src/connectors/slack.ts`, `src/views/slack.ts`, `tests/slack.test.ts`, `tests/fixtures/slack/` |
| google | `src/connectors/{gmail,calendar,sheets}.ts`, `src/views/{gmail,sheets}.ts` (+ a calendar view if useful), `src/lib/google-auth.ts`, `scripts/auth-google.ts`, tests and fixtures |
| linear | `src/connectors/linear.ts`, `src/views/linear.ts`, tests and fixtures |
| notion | `src/connectors/notion.ts`, `src/views/notion.ts` (new, register in `src/views/index.ts`), tests and fixtures |
| attio | `src/connectors/attio.ts`, `src/views/attio.ts` (new, register in `src/views/index.ts`), tests and fixtures |
| metabase | `src/connectors/metabase.ts`, `src/views/metabase.ts` (new, register in `src/views/index.ts`), tests and fixtures |

Agents should only touch their own files (registering a view in `src/views/index.ts` is a
one-line change and fine). The shared files (`schema.ts`, `run.ts`,
`readonly-http.ts`, `package.json`) stay unchanged. If one really needs a change, say so
in the PR. The google agent is the only one that adds a dependency (`googleapis` or raw
fetch, its choice) and an npm script (`auth:google`).

## Prompt template

> Read `CLAUDE.md`, `docs/BRIEF.md` and `docs/connect.md` (section **<SOURCE>**). Replace the
> stub in `src/connectors/<source>.ts` with a real `Connector` (see `src/connectors/types.ts`).
>
> Rules:
> - Every HTTP call goes through `createReadOnlyClient` (`src/lib/readonly-http.ts`). No
>   other fetch calls, and no SDK methods that write.
> - `checkAuth()` makes one cheap read call and returns who you are.
> - `sync(cursor)` returns one page. Set `hasMore: true` while there are more pages, and put
>   your state in `nextCursor`; if you need several fields, JSON-stringify them. A `null`
>   cursor means first run: backfill from `backfillSince()` (default 30 days).
> - Map into `NewItem`. `externalId` is stable and unique per source, `occurredAt` is ISO
>   UTC, `url` deep-links to the original, `participants` carry emails or handles when
>   known, and `raw` holds the API object as-is.
> - Never log item contents or tokens.
> - Tests: record real responses into `tests/fixtures/<source>/*.json`, **scrub** tokens,
>   emails and names you don't need, then test `sync()` against them with an injected
>   `fetchImpl`. Cover first run, incremental run and pagination.
> - Timestamps can carry any offset; the runner normalises them to UTC.
> - Update `src/views/<source>.ts` so the tile and `pending()` work on real data (rule-based,
>   no LLM). Then delete the fake rows: `npm run seed -- --clear`.
> - Done = `npm run typecheck && npm test` pass, `npm run auth:check <source>` prints ✓, and
>   after `npm run sync` your tile on `/` shows real data and your Pending rules make sense.
> - Real data shapes: the Claude Code MCP for this source is connected, so use it (read-only
>   tools only) to look at real payloads before writing the mapping.

## Per-connector notes

- **slack**: kind `message`. Use `conversations.list` (types public, private, im, mpim) and
  `conversations.history` with `oldest` = the last seen ts for each channel; keep a map
  `{channelId: latestTs}` in the cursor. Thread replies: `conversations.replies` for
  messages with `reply_count`. `threadKey` = `channel:thread_ts`. The view expects `raw.channel_type`
  (`im` | `mpim` | `channel` | `group`) and `raw.channel_name`, so add those to raw. Resolve user names with
  `users.list`, cached per run. URL:
  `https://opereit.slack.com/archives/<channel>/p<ts without dot>`. Watch tier-3 rate limits.
- **google / gmail**: kind `email`. First run uses `messages.list` with `q=newer_than:30d`,
  then save `historyId`. Later runs use `history.list?startHistoryId=…`. On a 404 (expired
  history), fall back to the full window. Take `format=full`, convert the text/plain part
  into `bodyText`, and cap it at about 20k characters. `threadKey` = threadId. URL:
  `https://mail.google.com/mail/u/0/#all/<threadId>`. The view reads `raw.labelIds`
  (UNREAD + INBOX = pending).
- **google / calendar**: kind `event`, primary calendar. On first run use `timeMin` = 30
  days ago and `singleEvents=true`, then use `nextSyncToken`; on a 410, resync. Put the
  attendees' emails in `participants`. **`threadKey` = the event `id`**: Granola's
  `calendar_event_id` is that same Google id, and the Today panel joins on it.
  The Today panel reads `raw.end.dateTime`. Skip declined and cancelled events.
- **google / sheets**: kind `record`. Read only the tabs in `SUPERBRAIN_TABS` with
  `values.get`. The sheet is small, so take a full snapshot each run (no cursor).
  `externalId` = `<tab>:<first-column text>`, falling back to the row number. Tasks:
  title = Priority, author = Owner. raw = `{ tab, status, deadline (YYYY-MM-DD; the sheet
  uses D/M/YY), owner, link }`, which is what `src/views/sheets.ts` reads.
  Readings: title = Name, url = Link, raw = `{ tab: "Readings", status }`. **Never request a range outside the allow-listed tabs.**
- **linear**: kind `issue`. GraphQL `issues(filter: {updatedAt: {gt: $since}}, orderBy:
  updatedAt, first: 100, after: $cursor)`. Include state `{name, type}`, assignee `{id, name, isMe}`,
  dueDate, priority, team, project and the identifier in raw. title = `ENG-123 Title`. The
  view's Pending rule is: assigned to me and state.type in started/unstarted/triage.
- **notion**: kind `page`. `POST /v1/search` (allow-list it) with sort
  `last_edited_time desc`; stop once you reach pages older than the cursor. bodyText =
  the title plus the first level of blocks as plain text (`GET /v1/blocks/{id}/children`),
  capped.
- **attio**: kind `record`. Companies and deals (plus people if cheap):
  `POST /v2/objects/{obj}/records/query` (allow-list it), sorted by updated time. Include
  notes if the scope allows.
- **metabase**: kind `dashboard`. `GET /api/dashboard` and `GET /api/card`; there's no
  updated_since filter, so take a full snapshot and compare `updated_at`. Optional
  read-only runs of saved questions come later. Don't run them in sync.
