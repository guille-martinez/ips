import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { makeTokenProvider } from "@/lib/google-auth";

it("refreshes the access token once and caches it until near expiry", async () => {
  process.env.GOOGLE_CLIENT_ID = "cid";
  process.env.GOOGLE_CLIENT_SECRET = "csecret";
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ips-")), "google.json");
  fs.writeFileSync(file, JSON.stringify({ refresh_token: "1//rt" }));
  const fetchImpl = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
    expect(String(url)).toBe("https://oauth2.googleapis.com/token");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ client_id: "cid", client_secret: "csecret", refresh_token: "1//rt", grant_type: "refresh_token" });
    return new Response(JSON.stringify({ access_token: "ya29.a", expires_in: 3599 }), { status: 200 });
  }) as unknown as typeof fetch;

  const get = makeTokenProvider(fetchImpl, file);
  expect(await get()).toBe("ya29.a");
  expect(await get()).toBe("ya29.a");
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
