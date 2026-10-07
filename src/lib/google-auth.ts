import fs from "node:fs";
import path from "node:path";
import { createReadOnlyClient, type ReadOnlyClient } from "@/lib/readonly-http";
import { requireEnv } from "@/connectors/types";

// One OAuth desktop client covers Gmail, Calendar and the Superbrain sheet.
// `npm run auth:google` stores the refresh token in tokens/google.json (gitignored).
// We use raw REST through the read-only client instead of `googleapis`, so no SDK write method is reachable.

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/spreadsheets.readonly",
];

export const TOKEN_PATH = path.resolve(process.env.IPS_GOOGLE_TOKEN_PATH ?? "tokens/google.json");

export type StoredToken = { refresh_token: string; scope?: string; created_at?: string };
type TokenResponse = { access_token: string; expires_in: number; refresh_token?: string; scope?: string };

/** The token endpoint is the only POST we make to Google: it mints credentials, it writes no data. */
export function oauthClient(fetchImpl?: typeof fetch): ReadOnlyClient {
  return createReadOnlyClient({ baseUrl: "https://oauth2.googleapis.com", headers: () => ({}), readPosts: [/^\/token$/], fetchImpl });
}

export function googleConfigured(...extraEnv: string[]): { ok: true } | { ok: false; reason: string } {
  const env = requireEnv("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", ...extraEnv);
  if (!env.ok) return env;
  if (!fs.existsSync(TOKEN_PATH)) return { ok: false, reason: "No Google refresh token yet: run npm run auth:google" };
  return { ok: true };
}

export type TokenProvider = () => Promise<string>;

/** Access tokens live ~1h. Cache one per process and refresh a minute before expiry. */
export function makeTokenProvider(fetchImpl?: typeof fetch, tokenPath = TOKEN_PATH): TokenProvider {
  let cached: { token: string; expiresAt: number } | null = null;
  return async () => {
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    const stored = JSON.parse(fs.readFileSync(tokenPath, "utf8")) as StoredToken;
    const res = await oauthClient(fetchImpl).postRead<TokenResponse>("/token", {
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: stored.refresh_token,
      grant_type: "refresh_token",
    });
    cached = { token: res.access_token, expiresAt: Date.now() + res.expires_in * 1000 };
    return cached.token;
  };
}

const sharedProvider = makeTokenProvider();

export type GoogleDeps = { fetchImpl?: typeof fetch; getToken?: TokenProvider };

export function googleApi(baseUrl: string, deps: GoogleDeps = {}): ReadOnlyClient {
  const getToken = deps.getToken ?? sharedProvider;
  return createReadOnlyClient({
    baseUrl,
    headers: async () => ({ authorization: `Bearer ${await getToken()}` }),
    fetchImpl: deps.fetchImpl,
  });
}
