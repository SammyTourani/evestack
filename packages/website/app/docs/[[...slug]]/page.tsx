import { notFound } from "next/navigation";
import { DocsPage, DocsBody, DocsTitle, DocsDescription } from "fumadocs-ui/layouts/docs/page";
import { source } from "@/lib/docs-source";
import { getMDXComponents } from "@/mdx-components";

export default async function DocsPageRoute(props: {
  params: Promise<{ slug?: string[] }>;
}) {
  const { slug } = await props.params;
  const page = source.getPage(slug);
  if (!page) notFound();

  const MDX = page.data.body;
  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        <MDX components={getMDXComponents()} />
      </DocsBody>
    </DocsPage>
  );
}

/* output:"export" needs every docs route enumerated at build time. */
export function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(props: {
  params: Promise<{ slug?: string[] }>;
}) {
  const { slug } = await props.params;
  const page = source.getPage(slug);
  if (!page) return {};
  return { title: page.data.title, description: page.data.description };
}
