export default function ConnectionsPage() {
  return (
    <>
      <h1>Connections</h1>
      <p className="page-sub">
        Connect the accounts and delivery channels your task needs.
      </p>
      <section className="workspace-section">
        <h2>Start with a repository maintenance brief</h2>
        <p>
          Connect your repository account, select the repository in your
          request, and ask for a report with links. Review account permissions
          before authorizing a connection.
        </p>
        <div className="workspace-actions">
          <a className="primary-action" href="/integrations">
            Manage connected accounts
          </a>
          <a href="/chat?example=repository-brief">Try the brief</a>
        </div>
        <p className="page-sub">
          Account authorization uses Composio, a hosted OAuth service. Model
          requests go to the model provider configured in your agent.
        </p>
      </section>
      <div className="workspace-grid">
        <section className="workspace-section">
          <h2>Notifications</h2>
          <p>
            Inspect the configured notification destination and its delivery
            health.
          </p>
          <a href="/monitors">Open delivery status</a>
        </section>
        <section className="workspace-section">
          <h2>Telegram, Slack &amp; Discord</h2>
          <p>
            Inbound channels run in your agent process. Configure the channel
            credentials and allowed people in your project, then send a test
            request and find its task here.
          </p>
          <a href="/settings">Connection setup details</a>
        </section>
      </div>
    </>
  );
}
