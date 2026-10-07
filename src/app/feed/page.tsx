import Link from "next/link";
import { SOURCES } from "@/db/schema";
import { getFeed, type FeedFilters } from "@/lib/queries";
import { FeedList } from "@/components/feed-list";
import { SOURCE_META } from "@/components/ui";

export const dynamic = "force-dynamic";

const field = "h-8 rounded-md border border-line bg-white px-2.5 text-[13px] outline-none placeholder:text-faint focus:border-[#c9cdf3] focus:ring-2 focus:ring-[#5e6ad2]/15";

export default async function FeedPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const filters: FeedFilters = { source: sp.source, person: sp.person, from: sp.from, to: sp.to, q: sp.q };
  const rows = getFeed(filters);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight">Everything</h1>
        <p className="text-[13px] text-muted">Every item from every source, newest first.</p>
      </div>
      <form className="flex flex-wrap items-center gap-2">
        <input name="q" defaultValue={sp.q} placeholder="Search…" className={`${field} w-72`} />
        <select name="source" defaultValue={sp.source ?? ""} className={field}>
          <option value="">All sources</option>
          {SOURCES.map((s) => (
            <option key={s} value={s}>{SOURCE_META[s].label}</option>
          ))}
        </select>
        <input name="person" defaultValue={sp.person} placeholder="Person" className={`${field} w-44`} />
        <input type="date" name="from" defaultValue={sp.from} className={field} />
        <input type="date" name="to" defaultValue={sp.to} className={field} />
        <button className="h-8 rounded-md bg-ink px-3 text-[13px] font-medium text-white hover:bg-black">Filter</button>
        <Link href="/feed" className="text-[13px] text-muted hover:text-ink">Reset</Link>
        <span className="ml-auto text-xs text-faint">{rows.length}{rows.length === 200 ? "+" : ""} items</span>
      </form>
      <FeedList rows={rows} showSource />
    </div>
  );
}
