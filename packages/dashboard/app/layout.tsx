import type { Metadata } from "next";
import type { ReactNode } from "react";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { Nav } from "./nav";
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
        {/*
          The chrome is a client component so it can read the pathname — for the
          active link, and to render nothing at all on /signin. See app/nav.tsx.
          The layout itself stays a server component and calls no dynamic API.
        */}
        <Nav />
        <main className="shell">{children}</main>
      </body>
    </html>
  );
}
