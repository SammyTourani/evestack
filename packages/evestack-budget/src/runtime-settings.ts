import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { BudgetConfig } from "./config.js";

export interface RuntimeBudgetPolicy {
  sessionUsd: number | false;
  dailyUsd: number | false;
  timeZone: string;
  mode: "fail";
  preflight: true;
  failClosed: true;
  unpricedModel: "stop";
}
export interface BudgetSetting {
  revision: number;
  policy: RuntimeBudgetPolicy;
  updated_at: Date;
}
export interface BudgetConsumer {
  id: string;
  revision: number;
  observed: Record<string, unknown>;
  updated_at: Date;
}
export class BudgetSettingsError extends Error {}

export function validateBudgetPolicy(value: unknown): RuntimeBudgetPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new BudgetSettingsError("Expected budget settings.");
  const input = value as Record<string, unknown>;
  for (const key of ["sessionUsd", "dailyUsd"]) {
    const cap = input[key];
    if (
      cap !== false &&
      (typeof cap !== "number" ||
        !Number.isFinite(cap) ||
        cap < 0 ||
        cap > 1000000)
    )
      throw new BudgetSettingsError(
        `${key} must be false or a finite amount from $0 to $1,000,000.`,
      );
  }
  if (typeof input.timeZone !== "string" || input.timeZone.length > 100)
    throw new BudgetSettingsError("Use an IANA time zone.");
  try {
    new Intl.DateTimeFormat("en", { timeZone: input.timeZone });
  } catch {
    throw new BudgetSettingsError(
      "Use an IANA time zone such as America/Toronto.",
    );
  }
  return {
    sessionUsd: input.sessionUsd as number | false,
    dailyUsd: input.dailyUsd as number | false,
    timeZone: input.timeZone,
    mode: "fail",
    preflight: true,
    failClosed: true,
    unpricedModel: "stop",
  };
}

const pools = new Map<string, Pool>();
const schemas = new Map<string, Promise<void>>();
const consumerId = randomUUID();
function connection(databaseUrl?: string) {
  if (!databaseUrl)
    throw new BudgetSettingsError(
      "Shared budget settings require a database URL.",
    );
  let pool = pools.get(databaseUrl);
  if (!pool) {
    pool = new Pool({
      connectionString: databaseUrl,
      max: 2,
      connectionTimeoutMillis: 5000,
      statement_timeout: 10000,
    });
    pool.on("error", (error) =>
      console.warn(`[evestack:budget-settings] ${error.message}`),
    );
    pools.set(databaseUrl, pool);
  }
  return pool;
}
async function ensure(databaseUrl?: string) {
  const pool = connection(databaseUrl);
  if (!schemas.has(databaseUrl!))
    schemas.set(
      databaseUrl!,
      (async () => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("SELECT pg_advisory_xact_lock(7141504)");
          await client.query(
            "CREATE SCHEMA IF NOT EXISTS evestack; CREATE TABLE IF NOT EXISTS evestack.budget_settings_schema(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),version integer NOT NULL)",
          );
          const version = (
            await client.query(
              "SELECT version FROM evestack.budget_settings_schema WHERE singleton",
            )
          ).rows[0]?.version;
          if (version !== undefined && version !== 1)
            throw new BudgetSettingsError(
              "Shared budget schema is newer than this package. Upgrade the agent and dashboard together.",
            );
          await client.query(`CREATE SCHEMA IF NOT EXISTS evestack;
        CREATE TABLE IF NOT EXISTS evestack.budget_settings(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),revision integer NOT NULL,policy jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now());
        CREATE TABLE IF NOT EXISTS evestack.budget_settings_audit(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,revision integer NOT NULL,policy jsonb NOT NULL,actor text,actor_via text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
        CREATE TABLE IF NOT EXISTS evestack.budget_consumers(id text PRIMARY KEY,revision integer NOT NULL,observed jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now())`);
          await client.query(
            "DELETE FROM evestack.budget_consumers WHERE updated_at < now()-interval '7 days'",
          );
          await client.query(
            "INSERT INTO evestack.budget_settings_schema(singleton,version) VALUES(true,1) ON CONFLICT DO NOTHING",
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => {});
          throw error;
        } finally {
          client.release();
        }
      })().catch((error) => {
        schemas.delete(databaseUrl!);
        throw error;
      }),
    );
  await schemas.get(databaseUrl!);
  return pool;
}

