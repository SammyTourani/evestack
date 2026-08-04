import { nav, site } from "@/lib/copy";
import { Button } from "@/components/ui/button";

function GitHubIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

export function SiteHeader() {
  return (
    <header
      id="site-header"
      className="sticky top-0 z-50 border-b border-transparent bg-background-100/70 backdrop-blur-md transition-colors duration-300 data-scrolled:border-border-subtle"
    >
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
                  href={item.href}
                  className="text-copy-14 text-gray-900 transition-colors hover:text-gray-1000 data-active:text-gray-1000"
                >
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="hidden items-center gap-3 md:flex">
          <a
            href={site.github}
            target="_blank"
            rel="noreferrer"
            aria-label="evestack on GitHub"
            className="text-gray-900 transition-colors hover:text-gray-1000"
          >
            <GitHubIcon />
          </a>
          <Button href="#quickstart" size="md">
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
