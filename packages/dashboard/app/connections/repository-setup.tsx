"use client";

import { useEffect, useRef, useState } from "react";
import {
  CONNECTION_DRAFT_KEY,
  repositoryBrief,
  validRepository,
} from "@/lib/task-examples";

interface Check {
  configured: boolean;
  identity: string;
  status: string;
  checkedAt?: string;
  accounts?: { id: string; status: string; statusReason: string | null }[];
  coverage?: { complete: boolean; scanned: number; limit: number };
  otherIdentityAccounts?: number;
}
const REPOSITORY_KEY = "evestack.repository-setup";

export function RepositorySetup({
  configured,
  identity,
}: {
  configured: boolean;
  identity: string;
}) {
  const [repository, setRepository] = useState("");
  const [check, setCheck] = useState<Check | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    try {
      setRepository(sessionStorage.getItem(REPOSITORY_KEY) ?? "");
    } catch {
      /* A draft can still be entered. */
    }
    return () => controller.current?.abort();
  }, []);

  async function inspect() {
    if (controller.current) return;
    const abort = new AbortController();
    controller.current = abort;
    const timer = setTimeout(() => abort.abort(), 15_000);
    setChecking(true);
    setError(null);
    setCheck(null);
    try {
      const response = await fetch("/api/connections/check?toolkit=github", {
        signal: abort.signal,
        cache: "no-store",
      });
      const body = await response.json();
      if (!response.ok || body.ok !== true)
        throw new Error(body.error ?? "Authorization check failed.");
      setCheck(body);
    } catch (error) {
      setError(
        error instanceof Error && error.name !== "AbortError"
          ? error.message
          : "The check timed out. Try again when the dashboard is reachable.",
      );
    } finally {
      clearTimeout(timer);
      controller.current = null;
      setChecking(false);
    }
  }

  function saveRepository(value: string) {
    setRepository(value);
    try {
      sessionStorage.setItem(REPOSITORY_KEY, value);
    } catch {
      /* Opening the draft reports unavailable storage. */
    }
  }
  function openDraft() {
    const value = repository.trim();
    if (!validRepository(value)) {
      setError("Enter a repository as owner/repository.");
      return;
    }
    try {
      sessionStorage.setItem(CONNECTION_DRAFT_KEY, repositoryBrief(value));
      window.location.assign("/chat?draft=connection");
    } catch {
      setError(
        "Browser draft storage is unavailable. Open a new task and enter your repository request there.",
      );
    }
  }

  return (
    <section className="workspace-section repository-setup">
      <h2>Repository maintenance brief</h2>
      <p>
        Get a report of recent changes, failing checks and issues needing
        attention, with links you can verify.
      </p>
      <div className="routine-form">
        <label>
          Repository
          <input
            value={repository}
            onChange={(event) => saveRepository(event.target.value)}
            placeholder="owner/repository"
            maxLength={200}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
      </div>
      <h3>1. Authorize the account this agent uses</h3>
      <p>
        Connect GitHub and review the repositories and permissions this agent
        may use. Composio hosts authorization.
      </p>
      <p className="page-sub">Installation identity: <code>{identity}</code>.</p>
      {configured ? (
        <div className="workspace-actions">
          <form action="/integrations/connect" method="post">
            <input type="hidden" name="toolkit" value="github" />
            <input type="hidden" name="returnTo" value="repository-brief" />
            <button type="submit">Connect or reauthorize GitHub</button>
          </form>
          <button
            type="button"
            disabled={checking}
            onClick={() => void inspect()}
          >
            {checking ? "Checking…" : "Check authorization"}
          </button>
        </div>
      ) : (
        <p>
          Add <code>COMPOSIO_API_KEY</code> to your project environment and
          restart the agent and dashboard.{" "}
          <a href="/integrations">Open connection setup</a>.
        </p>
      )}
      {check && (
        <div role="status" className="workspace-section">
          <strong>
            {check.status === "active"
              ? "Active GitHub authorization found"
              : check.status === "attention"
                ? "GitHub authorization needs attention"
                : check.status === "missing"
                  ? "No matching GitHub authorization found"
                  : "Authorization could not be confirmed"}
          </strong>
          {!!check.otherIdentityAccounts && (
            <p>
              Other GitHub grants were returned for a different or unknown
              identity. They do not confirm this agent's access.
            </p>
          )}
          {check.coverage && !check.coverage.complete && (
            <p>
              Only {check.coverage.scanned} account records were checked. The
              account list is incomplete.
            </p>
          )}
          <p className="page-sub">
            This checks the authorization record only. Repository access and
            tool permissions still need verification in the task.
          </p>
          {!!check.accounts?.length && <details><summary>Account records</summary>{check.accounts.map(account => <p key={account.id}><code>{account.id}</code>: {account.status.toLowerCase()}{account.statusReason ? ` · ${account.statusReason}` : ""}</p>)}</details>}
          {check.checkedAt && (
            <p className="page-sub">
              Checked {new Date(check.checkedAt).toLocaleString()}.
            </p>
          )}
        </div>
      )}
      <h3>2. Run and inspect the brief</h3>
      <p>
        The draft asks for reading and reporting. Your account and tool
        permissions enforce what the agent can do. Verify the result and its
        source links, then use <strong>Save request as routine</strong> in the
        task.
      </p>
      <div className="workspace-actions">
        <button type="button" className="primary-action" onClick={openDraft}>
          Open task draft
        </button>
        <a href="/integrations?q=github">Manage connected accounts</a>
      </div>
      {error && <p role="alert">{error}</p>}
      <details>
        <summary>Permissions and revocation</summary>
        <p>
          Granted scopes are not returned by this account check. Inspect the
          GitHub authorization screen and your GitHub account's application
          settings. Revoke access at GitHub when you no longer need it, then
          recheck here. Agents with a custom Composio identity must use the same
          identity configured in the dashboard.
        </p>
      </details>
    </section>
  );
}
