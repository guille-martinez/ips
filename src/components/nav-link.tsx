"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  const path = usePathname();
  const active = href === "/" ? path === "/" : path.startsWith(href);
  return (
    <Link
      href={href}
      className={`flex h-7 items-center gap-2 rounded-md px-2 text-[13px] ${active ? "bg-[#ececef] font-medium text-ink" : "text-[#3c3f45] hover:bg-[#f0f0f2]"}`}
    >
      {children}
    </Link>
  );
}
