import "@/lib/load-env";
import { getDb } from "@/db/client";
import { runAll } from "@/sync/run";

const once = process.argv.includes("--once");
const intervalMin = Number(process.env.IPS_SYNC_INTERVAL_MIN ?? 5);

async function tick() {
  const started = Date.now();
  const results = await runAll(getDb());
  for (const r of results) {
    // Counts and redacted errors only. Never log item content or secrets.
    console.log(`[${new Date().toISOString()}] ${r.source.padEnd(9)} ${r.status.padEnd(7)} +${r.upserted}${r.message ? `  ${r.message}` : ""}`);
  }
  console.log(`sync done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

if (once) {
  await tick();
} else {
  console.log(`IPS worker: syncing every ${intervalMin} min`);
  for (;;) {
    await tick().catch((e) => console.error("tick failed:", e instanceof Error ? e.message : e));
    await new Promise((r) => setTimeout(r, intervalMin * 60_000));
  }
}
