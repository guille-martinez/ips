// Usage: npm run auth:check [source...]   e.g. npm run auth:check slack linear
import "@/lib/load-env";
import { connectors } from "@/connectors";
import type { Source } from "@/db/schema";
import { redact } from "@/lib/redact";

const wanted = (process.argv.slice(2) as Source[]).filter((s) => s in connectors);
const sources = wanted.length ? wanted : (Object.keys(connectors) as Source[]);

for (const s of sources) {
  const c = connectors[s];
  const cfg = c.configured();
  if (!cfg.ok) {
    console.log(`✗ ${c.label}: ${cfg.reason}`);
    continue;
  }
  try {
    const r = await c.checkAuth();
    console.log(r.ok ? `✓ ${c.label}: ${r.identity}` : `✗ ${c.label}: ${redact(r.error)}`);
  } catch (e) {
    console.log(`✗ ${c.label}: ${redact(e instanceof Error ? e.message : String(e))}`);
  }
}
