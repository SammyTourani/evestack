import { nav, site } from "@/lib/copy";
import { Button } from "@/components/ui/button";
import { GitHubIcon } from "@/components/ui/github-icon";

/* The header is shared with the /docs route, where a bare "#compare" points
   at a section that isn't on the page. Home-absolute anchors work from both:
   on the landing page the browser still treats them as same-document. */
const homeAnchor = (href: string) => (href.startsWith("#") ? `/${href}` : href);

export function SiteHeader() {
  return (
    <header
      id="site-header"
      className="sticky top-0 z-50 border-b border-transparent bg-background-100/70 backdrop-blur-md transition-colors duration-300 data-scrolled:border-border-subtle"
    >
      {/* Trademark notice sits HERE, above the fold, not in the footer. This
          site is named after and built on someone else's trademark; a visitor
          should learn that in the first viewport, not after scrolling past
          every claim we make. */}
      <p className="border-b border-border-subtle bg-background-200/60 py-1.5 text-center text-label-12 text-gray-700">
        {site.trademark}
      </p>

      <div className="site-container flex h-16 items-center justify-between gap-4">
        <a href="#hero" className="flex items-center gap-2 text-copy-16 font-medium">
          <span aria-hidden className="text-blue-700">
            {site.mark}
          </span>
          {site.name}
        </a>

        <nav aria-label="Site" data-scrollspy className="hidden md:block">
          <ul className="flex items-center gap-6">
            {nav.map((item) => (
              <li key={item.href}>
                <a
                  href={homeAnchor(item.href)}
                  className="text-copy-14 text-gray-900 transition-colors hover:text-gray-1000 data-active:text-gray-1000"
                >
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="hidden items-center gap-3 md:flex">
          {/* Outside the scrollspy nav on purpose: that list is anchor-only,
              and a route link would never match a section. */}
          <a
            href="/docs"
            className="text-copy-14 text-gray-900 transition-colors hover:text-gray-1000"
          >
            Docs
          </a>
          {/* /compat is the most falsifiable thing on this site — every
              published eve release run through the contract suite, reds
              included — and until now nothing on the landing page pointed at
              it. */}
          <a
            href={site.compat}
            className="text-copy-14 text-gray-900 transition-colors hover:text-gray-1000"
          >
            Compatibility
          </a>
          <a
            href={site.github}
            target="_blank"
            rel="noreferrer"
            aria-label="evestack on GitHub"
            className="text-gray-900 transition-colors hover:text-gray-1000"
          >
            <GitHubIcon />
          </a>
          <Button href={homeAnchor("#quickstart")} size="md">
            Get started
          </Button>
        </div>

        {/* Mobile nav — native details/summary, zero JS */}
        <details className="group relative md:hidden">
          <summary
            className="flex h-10 w-10 cursor-pointer list-none items-center justify-center rounded-full border border-border-default [&::-webkit-details-marker]:hidden"
            aria-label="Menu"
          >
            <span aria-hidden className="flex flex-col gap-1">
              <span className="h-px w-4 bg-gray-1000 transition-transform group-open:translate-y-[2.5px] group-open:rotate-45" />
              <span className="h-px w-4 bg-gray-1000 transition-transform group-open:-translate-y-[2.5px] group-open:-rotate-45" />
            </span>
          </summary>
          <nav
            aria-label="Site"
            className="absolute right-0 top-12 w-56 rounded-xl border border-border-default bg-background-100 p-2 shadow-2xl"
          >
            <ul className="flex flex-col">
              {nav.map((item) => (
                <li key={item.href}>
                  <a
                    href={item.href}
                    className="block rounded-lg px-3 py-2 text-copy-14 text-gray-900 hover:bg-gray-100 hover:text-gray-1000"
                  >
                    {item.label}
                  </a>
                </li>
              ))}
              <li className="mt-1 border-t border-border-subtle pt-1">
                <a
                  href="/docs"
                  className="block rounded-lg px-3 py-2 text-copy-14 text-gray-900 hover:bg-gray-100 hover:text-gray-1000"
                >
                  Docs
                </a>
              </li>
              <li>
                <a
                  href={site.compat}
                  className="block rounded-lg px-3 py-2 text-copy-14 text-gray-900 hover:bg-gray-100 hover:text-gray-1000"
                >
                  Compatibility
                </a>
              </li>
              <li>
                <a
                  href={site.github}
                  target="_blank"
                  rel="noreferrer"
                  className="block rounded-lg px-3 py-2 text-copy-14 text-gray-900 hover:bg-gray-100 hover:text-gray-1000"
                >
                  GitHub
                </a>
              </li>
            </ul>
          </nav>
        </details>
      </div>
    </header>
  );
}
