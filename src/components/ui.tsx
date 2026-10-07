import Link from "next/link";
import type { Source } from "@/db/schema";
import type { ViewItem } from "@/views/types";
import { rel } from "@/lib/format";

/* ---------- Source identity ---------- */

export const SOURCE_META: Record<Source, { label: string; color: string; glyph: string }> = {
  calendar: { label: "Calendar", color: "#1a73e8", glyph: "C" },
  slack: { label: "Slack", color: "#611f69", glyph: "S" },
  gmail: { label: "Gmail", color: "#d93025", glyph: "M" },
  granola: { label: "Granola", color: "#3f8f4f", glyph: "G" },
  linear: { label: "Linear", color: "#5e6ad2", glyph: "L" },
  notion: { label: "Notion", color: "#191919", glyph: "N" },
  attio: { label: "Attio", color: "#2d2f36", glyph: "A" },
  metabase: { label: "Metabase", color: "#509ee3", glyph: "M" },
  sheets: { label: "Superbrain", color: "#188038", glyph: "B" },
};

export function SourceIcon({ source, size = 18 }: { source: Source; size?: number }) {
  const m = SOURCE_META[source];
  return (
    <span
      aria-label={m.label}
      className="inline-flex shrink-0 items-center justify-center rounded-[5px] font-semibold text-white"
      style={{ background: m.color, width: size, height: size, fontSize: size * 0.55 }}
    >
      {m.glyph}
    </span>
  );
}

/* ---------- Status icons (Linear-style) ---------- */

type StatusKind = "todo" | "progress" | "review" | "blocked" | "done" | "unread" | "dm" | "read";

/** Maps a badge to a status icon, or null when the badge is just a label (e.g. "#deployment"). */
export function statusKind(badge?: string | null): StatusKind | null {
  const b = (badge ?? "").toLowerCase().trim();
  if (/^(wip|in progress|started)$/.test(b)) return "progress";
  if (/review/.test(b)) return "review";
  if (/^blocked$/.test(b)) return "blocked";
  if (/^(done|completed|canceled|cancelled)$/.test(b)) return "done";
  if (b === "unread") return "unread";
  if (b === "dm") return "dm";
  if (b === "read") return "read";
  if (/^(pending|todo|backlog|triage|unstarted)$/.test(b)) return "todo";
  return null;
}

export function StatusIcon({ badge }: { badge?: string | null }) {
  const k = statusKind(badge) ?? "todo";
  const s = 14;
  switch (k) {
    case "progress":
      return (
        <svg width={s} height={s} viewBox="0 0 14 14" className="shrink-0">
          <circle cx="7" cy="7" r="6" fill="none" stroke="#f2c94c" strokeWidth="1.5" />
          <path d="M7 3.5 A3.5 3.5 0 0 1 7 10.5 Z" fill="#f2c94c" />
        </svg>
      );
    case "review":
      return (
        <svg width={s} height={s} viewBox="0 0 14 14" className="shrink-0">
          <circle cx="7" cy="7" r="6" fill="none" stroke="#4cb782" strokeWidth="1.5" />
          <path d="M7 3.5 A3.5 3.5 0 1 1 3.5 7 L7 7 Z" fill="#4cb782" />
        </svg>
      );
    case "blocked":
      return (
        <svg width={s} height={s} viewBox="0 0 14 14" className="shrink-0">
          <circle cx="7" cy="7" r="6.5" fill="#eb5757" />
          <rect x="6.25" y="3.5" width="1.5" height="4.5" rx=".75" fill="#fff" />
          <circle cx="7" cy="10" r=".9" fill="#fff" />
        </svg>
      );
    case "done":
      return (
        <svg width={s} height={s} viewBox="0 0 14 14" className="shrink-0">
          <circle cx="7" cy="7" r="6.5" fill="#5e6ad2" />
          <path d="M4.5 7.2 6.3 9 9.6 5.4" stroke="#fff" strokeWidth="1.5" fill="none" strokeLinecap="round" />
        </svg>
      );
    case "unread":
      return (
        <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
          <span className="h-2 w-2 rounded-full bg-[#1a73e8]" />
        </span>
      );
    case "dm":
      return (
        <svg width={s} height={s} viewBox="0 0 14 14" className="shrink-0">
          <path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h7A1.5 1.5 0 0 1 12 3.5v5A1.5 1.5 0 0 1 10.5 10H6l-3 2.2V10h0A1.5 1.5 0 0 1 2 8.5Z" fill="none" stroke="#611f69" strokeWidth="1.3" />
        </svg>
      );
    case "read":
      return (
        <svg width={s} height={s} viewBox="0 0 14 14" className="shrink-0">
          <path d="M2 3h4a1 1 0 0 1 1 1v7.5a1 1 0 0 0-1-1H2Zm10 0H8a1 1 0 0 0-1 1v7.5a1 1 0 0 1 1-1h4Z" fill="none" stroke="#9b9fa6" strokeWidth="1.2" />
        </svg>
      );
    default:
      return (
        <svg width={s} height={s} viewBox="0 0 14 14" className="shrink-0">
          <circle cx="7" cy="7" r="6" fill="none" stroke="#b4b7bd" strokeWidth="1.5" strokeDasharray={badge === "Pending" ? "2.2 1.6" : undefined} />
        </svg>
      );
  }
}

