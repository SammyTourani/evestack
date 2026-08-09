"use client";

/**
 * The sessions table: columns, the CSV button, and nothing else.
 *
 * The table itself is `components/ui/table.tsx` — TanStack v8 sorting, faceted
 * filters with live counts, a global search box and virtualization, all already
 * built and already accessibility-reviewed. This file only says what the
 * columns are.
 *
 * WHY IT IS A SEPARATE FILE FROM `page.tsx`. A column definition carries `cell`
 * and `accessorFn`, which are functions, and functions cannot cross the
 * server/client boundary. `app/chat`, `app/memory`, `app/schedules` and
 * `app/sessions/[id]` all split the same way and use the same `-client` suffix.
 *
 * WHY THE IMPORTS ARE RELATIVE where the other pages use `@/` — see the header
 * of `./rollup.ts`.
 *
 * ── The one thing that is missing, stated plainly ────────────────────────────
 *
 * Export writes the rows the SERVER sent, not the rows the facet chips leave
 * standing, and there are no saved views. Both want the same thing: the
 * filter/search state, which lives in `useState` inside `DataTable` and is not
 * exposed. Reaching it needs one prop on `components/ui/table.tsx`
 * (`onStateChange`, or lifting `columnFilters`/`globalFilter` to controlled
 * props), which is a shared file another wave is editing. Rather than fork the
 * table or rebuild a second set of facet chips beside it — the exact defect the
 * brief calls out — the button counts what it will write and says so.
 */

import { useMemo } from "react";

import { OutcomeBadge } from "../../components/ui/badge";
import { EM_DASH, coverageNote, formatCost, formatMetric } from "../../components/ui/format";
import { CONTROL } from "../../components/ui/style";
import { DataTable, type TableColumn } from "../../components/ui/table";
import { ago, duration, stamp } from "../../lib/time";
import { DEFAULT_PAGE_SIZE, type SessionListRow, toCsv } from "./rollup";

/** Wall clock is not the agent's clock. Said once, used by the cell and the CSV note. */
const WORK_NOTE =
  "Sum of this session's turn durations. A session's wall clock measures how long a " +
  "person left it open, not how long the agent worked.";

function CostCell({ row }: { readonly row: SessionListRow }) {
  const modelTurns = row.pricedTurns + row.unpricedTurns;

  // No turn reached a provider. Not free, not unpriced — unmeasured.
  if (modelTurns === 0) {
    return (
      <span title="No turn in this session recorded a model call, so there is nothing to price.">
        {EM_DASH}
      </span>
    );
  }

  // Every model in the session is missing from the price catalog. `formatCost`
  // owns the word so this page and every stat tile use the same one.
  if (row.pricedTurns === 0) {
    return (
      <span
        className="text-warn"
        title={
          `${modelTurns} of ${row.turns} turns ran a model with no configured rate. ` +
          "Their spend is unknown, which is not the same as zero: a local model that " +
          "really costs nothing renders a dollar amount here."
        }
      >
        {formatCost(null, false)}
      </span>
    );
  }

  const partial = row.unpricedTurns > 0;
  return (
    <span
      className="tabular-nums"
      title={
        partial
          ? `${row.unpricedTurns} of ${modelTurns} turns ran an unpriced model; their spend is ` +
            "not in this figure."
          : undefined
      }
    >
      {formatCost(row.costUsd, true)}
      {partial ? <span className="text-warn"> + unpriced</span> : null}
    </span>
  );
}

function ToolsCell({ row }: { readonly row: SessionListRow }) {
  // `coverageNote` owns the sentence; the clause after it says why coverage is
  // partial here specifically, which is the part a reader cannot infer.
  const note = coverageNote({ rows: row.spanTurns, of: row.turns }, "turns");
  const title =
    note === null
      ? undefined
      : `${note} Tool calls are counted from spans, and the trace tier is opt-in.`;

  if (row.spanTurns === 0) return <span title={title}>{EM_DASH}</span>;
  return (
    <span className="tabular-nums" title={title}>
      {formatMetric(row.toolsCalled, "count")}
      {note === null ? null : <span className="text-warn"> *</span>}
    </span>
  );
}

/**
 * `now` is a prop rather than `Date.now()` inside the cell so the server pass
 * and the hydration pass produce the same string. `ago()` warns about exactly
 * this, and a mismatch here would be 250 hydration errors at once.
 */
