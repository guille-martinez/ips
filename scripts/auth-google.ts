// Usage: npm run auth:google
// One-time OAuth (desktop client, loopback + PKCE). Opens the browser, then stores the
// refresh token in tokens/google.json (gitignored, mode 600). Requests read-only scopes only.
import "@/lib/load-env";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFile } from "node:child_process";
import { GOOGLE_SCOPES, oauthClient, TOKEN_PATH, type StoredToken } from "@/lib/google-auth";
import { redact } from "@/lib/redact";

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error("✗ Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.local first (see docs/connect.md).");
  process.exit(1);
}

const verifier = crypto.randomBytes(48).toString("base64url");
const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
const state = crypto.randomBytes(16).toString("hex");

const server = http.createServer();
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
const redirectUri = `http://127.0.0.1:${port}`;

const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: "code",
  scope: GOOGLE_SCOPES.join(" "),
  access_type: "offline",
  prompt: "consent", // always return a refresh token
  code_challenge: challenge,
  code_challenge_method: "S256",
  state,
}).toString();

console.log("Opening the browser for Google sign-in. If it doesn't open, visit:\n" + authUrl.toString());
execFile("open", [authUrl.toString()], () => {});

const code = await new Promise<string>((resolve, reject) => {
  server.on("request", (req, res) => {
    const u = new URL(req.url ?? "/", redirectUri);
    if (u.pathname !== "/") return res.writeHead(404).end();
    const err = u.searchParams.get("error");
    const c = u.searchParams.get("code");
    const ok = !err && c && u.searchParams.get("state") === state;
    res.writeHead(ok ? 200 : 400, { "content-type": "text/plain" }).end(ok ? "IPS is connected to Google. You can close this tab." : "Sign-in failed. Check the terminal.");
    if (ok) resolve(c);
    else reject(new Error(err ?? "state mismatch or missing code"));
  });
});
server.close();

try {
  const tok = await oauthClient().postRead<{ refresh_token?: string; scope?: string }>("/token", {
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
    code_verifier: verifier,
  });
  if (!tok.refresh_token) throw new Error("Google returned no refresh token. Remove IPS from your Google account's third-party access and retry.");
  const granted = (tok.scope ?? "").split(" ").filter(Boolean);
  const unexpected = granted.filter((s) => !GOOGLE_SCOPES.includes(s) && !/^(openid|email|profile)$|userinfo/.test(s));
  if (unexpected.length) throw new Error(`Unexpected scopes granted: ${unexpected.join(", ")}. Refusing to store a token beyond read-only.`);

  const stored: StoredToken = { refresh_token: tok.refresh_token, scope: tok.scope, created_at: new Date().toISOString() };
  fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(stored, null, 2), { mode: 0o600 });
  console.log(`✓ Saved refresh token to ${path.relative(process.cwd(), TOKEN_PATH)}. Next: npm run auth:check gmail calendar sheets`);
} catch (e) {
  console.error(`✗ ${redact(e instanceof Error ? e.message : String(e))}`);
  process.exit(1);
}
