"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

const GROUPS = [
  {
    title: "Workspace",
    items: [
      { href: "/", label: "Today", matches: ["/"] },
      {
        href: "/tasks",
        label: "Tasks",
        matches: ["/tasks", "/chat", "/sessions", "/approvals"],
      },
      {
        href: "/routines",
        label: "Routines",
        matches: ["/routines", "/schedules"],
      },
      {
        href: "/connections",
        label: "Connections",
        matches: ["/connections", "/integrations"],
      },
      {
        href: "/knowledge",
        label: "Knowledge",
        matches: ["/knowledge", "/memory", "/skills"],
      },
    ],
  },
  {
    title: "Manage",
    items: [
      { href: "/settings", label: "Settings", matches: ["/settings"] },
      {
        href: "/diagnostics",
        label: "Diagnostics",
        matches: [
          "/diagnostics",
          "/overview",
          "/traces",
          "/monitors",
          "/costs",
          "/sandboxes",
          "/evals",
        ],
      },
    ],
  },
] as const;

export function Nav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    setOpen(false);
  }, [pathname]);
  if (pathname === "/signin") return null;

  return (
    <nav
      className={`sidebar${open ? " sidebar-open" : ""}`}
      aria-label="Sections"
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          setOpen(false);
          menu.current?.focus();
        }
      }}
    >
      <div className="sidebar-heading">
        <a className="brand" href="/">
          <span className="brand-mark" aria-hidden="true">
            ▚
          </span>
          <span>evestack</span>
        </a>
        <button
          ref={menu}
          type="button"
          className="mobile-menu"
          aria-expanded={open}
          aria-controls="workspace-navigation"
          onClick={() => setOpen(!open)}
        >
          {open ? "Close menu" : "Menu"}
        </button>
      </div>
      <div id="workspace-navigation" className="sidebar-content">
        <div className="sidebar-groups">
          {GROUPS.map((group) => (
            <div key={group.title} className="nav-group">
              <h2 className="nav-group-title">{group.title}</h2>
              <ul className="nav-list">
                {group.items.map((item) => {
                  const active = item.matches.some((path) =>
                    path === "/"
                      ? pathname === path
                      : pathname === path || pathname.startsWith(`${path}/`),
                  );
                  return (
                    <li key={item.href}>
                      <a
                        className={
                          active ? "nav-link nav-link-active" : "nav-link"
                        }
                        href={item.href}
                        aria-current={active ? "page" : undefined}
                        onClick={() => setOpen(false)}
                      >
                        {item.label}
                      </a>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
        <div className="sidebar-foot">
          <span className="badge-selfhosted">self-hosted</span>
          <form className="signout" method="post" action="/api/auth/signout">
            <button type="submit">Sign out</button>
          </form>
        </div>
      </div>
    </nav>
  );
}
