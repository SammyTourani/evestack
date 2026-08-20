"use client";

import { usePathname } from "next/navigation";

/**
 * The sidebar, grouped by what the operator is doing rather than alphabetically.
 *
 * WHY IT MOVED. Thirteen destinations sat in one horizontal row of undifferentiated
 * links. Two things were wrong with that and only one of them was aesthetic.
 *
 * The measurable one: the header could not fit. At a 768px viewport the row alone
 * measured 876px and `document.body.scrollWidth` was 1155 against `innerWidth` 768,
 * so the whole page scrolled sideways. There was no breakpoint, no overflow menu and
 * no collapse — the nav simply set a floor on how narrow the app could be.
 *
 * The other: evestack's one claim over the hosted product is that this dashboard
 * DRIVES agents rather than watching them, and the three screens that drive — Chat,
 * Approvals, Schedules — were buried between Costs and Memory, indistinguishable
 * from a read-only report. Grouping is what lets the nav state the difference.
 *
 * A client component, and that is what fixes the sign-in page too. The sign-out form
 * used to render unconditionally because knowing whether you were signed in meant
 * calling `cookies()` in the root layout — a dynamic API in the one component every
 * page renders through. `usePathname()` needs neither: the sign-in page is a route,
 * not a session state, so it is the pathname that decides, and the layout stays a
 * server component.
 */

interface Item {
  href: string;
  label: string;
}

interface Group {
  title: string;
  hint: string;
  items: Item[];
}

/**
 * Three groups, and the middle one is the argument.
 *
 * OBSERVE is what any observability product has. DRIVE is what a hosted control
 * plane cannot ship, because starting a run, approving a tool call and holding a
 * schedule all require reaching the agent, and the agent is on your machine.
 * CONFIGURE is the state the agent carries between runs.
 *
 * Sandboxes sits under DRIVE rather than OBSERVE on purpose, and NOT because it
 * acts. This comment used to say the page "can stop them, which is an action" —
 * it cannot, and never could. `lib/sandboxes.ts` issues GET requests only (the
 * one `request()` call in the file is `method: "GET"`, lib/sandboxes.ts:139, and
 * the module header says so at :18), there is no route under `app/api` that
 * touches a container, and the page's own disabled-state copy tells the reader
 * the opposite of what this comment told the next maintainer:
 * "Nothing here writes: this page lists containers and there is no way to stop
 * or remove one from the dashboard" (app/sandboxes/page.tsx:221). A comment that
 * promises a lifecycle verb is how someone comes to wire a Stop button to a
 * socket that is root-equivalent on the host — the exact thing lib/sandboxes.ts
 * fences behind a second, not-yet-existing flag.
 *
 * The real reason it is under DRIVE is this group's hint, "What a hosted
 * dashboard cannot do", which is precisely what the page is: containers running
 * on THIS host, knowable only from the machine. OBSERVE's hint is "What your
 * agents did" — a record of the past — and a live container list is not that.
 * The grouping is about where the knowledge comes from, not about writes.
 */
const GROUPS: readonly Group[] = [
  {
    title: "Observe",
    hint: "What your agents did",
    items: [
      { href: "/", label: "Overview" },
      { href: "/sessions", label: "Sessions" },
      { href: "/traces", label: "Traces" },
      { href: "/monitors", label: "Monitors" },
      { href: "/costs", label: "Costs" },
    ],
  },
  {
    title: "Drive",
    hint: "What a hosted dashboard cannot do",
    items: [
      { href: "/chat", label: "Chat" },
      { href: "/approvals", label: "Approvals" },
      { href: "/schedules", label: "Schedules" },
      { href: "/sandboxes", label: "Sandboxes" },
    ],
  },
  {
    title: "Configure",
    hint: "What the agent carries between runs",
    items: [
      { href: "/memory", label: "Memory" },
      { href: "/skills", label: "Skills" },
      { href: "/evals", label: "Evals" },
      { href: "/integrations", label: "Integrations" },
    ],
  },
];

/**
 * Exact for the overview, prefix for everything else.
 *
 * `/` prefix-matches every route, so a naive `startsWith` lights Overview on all
 * thirteen pages. And a prefix match is what makes `/sessions/wrun_…` keep Sessions
 * lit rather than showing nothing selected on a detail page — the state a reader
 * uses to answer "where am I".
 */
function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function Nav() {
  const pathname = usePathname();

  // The sign-in page gets no chrome. It used to render all thirteen links and a
  // Sign out button to a reader who was, by definition, not signed in — every one
  // of those links 302s straight back here.
  if (pathname === "/signin") return null;

  return (
    <nav className="sidebar" aria-label="Sections">
      <a className="brand" href="/">
        <span className="brand-mark" aria-hidden="true">
          ▚
        </span>
        <span className="brand-name">evestack</span>
      </a>

      <div className="sidebar-groups">
        {GROUPS.map((group) => (
          <div className="nav-group" key={group.title}>
            <h2 className="nav-group-title" title={group.hint}>
              {group.title}
            </h2>
            <ul className="nav-list">
              {group.items.map((item) => {
                const active = isActive(pathname, item.href);
                return (
                  <li key={item.href}>
                    <a
                      className={active ? "nav-link nav-link-active" : "nav-link"}
                      href={item.href}
                      // Not just colour. A reader who cannot distinguish the two
                      // greys gets the same answer from a screen reader, and the
                      // rail on the left edge carries it visually.
                      aria-current={active ? "page" : undefined}
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
        <span className="badge-selfhosted" title="No Vercel account. No metered compute.">
          self-hosted
        </span>
        {/*
          A form, not a link: a GET sign-out is fired by link prefetching and by any
          <img> on a page the operator visits.
        */}
        <form className="signout" method="post" action="/api/auth/signout">
          <button type="submit" title="Clear this browser's session cookie">
            Sign out
          </button>
        </form>
      </div>
    </nav>
  );
}