function makeColumns(now: number): TableColumn<SessionListRow>[] {
  return [
    {
      id: "outcome",
      header: "outcome",
      accessorFn: (row) => row.outcome,
      cell: ({ row }) =>
        row.original.outcome === null ? (
          <span title="No turn recorded yet — too young to judge, not healthy.">{EM_DASH}</span>
        ) : (
          <OutcomeBadge outcome={row.original.outcome} />
        ),
    },
    {
      id: "session",
      // Title and id in ONE column value, so the search box covers both without
      // a second column to scroll past, and so sorting by `session` sorts by
      // title — which is what the header promises.
      header: "session",
      accessorFn: (row) => `${row.title ?? ""} ${row.id}`,
      cell: ({ row }) => (
        <a href={`/sessions/${row.original.id}`} className="block max-w-104 hover:text-accent">
          <span className="block truncate text-text">
            {row.original.title ?? <span className="text-text-faint">untitled</span>}
          </span>
          <span className="block truncate font-mono text-micro text-text-faint">
            {row.original.id}
          </span>
        </a>
      ),
    },
    { id: "trigger", header: "trigger", accessorFn: (row) => row.trigger },
    {
      id: "model",
      header: "model",
      accessorFn: (row) => row.model,
      cell: ({ getValue }) =>
        getValue() === null ? EM_DASH : <span className="font-mono text-small">{getValue()}</span>,
    },
    { id: "provider", header: "provider", accessorFn: (row) => row.provider },
    { id: "environment", header: "environment", accessorFn: (row) => row.environment },
    { id: "runType", header: "run type", accessorFn: (row) => row.runType },
    {
      id: "turns",
      header: "turns",
      accessorFn: (row) => row.turns,
      cell: ({ getValue }) => <span className="tabular-nums">{formatMetric(getValue(), "count")}</span>,
    },
    {
      id: "duration",
      header: "duration",
      accessorFn: (row) => row.workMs ?? undefined,
      // Absent last in BOTH directions. TanStack's default comparator treats
      // null as 0, which would file a session nobody timed among the fastest.
      sortUndefined: "last",
      cell: ({ row }) => {
        const note = coverageNote({ rows: row.original.timedTurns, of: row.original.turns }, "turns");
        return (
          <span className="tabular-nums" title={note === null ? WORK_NOTE : `${WORK_NOTE} ${note}`}>
            {duration(row.original.workMs)}
            {note === null ? null : <span className="text-warn"> *</span>}
          </span>
        );
      },
    },
    {
      id: "tokens",
      header: "tokens",
      accessorFn: (row) => row.inputTokens + row.outputTokens,
      cell: ({ row, getValue }) => (
        <span
          className="tabular-nums"
          title={
            `${formatMetric(row.original.inputTokens, "tokens")} in · ` +
            `${formatMetric(row.original.outputTokens, "tokens")} out · ` +
            `${formatMetric(row.original.cacheReadTokens, "tokens")} cache read · ` +
            `${formatMetric(row.original.cacheWriteTokens, "tokens")} cache write`
          }
        >
          {formatMetric(getValue(), "tokens")}
        </span>
      ),
    },
    {
      id: "cost",
      header: "cost",
      accessorFn: (row) => row.costUsd ?? undefined,
      sortUndefined: "last",
      cell: ({ row }) => <CostCell row={row.original} />,
    },
    {
      id: "tools",
      header: "tools called",
      accessorFn: (row) => row.toolsCalled ?? undefined,
      sortUndefined: "last",
      cell: ({ row }) => <ToolsCell row={row.original} />,
    },
    {
      id: "when",
      header: "when",
      // The ISO string, not an epoch: it sorts chronologically anyway (one
      // fixed format, UTC, zero-padded) and it lets the search box match a date.
      accessorFn: (row) => row.createdAt,
      cell: ({ row }) => (
        <span className="whitespace-nowrap" title={stamp(row.original.createdAt, "second")}>
          {ago(row.original.createdAt, now)}
        </span>
      ),
    },
  ];
}

function ExportButton({ rows, now }: { readonly rows: readonly SessionListRow[]; readonly now: number }) {
  const download = () => {
    const url = URL.createObjectURL(new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `evestack-sessions-${new Date(now).toISOString().slice(0, 10)}.csv`;
    link.click();
    // Released on the next tick, not inside the handler: the download reads the
    // blob after the click returns, and revoking first cancels it.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  return (
    <button
      type="button"
      className={CONTROL}
      onClick={download}
      title={
        "Downloads the sessions loaded on this page, with the numbers unformatted. Spend with " +
        "no configured rate is written as an empty cell, never 0. The facet chips are not " +
        "applied — see the note in app/sessions/sessions-client.tsx."
      }
    >
      Export CSV ({rows.length})
    </button>
  );
}

export function SessionsTable({
  rows,
  now,
  outcome,
}: {
  readonly rows: readonly SessionListRow[];
  readonly now: number;
  /**
   * A facet to open with, from `?outcome=` — how the wedged-turns alert deep
   * links here. Validated server-side against the `fact_turn` CHECK constraint,
   * so anything that arrives is a value the column can actually hold.
   */
  readonly outcome?: string;
}) {
  const columns = useMemo(() => makeColumns(now), [now]);
  return (
    <DataTable
      data={rows}
      columns={columns}
      caption="Agent sessions on this machine, one row per session, newest first."
      emptyTitle="No session matches these filters"
      emptyDetail="Clear a facet or widen the search. Filters only see the sessions loaded on this page."
      facetColumns={["outcome", "trigger", "model", "provider", "environment", "runType"]}
      searchPlaceholder="Search sessions"
      initialSorting={[{ id: "when", desc: true }]}
      initialColumnFilters={outcome ? [{ id: "outcome", value: [outcome] }] : undefined}
      getRowId={(row) => row.id}
      toolbar={<ExportButton rows={rows} now={now} />}
      virtualizeAfter={DEFAULT_PAGE_SIZE}
    />
  );
}
