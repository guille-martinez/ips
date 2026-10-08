// Usage: npm run sync:only -- gmail calendar   (sync just these sources once)
import "@/lib/load-env";
import { getDb } from "@/db/client";
import { SOURCES, type Source } from "@/db/schema";
import { runSource } from "@/sync/run";

const wanted = process.argv.slice(2).filter((s): s is Source => (SOURCES as readonly string[]).includes(s));
for (const r of await Promise.all(wanted.map((s) => runSource(getDb(), s)))) {
  console.log(`${r.source.padEnd(9)} ${r.status.padEnd(7)} +${r.upserted}${r.message ? `  ${r.message}` : ""}`);
}
