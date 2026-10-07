import { notFound } from "next/navigation";
import { SOURCES, type Source } from "@/db/schema";
import { views } from "@/views";
import { getFeed, getSources, healthState } from "@/lib/queries";
import { ago } from "@/lib/format";
import { Button, HealthDot, ItemRow, Panel, SourceIcon, Stat } from "@/components/ui";
import { FeedList } from "@/components/feed-list";
import { syncNow } from "../../sources/actions";

export const dynamic = "force-dynamic";

export default async function SourcePage({ params, searchParams }: { params: Promise<{ source: string }>; searchParams: Promise<{ q?: string }> }) {
  const { source } = await params;
  const { q } = await searchParams;
  if (!(SOURCES as readonly string[]).includes(source)) notFound();
  const s = source as Source;
  const v = views[s];
  const t = v.tile();
  const pending = v.pending?.() ?? [];
  const h = getSources().find((r) => r.source === s)!;
  const state = healthState(h);

  return (
    <div className="space-y-6">
      <header className="flex items-center gap-3">
        <SourceIcon source={s} size={28} />
        <div>
          <h1 className="text-[22px] font-semibold leading-tight tracking-tight">{v.title}</h1>
          <div className="flex items-center gap-1.5 text-xs text-muted">
            <HealthDot state={state} />
            {state === "ok" ? `Synced ${ago(h.lastOkAt)} · ${h.itemCount} items` : (h.lastError ?? h.reason ?? "Never synced")}
          </div>
        </div>
        <form action={syncNow} className="ml-auto">
          <input type="hidden" name="source" value={s} />
          <Button>Sync now</Button>
        </form>
      </header>

      <div className="flex gap-10 rounded-xl border border-line px-5 py-4">
        {t.stats.map((st) => (
          <Stat key={st.label} value={st.value} label={st.label} />
        ))}
      </div>

      {pending.length > 0 && (
        <Panel title="Pending" meta={`${pending.length} open`}>
          <div className="pb-1">{pending.map((i) => <ItemRow key={i.id} item={i} />)}</div>
        </Panel>
      )}

      <div className="space-y-3">
        <form className="flex gap-2">
          <input
            name="q"
            defaultValue={q}
            placeholder={`Search ${v.title}…`}
            className="h-8 w-80 rounded-md border border-line bg-white px-2.5 text-[13px] outline-none placeholder:text-faint focus:border-[#c9cdf3] focus:ring-2 focus:ring-[#5e6ad2]/15"
          />
        </form>
        <FeedList rows={getFeed({ source: s, q, limit: 100 })} />
      </div>
    </div>
  );
}