export async function readBudgetSettings(databaseUrl?: string) {
  const pool = await ensure(databaseUrl);
  const [settings, consumers] = await Promise.all([
    pool.query<BudgetSetting>(
      "SELECT revision,policy,updated_at FROM evestack.budget_settings WHERE singleton",
    ),
    pool.query<BudgetConsumer>(
      "SELECT id,revision,observed,updated_at FROM evestack.budget_consumers ORDER BY updated_at DESC LIMIT 20",
    ),
  ]);
  return { settings: settings.rows[0] ?? null, consumers: consumers.rows };
}

export async function saveBudgetSettings(
  databaseUrl: string | undefined,
  policy: unknown,
  revision: number,
  identity: { actor: string | null; via: string },
) {
  const validated = validateBudgetPolicy(policy);
  const pool = await ensure(databaseUrl);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(7141505)");
    const current =
      (
        await client.query(
          "SELECT revision FROM evestack.budget_settings WHERE singleton FOR UPDATE",
        )
      ).rows[0]?.revision ?? 0;
    if (current !== revision)
      throw new BudgetSettingsError(
        "Budget settings changed in another window. Refresh before saving.",
      );
    const updated = (
      await client.query<BudgetSetting>(
        "INSERT INTO evestack.budget_settings(singleton,revision,policy) VALUES(true,$1,$2) ON CONFLICT(singleton) DO UPDATE SET revision=EXCLUDED.revision,policy=EXCLUDED.policy,updated_at=now() RETURNING revision,policy,updated_at",
        [current + 1, JSON.stringify(validated)],
      )
    ).rows[0];
    await client.query(
      "INSERT INTO evestack.budget_settings_audit(revision,policy,actor,actor_via) VALUES($1,$2,$3,$4)",
      [
        updated.revision,
        JSON.stringify(validated),
        identity.actor,
        identity.via,
      ],
    );
    await client.query("COMMIT");
    return updated;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Per-event immutable snapshot; concurrent sessions never mutate a shared config object. */
export async function runtimeBudgetConfig(
  base: BudgetConfig,
): Promise<BudgetConfig> {
  if (!base.dashboardControls) return base;
  // Failure deliberately escapes before a model call. A cached permissive fallback could ignore a saved lower cap.
  const pool = await ensure(base.databaseUrl);
  const setting = (
    await pool.query<BudgetSetting>(
      "SELECT revision,policy,updated_at FROM evestack.budget_settings WHERE singleton",
    )
  ).rows[0];
  const config = setting
    ? { ...base, ...validateBudgetPolicy(setting.policy) }
    : base;
  const observed = {
    sessionUsd: config.sessionUsd,
    dailyUsd: config.dailyUsd,
    timeZone: config.timeZone,
    mode: config.mode,
    failClosed: config.failClosed,
    preflight: config.preflight,
    unpricedModel: config.unpricedModel,
    model: config.model,
  };
  await pool.query(
    "INSERT INTO evestack.budget_consumers(id,revision,observed) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET revision=EXCLUDED.revision,observed=EXCLUDED.observed,updated_at=now()",
    [consumerId, setting?.revision ?? 0, JSON.stringify(observed)],
  );
  return config;
}

export async function closeBudgetSettingsPools() {
  await Promise.all([...pools.values()].map((pool) => pool.end()));
  pools.clear();
  schemas.clear();
}
