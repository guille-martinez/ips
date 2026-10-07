import { getSources, healthState } from "@/lib/queries";
import { ago } from "@/lib/format";
import { Button, HealthDot, SourceIcon, SOURCE_META } from "@/components/ui";
import { syncNow } from "./actions";

export const dynamic = "force-dynamic";

function SyncButton({ source, label = "Sync" }: { source: string; label?: string }) {
  return (
    <form action={syncNow}>
      <input type="hidden" name="source" value={source} />
      <Button>{label}</Button>
    </form>
  );
}

export default function SourcesPage() {
  const rows = getSources();
  return (
    <div className="space-y-5">
      <header className="flex items-end">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Sources</h1>
          <p className="text-[13px] text-muted">Connection health for every source. Setup steps: docs/connect.md</p>
        </div>
        <div className="ml-auto">
          <SyncButton source="all" label="Sync all" />
        </div>
      </header>
      <div className="overflow-hidden rounded-xl border border-line">
        <table className="w-full border-collapse text-[13px]">
          <thead className="bg-[#fafafb] text-left text-xs text-muted">
            <tr>
              <th className="px-4 py-2 font-medium">Source</th>
              <th className="font-medium">Status</th>
              <th className="text-right font-medium">Items</th>
              <th className="pl-6 font-medium">Last run</th>
              <th className="font-medium">Last OK</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const st = healthState(r);
              const text = st === "off" ? r.reason : st === "error" ? r.lastError : st === "ok" ? "Connected" : "Configured, never synced";
              return (
                <tr key={r.source} className="border-t border-line align-middle hover:bg-soft">
                  <td className="px-4 py-2.5">
                    <span className="flex items-center gap-2.5 font-medium">
                      <SourceIcon source={r.source} />
                      {SOURCE_META[r.source].label}
                    </span>
                  </td>
                  <td className="max-w-md py-2.5">
                    <span className="flex items-center gap-2">
                      <HealthDot state={st} />
                      <span className={`truncate ${st === "error" ? "text-red-700" : "text-muted"}`} title={text ?? ""}>{text}</span>
                    </span>
                  </td>
                  <td className="py-2.5 text-right tabular-nums">{r.itemCount}</td>
                  <td className="py-2.5 pl-6 text-muted">{ago(r.lastRunAt)}</td>
                  <td className="py-2.5 text-muted">{ago(r.lastOkAt)}</td>
                  <td className="px-4 py-2.5 text-right">
                    <SyncButton source={r.source} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
