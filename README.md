# IPS

My second brain. Read `docs/BRIEF.md` for the why, and `docs/connect.md` to plug in sources.

```sh
npm install
cp .env.example .env.local     # fill in as you go (docs/connect.md)
npm run seed                   # optional: fake items so the UI isn't empty
npm run dev                    # http://127.0.0.1:3000 (localhost only)
npm run sync                   # run every connector once
npm run worker                 # loop every 5 min (install: ./scripts/install-worker.sh)
npm run auth:check [source]    # verify credentials
npm run seed -- --clear        # remove fake items
npm test
```

Layout:
- `src/db/schema.ts`: `items`, `people` and `sync_state` (Drizzle, SQLite plus FTS5).
  Migrations live in `drizzle/` and are applied automatically on open.
- `src/connectors/`: one file per source, implementing `Connector` (`types.ts`).
- `src/lib/readonly-http.ts`: the only HTTP client connectors may use. GET, allow-listed
  read POSTs and GraphQL queries only.
- `src/sync/run.ts`: runs connectors, pages through them, upserts and records state/errors.
- `worker/`: `npm run sync` / `npm run worker`.
- `src/app/`: the Next.js pages (`/sources`, `/feed`).
