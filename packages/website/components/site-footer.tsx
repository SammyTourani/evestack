import { footerColumns, site } from "@/lib/copy";
import { ThemeSwitcher } from "@/components/ui/theme-switcher";

export function SiteFooter() {
  return (
    <footer className="section-rule">
      <div className="site-container flex flex-col gap-8 py-10 md:gap-12 md:py-16">
        <div className="grid grid-cols-2 gap-10 md:grid-cols-5">
          <div className="col-span-2 flex flex-col gap-3">
            <p className="flex items-center gap-2 text-copy-16 font-medium">
              <span aria-hidden className="text-blue-700">
                {site.mark}
              </span>
              {site.name}
            </p>
            <p className="max-w-xs text-copy-14 text-gray-900">
              A fully free, self-hosted distribution of the eve agent framework.
            </p>
            <p className="font-mono text-mono-13 text-gray-700">{site.motto}</p>
          </div>
          {footerColumns.map((col) => (
            <nav key={col.title} aria-label={col.title} className="flex flex-col gap-3 max-md:hidden">
              <p className="font-mono text-label-12 uppercase text-gray-700">{col.title}</p>
              <ul className="flex flex-col gap-2">
                {col.links.map((link) => (
                  <li key={link.label}>
                    <a
                      href={link.href}
                      {...(link.href.startsWith("http")
                        ? { target: "_blank", rel: "noreferrer" }
                        : {})}
                      className="block py-3 text-copy-14 text-gray-900 transition-colors hover:text-gray-1000 md:inline md:py-0"
                    >
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          ))}

          {/* PHONE FOOTER. The three columns above are a sitemap laid out for a
              wide canvas: on a 393pt screen they became 12 stacked 44px rows —
              1,072px, a phone screen and a quarter of links, with a hole where
              the third column wrapped. Same links, same order, same copy
              source, as three disclosure groups instead, so the footer costs
              one screen-third until someone actually wants a link.

              `name="evestack-footer"` makes them mutually exclusive, which is
              the native accordion behaviour and needs no JS. The -mx-5/px-5
              pair cancels and restores site-container's gutter so the dividers
              run edge to edge, matching the panels above.

              The no-JS route survives — native <details> works without
              scripting — but it now costs one tap to reach "Set up with your
              agent". The suite's count assertion on that link runs at a desktop
              viewport, where this block is display:none, so it still sees one. */}
          <div className="col-span-2 border-t border-border-subtle md:hidden">
            {footerColumns.map((col) => (
              <details key={col.title} name="evestack-footer" className="group border-b border-border-subtle">
                <summary className="flex h-13 cursor-pointer list-none items-center justify-between px-5 font-mono text-label-12 uppercase text-gray-700 [&::-webkit-details-marker]:hidden">
                  {col.title}
                  <svg
                    viewBox="0 0 16 16"
                    width="12"
                    height="12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    aria-hidden
                    className="transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none"
                  >
                    <path d="m4 6 4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </summary>
                <ul className="pb-2">
                  {col.links.map((link) => (
                    <li key={link.label}>
                      <a
                        href={link.href}
                        {...(link.href.startsWith("http")
                          ? { target: "_blank", rel: "noreferrer" }
                          : {})}
                        className="block px-5 py-3 text-copy-14 text-gray-900 active:text-gray-1000"
                      >
                        {link.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </details>
            ))}
          </div>
        </div>

        <div className="flex flex-col items-start justify-between gap-6 border-t border-border-subtle pt-8 md:flex-row md:items-center">
          {/* Attribution and the non-affiliation notice, one block, footer-sized.
              The notice is deliberately quiet — no banner, no bar above the fold —
              but it is here rather than nowhere, because a reader wondering
              whether this is an official Vercel project looks at the footer. */}
          {/* Smaller on a phone, NOT hidden. Everything else on this page gave
              up its prose below md; this block does not, because it is the
              non-affiliation notice — the thing a reader wondering whether this
              is an official Vercel project comes to the footer to find. A copy
              diet does not get to touch a disclosure. It just reads at label
              size there instead of body size. */}
          <div className="flex flex-col gap-1">
            <p className="text-copy-14 text-gray-700 max-md:text-label-12 max-md:leading-relaxed max-md:tracking-normal">{site.attribution}</p>
            <p className="text-copy-14 text-gray-700 max-md:text-label-12 max-md:leading-relaxed max-md:tracking-normal">{site.trademark}</p>
          </div>
          <ThemeSwitcher />
        </div>
      </div>
    </footer>
  );
}
