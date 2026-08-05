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
            <a href="/chat">Chat</a>
            <a href="/schedules">Schedules</a>
            <a href="/memory">Memory</a>
            <a href="/skills">Skills</a>
            <a href="/approvals">Approvals</a>
            <a href="/integrations">Integrations</a>
          </nav>
          <span className="badge-selfhosted" title="No Vercel account. No metered compute.">
            self-hosted
          </span>
        </header>
        <main className="shell">{children}</main>
      </body>
    </html>
  );
}
