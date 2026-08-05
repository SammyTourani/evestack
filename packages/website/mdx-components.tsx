import defaultComponents from "fumadocs-ui/mdx";
import { Callout } from "fumadocs-ui/components/callout";
import { Card, Cards } from "fumadocs-ui/components/card";
import { Step, Steps } from "fumadocs-ui/components/steps";
import type { MDXComponents } from "mdx/types";

/* The pages were authored against Mintlify's component names. Rather than
   rewrite 14 files (and re-verify every claim in them), we map those names
   onto Fumadocs equivalents here — the MDX is the source of truth and stays
   portable. <Steps>/<Step> need no mapping: the tag names are identical.

   Mintlify-only props are dropped deliberately: <Card icon> takes a Font
   Awesome name Fumadocs can't resolve, and <CardGroup cols> is fixed at a
   responsive 2-up by Fumadocs' own grid. */
type CardProps = {
  title?: string;
  href?: string;
  icon?: unknown;
  children?: React.ReactNode;
};

/* The cast is an upstream type-variance quirk, not a real mismatch: a few of
   fumadocs' own default entries (`light`, `dark`) are typed `Component<never>`,
   which no value can satisfy under mdx/types' index signature. The runtime
   shape is correct. */
export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultComponents,
    Steps,
    Step,
    Cards,
    Note: (props: { children?: React.ReactNode }) => (
      <Callout type="info">{props.children}</Callout>
    ),
    Warning: (props: { children?: React.ReactNode }) => (
      <Callout type="warn">{props.children}</Callout>
    ),
    Tip: (props: { children?: React.ReactNode }) => (
      <Callout type="info">{props.children}</Callout>
    ),
    Info: (props: { children?: React.ReactNode }) => (
      <Callout type="info">{props.children}</Callout>
    ),
    Card: ({ title, href, children }: CardProps) => (
      <Card title={title ?? ""} href={href}>
        {children}
      </Card>
    ),
    CardGroup: (props: { children?: React.ReactNode }) => <Cards>{props.children}</Cards>,
    ...components,
  } as MDXComponents;
}
