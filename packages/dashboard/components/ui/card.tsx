/**
 * The panel every other surface sits in.
 *
 * The look is not new — `app/globals.css` has drawn `background:
 * var(--bg-raised); border: 1px solid var(--border); border-radius:
 * var(--radius)` on `.stat`, `.table-wrap` and eight module-scoped blocks since
 * launch. This is that rule, once, as a component, so a card is the same card
 * on the session page and the overview.
 *
 * `headingLevel` is a prop rather than a fixed `<h2>` because W4's session
 * detail nests panes inside panes, and a page whose headings go h1 → h2 → h2 is
 * a page a screen reader user cannot skim. It defaults to 2, which is right for
 * a card directly under a page title.
 *
 * There is no `CardHeader`/`CardBody`/`CardFooter` trio. Those exist in
 * libraries that cannot know what a card contains; here the header is a title,
 * an optional description and an optional action, every time.
 */
import type { ReactNode } from "react";

export interface CardProps {
  /** Omit for a bare panel — a chart with its own title, for example. */
  readonly title?: ReactNode;
  readonly description?: ReactNode;
  /** Buttons or a menu, aligned opposite the title. */
  readonly action?: ReactNode;
  /** `h2` by default; `h3` when the card is already inside a titled section. */
  readonly headingLevel?: 2 | 3 | 4;
  readonly className?: string;
  readonly children?: ReactNode;
}

export function Card({
  title,
  description,
  action,
  headingLevel = 2,
  className,
  children,
}: CardProps) {
  const Heading = `h${headingLevel}` as "h2" | "h3" | "h4";
  const hasHeader = title !== undefined || description !== undefined || action !== undefined;
  return (
    <section
      className={["rounded-md border border-border bg-bg-raised", className]
        .filter(Boolean)
        .join(" ")}
    >
      {hasHeader ? (
        <header className="flex items-start justify-between gap-4 border-b border-border px-4 py-3.5">
          <div className="min-w-0">
            {title !== undefined ? (
              <Heading className="m-0 text-section font-semibold text-text">{title}</Heading>
            ) : null}
            {description !== undefined ? (
              <p className="mt-1 mb-0 text-small text-text-dim">{description}</p>
            ) : null}
          </div>
          {action !== undefined ? <div className="shrink-0">{action}</div> : null}
        </header>
      ) : null}
      <div className="p-4">{children}</div>
    </section>
  );
}
