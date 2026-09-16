import { readReadiness } from "@/lib/readiness";
import { ReadinessChecks } from "@/components/readiness-checks";
import { BudgetSettings } from "@/components/budget-settings";
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const state = await readReadiness();
  return (
    <>
      <div className="workspace-heading">
        <div>
          <h1>Settings &amp; setup</h1>
          <p className="page-sub">
            Readiness, configuration sources and data ownership.
          </p>
        </div>
        <a className="primary-action" href="/settings">
          Check again
        </a>
      </div>
      <ReadinessChecks initialChecks={state.checks} />
      <section className="workspace-section">
        <h2>Model &amp; embeddings</h2>
        <p>
          The model is configured in your agent project. Use{" "}
          <code>npx evestack verify</code> to check the installation and{" "}
          <code>npx evestack tour</code> to make a real model request. Model and
          embedding credentials belong to the agent process; changing dashboard
          environment values alone does not activate a model.
        </p>
        <p>
          Use <code>npx evestack configure --help</code> in your agent project
          to preview provider or channel edits and save a private backup before
          applying them. Review <code>agent/agent.ts</code> for custom behavior.
          Restart the agent after provider or credential changes.
          Server deployments need provider credentials available to that server.
        </p>
        <a href="/chat?example=repository-brief">Run a useful first task</a>
      </section>
      <BudgetSettings />
      <section className="workspace-section">
        <h2>Data &amp; access</h2>
        <p>
          Session history and telemetry are stored in your Postgres. Requests
          are sent to your configured model provider; connected-account
          authorization uses Composio when enabled. This dashboard uses an
          installation credential. It does not provide isolated team accounts.
        </p>
        <p>
          Memory deletion removes a fact from recall and retains an audit copy.
          Back up Postgres and your project configuration before upgrades;
          retain encrypted backups according to your own policy.
        </p>
      </section>
    </>
  );
}
