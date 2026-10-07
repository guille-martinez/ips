import { SOURCES, type Source } from "@/db/schema";
import { views, allPending } from "@/views";
import { todayMeetings, type Meeting } from "@/views/today";
import { getSources, healthState } from "@/lib/queries";
import { ago, hm } from "@/lib/format";
import { AvatarStack, Button, Empty, HealthDot, ItemRow, Panel, SourceIcon, SOURCE_META, Stat } from "@/components/ui";
import type { ViewItem } from "@/views/types";
import { syncNow } from "./sources/actions";

export const dynamic = "force-dynamic";

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 19 ? "Good afternoon" : "Good evening";
}

export default function Dashboard() {
  const sources = getSources();
  const health = new Map(sources.map((s) => [s.source, s]));
  const meetings = todayMeetings();
  const pending = allPending();
  const live = sources.filter((s) => healthState(s) === "ok").length;
  const lastSync = sources.map((s) => s.lastOkAt).filter(Boolean).sort().pop() ?? null;

  return (
    <div className="space-y-6">
      <header className="flex items-end gap-4">
        <div>
          <div className="text-xs font-medium text-muted">{new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}</div>
          <h1 className="mt-0.5 text-[22px] font-semibold tracking-tight">{greeting()}, Guillermo</h1>
        </div>
        <div className="ml-auto flex items-center gap-3 text-xs text-muted">
          <span className="flex items-center gap-1.5">
            <HealthDot state={live ? "ok" : "off"} />
            {live}/{SOURCES.length} live · synced {ago(lastSync)}
          </span>
          <form action={syncNow}>
            <input type="hidden" name="source" value="all" />
            <Button>
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
                <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Sync
            </Button>
          </form>
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <Panel title="Today" icon={<SourceIcon source="calendar" />} meta={`${meetings.length} meetings`}>
          <Timeline meetings={meetings} />
        </Panel>
        <Panel title="Pending" meta={`${pending.length} open`}>
          <PendingList items={pending} />
        </Panel>
      </div>

      <div>
        <h2 className="mb-3 text-[13px] font-semibold text-muted">Sources</h2>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {SOURCES.filter((s) => s !== "calendar").map((s) => {
            const v = views[s];
            const h = health.get(s)!;
            const state = healthState(h);
            const t = v.tile();
            return (
              <Panel
                key={s}
                href={`/s/${s}`}
                title={v.title}
                icon={<SourceIcon source={s} />}
                meta={
                  <span className="flex items-center gap-1.5" title={h.lastError ?? h.reason ?? ""}>
                    <HealthDot state={state} />
                    {state === "ok" ? ago(h.lastOkAt) : state === "off" ? "Not connected" : state === "error" ? "Error" : "Never synced"}
                  </span>
                }
                footer={
                  <a href={`/s/${s}`} className="hover:text-ink">
                    View all {h.itemCount} →
                  </a>
                }
              >
                <div className="flex gap-6 px-4 pb-3 pt-1">
                  {t.stats.map((st) => (
                    <Stat key={st.label} value={st.value} label={st.label} />
                  ))}
                </div>
                <div className="pb-1">
                  {t.items.length ? t.items.map((i) => <ItemRow key={i.id} item={i} dense />) : <Empty>{state === "off" ? "Not connected yet" : "No items yet"}</Empty>}
                </div>
              </Panel>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Timeline({ meetings }: { meetings: Meeting[] }) {
  if (!meetings.length) return <Empty>No meetings today</Empty>;
  const now = new Date().toISOString();
  const past = meetings.filter((m) => (m.end ?? m.start) <= now);
  const upcoming = meetings.filter((m) => (m.end ?? m.start) > now);
  return (
    <div className="max-h-[440px] overflow-y-auto px-2 pb-2">
      {past.length > 0 && (
        <details className="group mb-1" open={upcoming.length === 0}>
          <summary className="flex h-8 cursor-pointer list-none items-center gap-1.5 rounded-md px-2 text-xs text-muted hover:bg-soft">
            <svg width="10" height="10" viewBox="0 0 10 10" className="transition-transform group-open:rotate-90">
              <path d="M3.5 2 7 5 3.5 8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
            Earlier today · {past.length}
          </summary>
          {past.map((m) => (
            <MeetingRow key={m.key} m={m} now={now} />
          ))}
        </details>
      )}
      <NowLine />
      {upcoming.length ? upcoming.map((m) => <MeetingRow key={m.key} m={m} now={now} />) : <Empty>No more meetings today</Empty>}
    </div>
  );
}

function NowLine() {
  return (
    <div className="flex items-center gap-2 px-2 py-1">
      <span className="w-14 text-right text-[11px] font-semibold tabular-nums text-[#eb5757]">{hm(new Date().toISOString())}</span>
      <span className="h-2 w-2 rounded-full bg-[#eb5757]" />
      <span className="h-px flex-1 bg-[#eb5757]/50" />
    </div>
  );
}

function MeetingRow({ m, now }: { m: Meeting; now: string }) {
  const past = (m.end ?? m.start) < now;
  const live = m.start <= now && !!m.end && m.end > now;
  return (
    <div className={`group flex gap-3 rounded-lg px-2 py-2 hover:bg-soft ${past ? "opacity-55" : ""}`}>
      <div className="w-14 shrink-0 text-right tabular-nums">
        <div className="text-[13px] font-medium">{hm(m.start)}</div>
        {m.end && <div className="text-[11px] text-faint">{hm(m.end)}</div>}
      </div>
      <div className={`w-[3px] shrink-0 rounded-full ${live ? "bg-accent" : past ? "bg-line" : "bg-[#c9cdf3]"}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {live && <span className="rounded bg-accent px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-white">Now</span>}
          <span className="truncate text-[13px] font-medium">{m.title}</span>
        </div>
        <div className="mt-1 flex items-center gap-3">
          <AvatarStack names={m.people} />
          {m.noteUrl && (
            <a href={m.noteUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 rounded-md border border-line px-1.5 py-px text-[11px] text-muted hover:bg-white hover:text-ink">
              <SourceIcon source="granola" size={12} /> Notes
            </a>
          )}
          {m.url && (
            <a href={m.url} target="_blank" rel="noreferrer noopener" className="text-[11px] text-muted hover:text-ink">
              Open ↗
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

function PendingList({ items }: { items: ViewItem[] }) {
  if (!items.length) return <Empty>Nothing pending</Empty>;
  const groups = new Map<Source, ViewItem[]>();
  for (const i of items) groups.set(i.source, [...(groups.get(i.source) ?? []), i]);
  return (
    <div className="max-h-[440px] overflow-y-auto pb-2">
      {[...groups].map(([source, list]) => (
        <div key={source}>
          <div className="sticky top-0 z-10 flex h-8 items-center gap-2 border-y border-line bg-[#fafafb] px-4 text-xs font-medium first:border-t-0">
            <SourceIcon source={source} size={14} />
            {SOURCE_META[source].label}
            <span className="text-faint">{list.length}</span>
          </div>
          {list.map((i) => (
            <ItemRow key={i.id} item={i} />
          ))}
        </div>
      ))}
    </div>
  );
}
