import { describeDbFailure } from "@/lib/db";

/**
 * The one place a database failure is explained to a person.
 *
 * Five pages carried their own copy of this block, all hardcoded to "Can't
 * reach the database … Start it with `docker compose up postgres`". That is
 * right for a stopped container and actively misleading for the more common
 * case: a stack brought up without `npm run db:bootstrap`, where Postgres is
 * running, the container reports healthy, and the advice on screen is to redo
 * the step the user already did.
 *
 * `describeDbFailure` in lib/db.ts decides which failure it is. This renders it.
 *
 * Not in a `components/` directory because there isn't one, and a bare file in
 * `app/` is not a route — only page/layout/route/loading/error filenames are.
 */
export function DatabaseError({ error }: { error: unknown }) {
  const { title, detail, guidance } = describeDbFailure(error);
  return (
    <div className="empty">
      <h2>{title}</h2>
      <p className="dim">{detail}</p>
      <p className="faint">{guidance}</p>
    </div>
  );
}
