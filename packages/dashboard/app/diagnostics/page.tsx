const SECTIONS = [
  [
    "/overview",
    "Activity & performance",
    "Trends, latency, costs and coverage.",
  ],
  [
    "/monitors",
    "Health & incidents",
    "Actionable checks, unknown states and notification delivery.",
  ],
  ["/traces", "Traces", "Recorded model calls and tool evidence."],
  ["/costs", "Spend", "Recorded costs, missing prices and usage."],
  [
    "/sessions",
    "Run explorer",
    "Search, sort, export and inspect the full run tree.",
  ],
  [
    "/sandboxes",
    "Execution environments",
    "Read-only inspection of containers on this host.",
  ],
  [
    "/evals",
    "Regression drafts",
    "Turn a recorded interaction into a test case.",
  ],
];
export default function DiagnosticsPage() {
  return (
    <>
      <h1>Diagnostics</h1>
      <p className="page-sub">
        Inspect the evidence behind your tasks and the health of this
        installation.
      </p>
      <div className="workspace-grid">
        {SECTIONS.map(([href, title, description]) => (
          <a className="workspace-section" href={href} key={href}>
            <h2>{title}</h2>
            <p>{description}</p>
          </a>
        ))}
      </div>
    </>
  );
}
