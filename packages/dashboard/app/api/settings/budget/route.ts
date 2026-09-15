import {
  BudgetSettingsError,
  readBudgetSettings,
  saveBudgetSettings,
} from "@evestack/budget/settings";
import { identifyApprover } from "@/lib/approvals";
import { readBudgetCaps } from "@/lib/budget-env";
import {
  isResponse,
  jsonError,
  jsonOk,
  readJsonObject,
} from "@/app/api/control/_http";
export const dynamic = "force-dynamic";
const databaseUrl = () =>
  process.env.WORKFLOW_POSTGRES_URL ?? process.env.DATABASE_URL;
export async function GET() {
  try {
    return jsonOk({
      ...(await readBudgetSettings(databaseUrl())),
      defaults: {
        ...readBudgetCaps(process.env),
        timeZone: process.env.EVESTACK_BUDGET_TIMEZONE ?? "UTC",
      },
    });
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : String(error),
      503,
      "unavailable",
    );
  }
}
export async function PUT(request: Request) {
  try {
    const body = await readJsonObject(request);
    if (isResponse(body)) return body;
    if (!Number.isSafeInteger(body.revision) || Number(body.revision) < 0)
      return jsonError(
        "A current settings revision is required.",
        400,
        "bad_request",
      );
    const identity = identifyApprover(request);
    const settings = await saveBudgetSettings(
      databaseUrl(),
      body.policy,
      Number(body.revision),
      { actor: identity.approver, via: identity.via },
    );
    return jsonOk({ settings });
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : String(error),
      error instanceof BudgetSettingsError ? 409 : 503,
      error instanceof BudgetSettingsError ? "settings_request" : "unavailable",
    );
  }
}
