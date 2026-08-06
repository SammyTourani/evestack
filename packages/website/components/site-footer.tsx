import { footerColumns, site } from "@/lib/copy";
import { ThemeSwitcher } from "@/components/ui/theme-switcher";

export function SiteFooter() {
  return (
    <footer className="section-rule">
      <div className="site-container flex flex-col gap-12 py-16">
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
            <nav key={col.title} aria-label={col.title} className="flex flex-col gap-3">
              <p className="font-mono text-label-12 uppercase text-gray-700">{col.title}</p>
              <ul className="flex flex-col gap-2">
                {col.links.map((link) => (
                  <li key={link.label}>
                    <a
                      href={link.href}
                      {...(link.href.startsWith("http")
                        ? { target: "_blank", rel: "noreferrer" }
                        : {})}
                      className="text-copy-14 text-gray-900 transition-colors hover:text-gray-1000"
                    >
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <div className="flex flex-col items-start justify-between gap-6 border-t border-border-subtle pt-8 md:flex-row md:items-center">
          {/* Attribution and the non-affiliation notice, one block, footer-sized.
              The notice is deliberately quiet — no banner, no bar above the fold —
              but it is here rather than nowhere, because a reader wondering
              whether this is an official Vercel project looks at the footer. */}
          <div className="flex flex-col gap-1">
            <p className="text-copy-14 text-gray-700">{site.attribution}</p>
            <p className="text-copy-14 text-gray-700">{site.trademark}</p>
          </div>
          <ThemeSwitcher />
        </div>
      </div>
    </footer>
  );
}
