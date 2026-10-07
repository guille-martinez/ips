# Connecting the sources

Do these in any order. After each one, put the value in `.env.local` (copy `.env.example`
first) and run:

```sh
npm run auth:check <source>   # e.g. npm run auth:check linear
```

Every token is **read-only**. If a screen offers write scopes, leave them off.

| Source | What you need | Needs an admin? |
|---|---|---|
| Slack | User token `xoxp-…` | Maybe (see below) |
| Gmail + Calendar + Sheet | Google OAuth desktop client | No, if you can create a GCP project in the opereit.ai org |
| Granola | Personal API key `grn_…` | Business/Enterprise plan |
| Linear | Personal API key `lin_api_…` | No |
| Notion | Internal integration token | Notion workspace owner, to create integrations |
| Attio | Access token | Attio admin |

---

## Slack (user token)

1. Go to https://api.slack.com/apps → **Create New App** → **From scratch**. Name it `IPS
   (read-only)` and pick the Opereit workspace.
2. **OAuth & Permissions** → **User Token Scopes** (not Bot scopes). Add:
   `channels:history`, `groups:history`, `im:history`, `mpim:history`,
   `channels:read`, `groups:read`, `im:read`, `mpim:read`, `users:read`, `users:read.email`.
   (`mpim:read` lists group DMs, and `users:read.email` maps people by email. Both are read-only.)
3. **Install to Workspace** → Allow.
4. Copy the **User OAuth Token** (`xoxp-…`) to `SLACK_USER_TOKEN`.

> ⚠️ **Admin approval:** if Opereit has "Require app approval" turned on (Slack admin →
> Settings & permissions → App management), step 3 becomes "Request to install" and a
> workspace admin must approve it. The DM/history scopes are a common reason for review. If
> you're an admin, approve it yourself.

The token sees what *you* see: your public and private channels, DMs and group DMs.

## Google: Gmail, Calendar and the Superbrain sheet

One OAuth client covers all three.

1. https://console.cloud.google.com → create a project `ips` **inside the opereit.ai
   organisation**.
2. **APIs & Services → Library**: enable the **Gmail API**, the **Google Calendar API** and
   the **Google Sheets API**.
3. **OAuth consent screen** → User type **Internal** → app name `IPS`. Add these scopes:
   `gmail.readonly`, `calendar.readonly` and `spreadsheets.readonly`.
   > ⚠️ Choose **Internal**. An *External* app in "Testing" status expires refresh tokens
   > after 7 days, so the sync would silently stop every week. If you can't pick Internal,
   > tell me and we'll handle it.
4. **Credentials → Create credentials → OAuth client ID → Desktop app**. Copy the client ID
   and secret to `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
5. Run `npm run auth:google` (added with the Gmail connector). It opens the browser once and
   stores the refresh token in `tokens/google.json` (gitignored).
6. In `.env.local`, set `SUPERBRAIN_SHEET_ID` and `SUPERBRAIN_TABS=Daily prios,Readings`.
   Only those tabs are read. **Don't add the Passwords tab.** Better still, move that
   password into a password manager and delete the tab.

## Granola: official API (recommended)

**What I looked at:**
- **Local desktop cache.** It's now encrypted (`cache-v6.json.enc`, and `granola.db` isn't
  plain SQLite), so it's out. It's also undocumented and would break on app updates.
- **The MCP server.** It works (it's connected in Claude Code), but it's built for agents:
  OAuth through a browser, tool-shaped responses, and no clean incremental cursor. Running it
  from a headless worker is awkward.
- **The official REST API** (`https://public-api.granola.ai/v1`). `GET /v1/notes` takes
  `updated_after` with cursor pagination, and `GET /v1/notes/{id}` returns the summary,
  attendees, the calendar event and an optional transcript. A Bearer key, read-only by design.
  ✅ **Use this.**

**Catch:** the API needs a **Business or Enterprise** plan. Steps:
1. In the Granola desktop app, go to **Settings → Connectors → API keys → Create new key**.
   Choose the note scopes (your notes plus shared ones), then **Generate**.
2. Copy the key (`grn_…`) to `GRANOLA_API_KEY`.

If you're not on Business, tell me. The fallback is calling the MCP server from the worker.

Notes include `calendar_event.calendar_event_id`, which is what links a Granola note to its
Calendar event on the Today page.

## Linear

1. Linear → **Settings → Account → Security & access → Personal API keys → New key**.
2. If it offers permissions, pick **Read** only.
3. Copy the key to `LINEAR_API_KEY`.

## Notion

1. https://www.notion.so/profile/integrations → **New integration** → type **Internal** →
   workspace Opereit.
2. **Capabilities**: tick **Read content** only (untick Update and Insert). Under user
   capabilities, pick **Read user information including email addresses**.
3. Copy the **Internal Integration Secret** to `NOTION_TOKEN`.
4. Share pages with it: open each top-level page or database you care about → `•••` →
   **Connections** → add `IPS`. Child pages are included automatically.

## Attio

1. Attio → **Workspace settings → Developers → New access token** (admin only).
2. Set the scopes to **Read** for: Object Configuration, Record, List Configuration, List
   Entry, User Management and Note. Leave everything else **No access**.
3. Copy the token to `ATTIO_API_KEY`.

## Metabase

Out of scope for now. When it comes back: Admin settings → Authentication → API keys,
with a view-only group; set `METABASE_URL` and `METABASE_API_KEY`.

## Keeping the worker running

```sh
npm run sync                       # one pass over every source
./scripts/install-worker.sh        # launchd agent: runs `npm run worker` always-on
tail -f data/worker.log
```

Run the install script from your main checkout, not a worktree. Re-running it reloads the
agent.
