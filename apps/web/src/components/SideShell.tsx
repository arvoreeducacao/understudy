"use client";

import { Bot, CalendarDays, Ellipsis, Inbox, ListChecks, X, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { messages } from "@/lib/messages";

const TABS: { href: string; exact?: boolean; icon: LucideIcon; label: () => string; badge?: "waiting" }[] = [
  { href: "/", exact: true, icon: Bot, label: () => messages.nav.tabAgents },
  { href: "/waiting", icon: Inbox, label: () => messages.nav.tabWaiting, badge: "waiting" },
  { href: "/today", icon: CalendarDays, label: () => messages.nav.today },
  { href: "/recipes", icon: ListChecks, label: () => messages.nav.recipes },
];

function matches(pathname: string, href: string, exact = false) {
  return exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

export function SideShell({ brand, nav, who, waiting, moreAlert }: { brand: React.ReactNode; nav: React.ReactNode; who: React.ReactNode; waiting: number; moreAlert: number }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  const onTab = TABS.some((tab) => matches(pathname, tab.href, tab.exact));
  return (
    <>
      <aside className={`side ${open ? "is-open" : ""}`}>
        <div className="side-top">
          {brand}
          <button type="button" className="side-close" aria-label={messages.nav.closeMenu} onClick={() => setOpen(false)}>
            <X size={18} aria-hidden />
          </button>
        </div>
        <div id="side-menu" className="side-menu">
          {nav}
          {who}
        </div>
      </aside>
      {open && <div className="side-scrim" aria-hidden onClick={() => setOpen(false)} />}
      <nav className="tabbar" aria-label={messages.nav.tabsLabel}>
        {TABS.map((tab) => {
          const on = !open && matches(pathname, tab.href, tab.exact);
          const Icon = tab.icon;
          const count = tab.badge === "waiting" ? waiting : 0;
          return (
            <Link key={tab.href} href={tab.href} className="tabbar-item" aria-current={on ? "page" : undefined}>
              <span className="tabbar-icon">
                <Icon size={20} strokeWidth={1.8} aria-hidden />
                {count > 0 && <span className="tabbar-badge">{count > 99 ? "99+" : count}</span>}
              </span>
              <span className="tabbar-label">{tab.label()}</span>
            </Link>
          );
        })}
        <button
          type="button"
          className={`tabbar-item ${open || !onTab ? "is-on" : ""}`}
          aria-expanded={open}
          aria-controls="side-menu"
          onClick={() => setOpen((o) => !o)}
        >
          <span className="tabbar-icon">
            <Ellipsis size={20} strokeWidth={1.8} aria-hidden />
            {moreAlert > 0 && <span className="tabbar-dot" aria-hidden />}
          </span>
          <span className="tabbar-label">{messages.nav.more}</span>
        </button>
      </nav>
    </>
  );
}
