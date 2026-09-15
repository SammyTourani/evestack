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
  searchParams: Promise<{ session?: string; example?: string }>;
}) {
  const { session, example } = await searchParams;
  return (
    <ChatClient
      initialSessionId={session}
      initialDraft={
        example === "repository-brief"
          ? "Prepare a repository maintenance brief for [owner/repository]. Review recent changes, failing checks and issues needing attention. Include links supporting each finding and a short list of suggested next steps. Read and report only; do not change files, issues, settings, or send messages. If the repository or account is unavailable, explain what is missing."
          : undefined
      }
    />
  );
}
