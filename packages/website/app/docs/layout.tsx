import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { RootProvider } from "fumadocs-ui/provider/next";
import { source } from "@/lib/docs-source";
import { site } from "@/lib/copy";
import "./docs.css";

/* theme.enabled=false: the site already owns next-themes in components/
   providers.tsx. Two ThemeProviders fight over the html class and the docs
   would flip themes independently of the rest of the site. */
export default function DocsRouteLayout({ children }: { children: React.ReactNode }) {
  return (
    <RootProvider theme={{ enabled: false }}>
      <DocsLayout
        tree={source.pageTree}
        nav={{ title: `${site.mark} ${site.name} docs`, url: "/docs" }}
        sidebar={{ defaultOpenLevel: 1 }}
      >
        {children}
      </DocsLayout>
    </RootProvider>
  );
}
