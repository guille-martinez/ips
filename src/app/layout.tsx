import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { getSources, healthState } from "@/lib/queries";
import { HealthDot, SourceIcon, SOURCE_META } from "@/components/ui";
import { NavLink } from "@/components/nav-link";
import "./globals.css";

export const metadata: Metadata = { title: "IPS" };
export const dynamic = "force-dynamic";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

const Icon = {
  home: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M2.5 7 8 2.5 13.5 7v6a.5.5 0 0 1-.5.5H10V10H6v3.5H3a.5.5 0 0 1-.5-.5Z" strokeLinejoin="round" />
    </svg>
  ),
  all: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M2.5 4h11M2.5 8h11M2.5 12h7" strokeLinecap="round" />
    </svg>
  ),
  plug: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M6 2v3M10 2v3M4.5 5h7v2.5a3.5 3.5 0 0 1-7 0ZM8 11v3" strokeLinecap="round" />
    </svg>
  ),
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const sources = getSources();
  return (
    <html lang="en" className={inter.variable}>
      <body className="font-sans text-[13px]">
        <div className="flex min-h-screen">
          <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r border-line bg-[#fbfbfc] px-3 py-4 md:flex">
            <div className="mb-5 flex items-center gap-2 px-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-ink text-[11px] font-bold text-white">IP</span>
              <span className="text-[14px] font-semibold">IPS</span>
            </div>
            <nav className="space-y-0.5">
              <NavLink href="/">{Icon.home} Dashboard</NavLink>
              <NavLink href="/feed">{Icon.all} Everything</NavLink>
              <NavLink href="/sources">{Icon.plug} Sources</NavLink>
            </nav>
            <div className="mb-1 mt-6 px-2 text-[11px] font-medium text-faint">Sources</div>
            <nav className="space-y-0.5">
              {sources.map((s) => (
                <NavLink key={s.source} href={`/s/${s.source}`}>
                  <SourceIcon source={s.source} size={16} />
                  <span className="flex-1 truncate">{SOURCE_META[s.source].label}</span>
                  <HealthDot state={healthState(s)} />
                </NavLink>
              ))}
            </nav>
            <div className="mt-auto px-2 text-[11px] text-faint">Read-only · local</div>
          </aside>
          <main className="min-w-0 flex-1">
            <div className="mx-auto max-w-[1240px] px-6 py-6 md:px-10">{children}</div>
          </main>
        </div>
      </body>
    </html>
  );
}
