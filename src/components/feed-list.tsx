import { plain, rel } from "@/lib/format";
import type { getFeed } from "@/lib/queries";
import type { Source } from "@/db/schema";
import { SourceIcon } from "./ui";

/** Ingested content is untrusted: rendered as plain text only, never as HTML. */
export function FeedList({ rows, showSource = false }: { rows: ReturnType<typeof getFeed>; showSource?: boolean }) {
  if (!rows.length) return <p className="py-10 text-center text-[13px] text-faint">No items</p>;
  return (
    <ul className="overflow-hidden rounded-xl border border-line bg-white">
      {rows.map((r) => {
        const inner = (
          <div className="flex gap-3 px-4 py-3">
            {showSource && <span className="pt-0.5"><SourceIcon source={r.source as Source} size={18} /></span>}
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="truncate text-[13px] font-medium">{r.title || "(untitled)"}</span>
                <span className="ml-auto shrink-0 text-xs tabular-nums text-faint">{rel(r.occurredAt)}</span>
              </div>
              <div className="mt-0.5 flex gap-2 text-xs text-muted">
                <span>{r.author ?? "—"}</span>
                <span className="text-faint">·</span>
                <span className="text-faint">{r.kind}</span>
              </div>
              {r.bodyText && <p className="mt-1 line-clamp-2 text-[13px] text-muted">{plain(r.bodyText)}</p>}
            </div>
          </div>
        );
        return (
          <li key={r.id} className="border-b border-line last:border-b-0 hover:bg-soft">
            {r.url ? <a href={r.url} target="_blank" rel="noreferrer noopener">{inner}</a> : inner}
          </li>
        );
      })}
    </ul>
  );
}
