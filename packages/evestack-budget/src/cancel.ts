import type { BudgetConfig } from "./config.js";

/**
 * Stopping a turn from a hook.
 *
 * A hook is observe-only: it cannot block a turn, deny a step, or inject
 * context. What it *can* do is perform side effects, and eve publishes a
 * documented cancel route on its own HTTP API. So the stop is the agent asking
 * itself to stop.
 *
 * What this does NOT do — and the README says so in the same words — is kill a
 * generation that is already running. eve threads no `abortSignal` into model
 * calls (vercel/eve#483), so cancellation is cooperative: the in-flight call
 * finishes and bills, `turn.cancelled` arrives after it settles. Enforcement is
 * necessarily *between* steps.
 */

export type CancelStatus = "accepted" | "no_active_turn" | "error";

export interface CancelResult {
  readonly status: CancelStatus;
  readonly httpStatus?: number;
  readonly detail?: string;
}

export async function cancelTurn(
  config: BudgetConfig,
  input: { readonly sessionId: string; readonly turnId?: string },
): Promise<CancelResult> {
  const url = `${config.agentUrl.replace(/\/$/, "")}/eve/v1/session/${encodeURIComponent(
    input.sessionId,
  )}/cancel`;

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (config.authUser && config.authPassword) {
    const encoded = Buffer.from(`${config.authUser}:${config.authPassword}`).toString("base64");
    headers.authorization = `Basic ${encoded}`;
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      // `turnId` scopes the cancel to the turn we actually observed. Without it
      // a slow round-trip could land on a turn the user started afterwards;
      // eve consumes a mismatched guard as a benign no-op.
      body: JSON.stringify(input.turnId ? { turnId: input.turnId } : {}),
      // The cap has already been crossed by the time we get here. Hanging on
      // this request would hold up the emit path and, with it, the turn.
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) {
      return {
        status: "error",
        httpStatus: response.status,
        detail: await response.text().catch(() => ""),
      };
    }

    const body = (await response.json()) as { status?: string };
    return body.status === "no_active_turn"
      ? { status: "no_active_turn", httpStatus: response.status }
      : { status: "accepted", httpStatus: response.status };
  } catch (error) {
    return { status: "error", detail: error instanceof Error ? error.message : String(error) };
  }
}