/* ---------- People ---------- */

const AVATAR_COLORS = ["#e0e7ff", "#fce7f3", "#dcfce7", "#fef3c7", "#e0f2fe", "#ede9fe", "#ffedd5", "#f1f5f9"];
const AVATAR_TEXT = ["#3730a3", "#9d174d", "#166534", "#92400e", "#075985", "#5b21b6", "#9a3412", "#334155"];

export function Avatar({ name, size = 22 }: { name: string; size?: number }) {
  const initials = name.includes("@")
    ? name[0].toUpperCase()
    : name
        .split(/\s+/)
        .slice(0, 2)
        .map((p) => p[0]?.toUpperCase())
        .join("");
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const i = h % AVATAR_COLORS.length;
  return (
    <span
      title={name}
      className="inline-flex shrink-0 items-center justify-center rounded-full font-medium ring-2 ring-white"
      style={{ width: size, height: size, fontSize: size * 0.42, background: AVATAR_COLORS[i], color: AVATAR_TEXT[i] }}
    >
      {initials}
    </span>
  );
}

export function AvatarStack({ names, max = 4 }: { names: string[]; max?: number }) {
  if (!names.length) return null;
  return (
    <span className="flex items-center">
      <span className="flex -space-x-1.5">
        {names.slice(0, max).map((n) => (
          <Avatar key={n} name={n} />
        ))}
      </span>
      {names.length > max && <span className="ml-1.5 text-xs text-faint">+{names.length - max}</span>}
    </span>
  );
}

/* ---------- Layout primitives ---------- */

export function Panel({
  title,
  icon,
  meta,
  href,
  children,
  footer,
}: {
  title: React.ReactNode;
  icon?: React.ReactNode;
  meta?: React.ReactNode;
  href?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <section className="flex flex-col overflow-hidden rounded-xl border border-line bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
      <header className="flex h-11 items-center gap-2 px-4">
        {icon}
        <h2 className="text-[13px] font-semibold">
          {href ? (
            <Link href={href} className="hover:text-accent">
              {title}
            </Link>
          ) : (
            title
          )}
        </h2>
        <div className="ml-auto flex items-center gap-2 text-xs text-muted">{meta}</div>
      </header>
      <div className="flex-1">{children}</div>
      {footer && <footer className="border-t border-line px-4 py-2 text-xs text-muted">{footer}</footer>}
    </section>
  );
}

export function Stat({ value, label }: { value: number | string; label: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[22px] font-semibold leading-none tracking-tight tabular-nums">{value}</div>
      <div className="mt-1 text-xs text-muted">{label}</div>
    </div>
  );
}

export function Button({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line bg-white px-2.5 text-xs font-medium text-ink shadow-[0_1px_1px_rgba(0,0,0,0.03)] hover:bg-soft"
    >
      {children}
    </button>
  );
}

/** Ingested content is untrusted: always rendered as plain text, never HTML. */
export function ItemRow({ item, showSource = false, dense = false }: { item: ViewItem; showSource?: boolean; dense?: boolean }) {
  const isStatus = statusKind(item.badge) !== null;
  const content = (
    <>
      {showSource && <SourceIcon source={item.source} size={16} />}
      {isStatus && <StatusIcon badge={item.badge} />}
      <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{item.title}</span>
      {item.badge && !isStatus && <span className="max-w-28 shrink-0 truncate text-xs text-faint">{item.badge}</span>}
      {item.due && <DueChip due={item.due} />}
      <span className="w-16 shrink-0 text-right text-xs tabular-nums text-faint">{rel(item.at)}</span>
    </>
  );
  const cls = `flex items-center gap-2.5 px-4 ${dense ? "h-8" : "h-9"} hover:bg-soft`;
  return item.url ? (
    <a href={item.url} target="_blank" rel="noreferrer noopener" className={cls}>
      {content}
    </a>
  ) : (
    <div className={cls}>{content}</div>
  );
}

export function DueChip({ due }: { due: string }) {
  const d = new Date(due);
  if (Number.isNaN(d.getTime())) return null;
  const days = Math.floor((new Date(d).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86_400_000);
  const label = days < 0 ? `${-days}d overdue` : days === 0 ? "Today" : days === 1 ? "Tomorrow" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  const tone = days < 0 ? "border-red-200 bg-red-50 text-red-700" : days === 0 ? "border-amber-200 bg-amber-50 text-amber-800" : "border-line bg-white text-muted";
  return <span className={`shrink-0 rounded-md border px-1.5 py-px text-[11px] font-medium ${tone}`}>{label}</span>;
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-6 text-center text-[13px] text-faint">{children}</p>;
}

export function HealthDot({ state }: { state: "ok" | "error" | "off" | "never" }) {
  const c = { ok: "bg-emerald-500", error: "bg-red-500", off: "bg-neutral-300", never: "bg-amber-400" }[state];
  return <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${c}`} />;
}
