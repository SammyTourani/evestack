import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "evestack",
  description: "Self-hosted observability and control for eve agents.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <a className="brand" href="/">
            <span className="brand-mark">▚</span>
            <span className="brand-name">evestack</span>
          </a>
          <nav className="topnav">
            <a href="/">Sessions</a>
            <a href="/traces">Traces</a>
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
