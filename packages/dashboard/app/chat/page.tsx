import { ChatClient } from "./chat-client";

export const dynamic = "force-dynamic";

/**
 * `?session=<id>` reattaches to an existing durable session, so a run started
 * from Slack or curl can be picked up here. Sessions outlive the browser tab —
 * that is the whole point of eve's durability — so the UI must be able to join
 * one it did not start.
 */
export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<{ session?: string }>;
}) {
  const { session } = await searchParams;
  return <ChatClient initialSessionId={session} />;
}
