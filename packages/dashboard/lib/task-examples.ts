export function repositoryBrief(repository = "[owner/repository]") {
  return `Prepare a repository maintenance brief for ${repository}. Review recent changes, failing checks and issues needing attention. Include links supporting each finding and a short list of suggested next steps. State the connected account and repository you actually accessed. Read and report only; do not change files, issues, settings, or send messages. If the repository or account is unavailable, explain what is missing.`;
}

export function validRepository(value: string) {
  return (
    value.length <= 200 &&
    /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+$/.test(value) &&
    !value.split("/").some((part) => part === "." || part === "..")
  );
}

export const CONNECTION_DRAFT_KEY = "evestack.connection-task-draft";
export const MEMORY_DRAFT_KEY = "evestack.memory-task-draft";
