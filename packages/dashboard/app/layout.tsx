import type { Metadata } from "next";
import type { ReactNode } from "react";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";

export const metadata: Metadata = {
  title: "evestack",
  description: "Self-hosted observability and control for eve agents.",
};

/*
 * Geist arrives on <html> as two custom properties and nothing else.
 * `globals.css` maps them onto Tailwind's `--font-sans` / `--font-mono`, so
 * `font-sans` and `font-mono` render in Geist — but no element wears either
 * utility yet and `body` still asks for the system stack, so every page still
 * renders in the typeface it was designed in. Switching the typeface is a
 * visible change and belongs to the wave that restyles the pages, which is
 * what keeps a port error distinguishable from an intended redesign.
 *
 * The files are served from this origin by next/font. Nothing is fetched from
 * Vercel or Google, at build time or at run time.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>
        <header className="topbar">
          <a className="brand" href="/">
            <span className="brand-mark">▚</span>
            <span className="brand-name">evestack</span>
          </a>
          <nav className="topnav">
            {/* `/` still redirects here; the nav points at the real route so a
                middle-click, a copied link and the address bar all agree. */}
            <a href="/">Overview</a>
            <a href="/sessions">Sessions</a>
            <a href="/traces">Traces</a>
            <a href="/monitors">Monitors</a>
            <a href="/sandboxes">Sandboxes</a>
            <a href="/chat">Chat</a>
            <a href="/schedules">Schedules</a>
            <a href="/memory">Memory</a>
            <a href="/skills">Skills</a>
            <a href="/approvals">Approvals</a>
            <a href="/evals">Evals</a>
            <a href="/integrations">Integrations</a>
          </nav>
          <span className="badge-selfhosted" title="No Vercel account. No metered compute.">
            self-hosted
          </span>
          {/*
            A form, not a link: a GET sign-out is fired by link prefetching and
            by any <img> on a page the operator visits. Rendered unconditionally
            rather than only when signed in — knowing that would mean reading
            cookies() in the root layout, and the trade there is a dynamic API
            in the one component every page renders through, to hide a button
            that is harmless on the sign-in page.
          */}
          <form className="signout" method="post" action="/api/auth/signout">
            <button type="submit" title="Clear this browser's session cookie">
              Sign out
            </button>
          </form>
        </header>
        <main className="shell">{children}</main>
      </body>
    </html>
  );
}
