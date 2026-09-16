import { deliveryStatus } from "@/lib/alert-delivery";
import { DeliveryTest } from "@/app/monitors/delivery-test";
import { composioApiKey, composioUserId } from "@/app/integrations/composio";
import { RepositorySetup } from "./repository-setup";
export const dynamic = "force-dynamic";
export default async function ConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; error?: string }>;
}) {
  const params = await searchParams;
  const notifications = await deliveryStatus();
  return (
    <>
      <h1>Connections</h1>
      <p className="page-sub">
        Connect the accounts and delivery channels your task needs.
      </p>
      {typeof params.connected === "string" && (
        <p role="status">
          Returned from {params.connected.slice(0, 64)} authorization. Use Check
          authorization to inspect its current status.
        </p>
      )}
      {typeof params.error === "string" && (
        <p role="alert">
          Connection could not be confirmed: {params.error.slice(0, 300)}
        </p>
      )}
      <RepositorySetup
        configured={Boolean(composioApiKey())}
        identity={composioUserId()}
      />
      <div className="workspace-grid">
        <section className="workspace-section">
          <h2>Notifications</h2>
          <p>
            {notifications.configured
              ? `Configured: ${notifications.sinks.join(", ")}. Routine results, failures and pending decisions use these operator-controlled destinations.`
              : "No destination configured. Set EVESTACK_ALERT_WEBHOOK_URL in the dashboard environment to your Slack, Discord or HTTP webhook, then restart the dashboard."}
          </p>
          <p className="page-sub">
            Set <code>EVESTACK_PUBLIC_URL</code> to include links back to your
            task. Generic webhooks can verify{" "}
            <code>EVESTACK_ALERT_WEBHOOK_SECRET</code> signatures. Keep
            credentials in your deployment environment.
          </p>
          {notifications.unreadable && (
            <p role="status">
              Delivery history unavailable: {notifications.unreadable}
            </p>
          )}
          {notifications.lastDeliveryAt && (
            <p>
              Last monitor/test destination response:{" "}
              {notifications.lastDeliveryOk ? "accepted" : "failed"} ·{" "}
              {new Date(notifications.lastDeliveryAt).toLocaleString("en", {
                timeZone: "UTC",
              })}{" "}
              UTC. Routine delivery status appears in each routine's history.
            </p>
          )}
          {notifications.configured && (
            <DeliveryTest sinks={notifications.sinks} />
          )}
          <p className="page-sub">
            A test sends one synthetic message to each configured destination. A
            successful HTTP response confirms acceptance; check the channel for
            receipt.
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
