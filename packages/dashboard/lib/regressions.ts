import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PoolClient } from "pg";
import { parseSchemaTarget } from "./traces";
import { getPool, query } from "./db";
import type { ApproverIdentity } from "./approvals";
import { getTaskRecovery, type TaskRecovery } from "./task-recovery";

export class RegressionInputError extends Error {}
export class RegressionConflictError extends Error {}
export const validCaseId = (id: string) =>
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id);
export function evidenceFingerprint(evidence: TaskRecovery) {
  const { checkedAt: _checkedAt, ...snapshot } = evidence;
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

interface Version {
  case_id: string;
  revision: number;
  title: string;
  correction: string;
  expected: string;
  baseline_session_id: string;
  baseline_hash: string;
  baseline: TaskRecovery;
  actor: string | null;
  actor_via: string;
  created_at: Date | string;
}
interface Review {
  id: string;
  case_id: string;
  revision: number;
  candidate_session_id: string;
  candidate_hash: string;
  candidate: TaskRecovery;
  verdict: string;
  note: string;
  actor: string | null;
  actor_via: string;
  created_at: Date | string;
}
export interface CaseInput {
  id: string;
  title: string;
  correction: string;
  expected: string;
  baselineId: string;
  baselineHash: string;
}
export interface CaseEdit {
  revision: number;
  title: string;
  correction: string;
  expected: string;
}
export interface CandidateInput {
  id: string;
  revision: number;
  candidateId: string;
  candidateHash: string;
  verdict: string;
  note: string;
}

function bounded(
  value: unknown,
  label: string,
  min: number,
  max: number,
): string {
  if (
    typeof value !== "string" ||
    value.trim().length < min ||
    value.trim().length > max
  )
    throw new RegressionInputError(
      `${label} must be between ${min} and ${max.toLocaleString("en-US")} characters.`,
    );
  return value.trim();
}
function content(input: Pick<CaseInput, "title" | "correction" | "expected">) {
  return {
    title: bounded(input.title, "Title", 3, 120),
    correction: bounded(input.correction, "Correction", 10, 4000),
    expected: bounded(input.expected, "Expected behavior", 10, 8000),
  };
}
function revision(value: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1000000)
    throw new RegressionInputError("Invalid case revision.");
}
async function currentEvidence(id: string, expectedHash: string) {
  bounded(id, "Task id", 1, 300);
  if (typeof expectedHash !== "string" || !/^[a-f0-9]{64}$/.test(expectedHash))
    throw new RegressionInputError("Refresh the task evidence before saving.");
  const evidence = await getTaskRecovery(id);
  if (!evidence)
    throw new RegressionInputError("The selected task does not exist.");
  if (evidence.coverage.turns !== "available")
    throw new RegressionConflictError(
      "Workflow evidence is unavailable. Recheck storage before saving a case.",
    );
  if (evidenceFingerprint(evidence) !== expectedHash)
    throw new RegressionConflictError(
      "Task evidence changed after your preview. Refresh it and review the new snapshot before saving.",
    );
  return evidence;
}
async function transaction<T>(run: (client: PoolClient) => Promise<T>) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='3s'",
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
function readRegressionSql() {
  let dir = process.cwd();
  for (let up = 0; up < 5; up++) {
    try {
      return readFileSync(join(dir, "sql", "regressions.sql"), "utf8");
    } catch {
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error("Cannot locate sql/regressions.sql for the dashboard.");
}
export function regressionSchemaTarget() {
  return parseSchemaTarget(readRegressionSql(), "sql/regressions.sql");
}
let schema: Promise<void> | null = null;
export function ensureRegressionSchema() {
  if (!schema)
    schema = transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(7141507)");
      // The SQL also works in psql. Here the outer transaction retains the
      // advisory lock through bootstrap, so remove its standalone wrapper.
      const sql = readRegressionSql()
        .replace(/^BEGIN;\s*/, "")
        .replace(/COMMIT;\s*$/, "");
      await client.query(sql);
    }).catch((error) => {
      schema = null;
      throw error;
    });
  return schema.then(async () => {
    const [marker] = await query<{ version: number }>(
      "SELECT version FROM evestack.schema_version WHERE component = 'regressions'",
    );
    if (marker?.version !== regressionSchemaTarget())
      throw new RegressionConflictError(
        "Regression storage changed version. Use the matching dashboard before reading or saving cases.",
      );
  });
}
async function lockSchemaVersion(client: PoolClient) {
  const marker = (
    await client.query<{ version: number }>(
      "SELECT version FROM evestack.schema_version WHERE component = 'regressions' FOR SHARE",
    )
  ).rows[0];
  if (marker?.version !== regressionSchemaTarget())
    throw new RegressionConflictError(
      "Regression storage changed version. Nothing was saved by this request.",
    );
}
const FIELDS =
  "v.case_id,v.revision,v.title,v.correction,v.expected,v.baseline_session_id,v.baseline_hash,v.baseline,v.actor,v.actor_via,v.created_at";
export async function listRegressionCases(offset = 0) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000)
    throw new RegressionInputError("Invalid case list offset.");
  await ensureRegressionSchema();
  const rows = await query<
    Pick<Version, "case_id" | "revision" | "title" | "baseline_session_id"> & {
      updated_at: Date;
    }
  >(
    `SELECT c.id AS case_id,c.revision,v.title,v.baseline_session_id,c.updated_at FROM evestack.regression_cases c JOIN evestack.regression_versions v ON v.case_id=c.id AND v.revision=c.revision ORDER BY c.updated_at DESC,c.id DESC LIMIT 21 OFFSET $1`,
    [offset],
  );
  return {
    cases: rows.slice(0, 20),
    nextOffset: rows.length > 20 ? offset + 20 : null,
  };
}
export async function getRegressionCase(id: string) {
  if (!validCaseId(id)) throw new RegressionInputError("Invalid case id.");
  await ensureRegressionSchema();
  const [current] = await query<Version>(
    `SELECT ${FIELDS} FROM evestack.regression_cases c JOIN evestack.regression_versions v ON v.case_id=c.id AND v.revision=c.revision WHERE c.id=$1`,
    [id],
  );
  if (!current) return null;
  const [versions, reviews] = await Promise.all([
    query<Omit<Version, "baseline">>(
      `SELECT case_id,revision,title,correction,expected,baseline_session_id,baseline_hash,actor,actor_via,created_at FROM evestack.regression_versions WHERE case_id=$1 ORDER BY revision DESC LIMIT 20`,
      [id],
    ),
    query<Review>(
      "SELECT * FROM evestack.regression_reviews WHERE case_id=$1 ORDER BY created_at DESC,id DESC LIMIT 20",
      [id],
    ),
  ]);
  return { current, versions, reviews, historyLimit: 20 };
}
async function insertVersion(
  client: PoolClient,
  id: string,
  next: number,
  values: ReturnType<typeof content>,
  baseline: TaskRecovery,
  hash: string,
  actor: ApproverIdentity,
) {
  return (
    await client.query<Version>(
      `INSERT INTO evestack.regression_versions(case_id,revision,title,correction,expected,baseline_session_id,baseline_hash,baseline,actor,actor_via) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        id,
        next,
        values.title,
        values.correction,
        values.expected,
        baseline.session.id,
        hash,
        JSON.stringify(baseline),
        actor.approver,
        actor.via,
      ],
    )
  ).rows[0];
}
export async function createRegressionCase(
  input: CaseInput,
  actor: ApproverIdentity,
) {
  if (!validCaseId(input.id))
    throw new RegressionInputError("A request id is required.");
  const values = content(input);
  const baseline = await currentEvidence(input.baselineId, input.baselineHash);
  await ensureRegressionSchema();
  return transaction(async (client) => {
    await lockSchemaVersion(client);
    const inserted = await client.query(
      "INSERT INTO evestack.regression_cases(id,revision) VALUES($1,1) ON CONFLICT DO NOTHING RETURNING id",
      [input.id],
    );
    if (!inserted.rowCount) {
      const previous = (
        await client.query<Version>(
          "SELECT * FROM evestack.regression_versions WHERE case_id=$1 AND revision=1",
          [input.id],
        )
      ).rows[0];
      if (
        previous &&
        previous.title === values.title &&
        previous.correction === values.correction &&
        previous.expected === values.expected &&
        previous.baseline_session_id === input.baselineId &&
        previous.baseline_hash === input.baselineHash
      )
        return previous;
      throw new RegressionConflictError(
        "This request id already saved a different case. Open the saved case before creating another.",
      );
    }
    return insertVersion(
      client,
      input.id,
      1,
      values,
      baseline,
      input.baselineHash,
      actor,
    );
  });
}
export async function editRegressionCase(
  id: string,
  input: CaseEdit,
  actor: ApproverIdentity,
) {
  if (!validCaseId(id)) throw new RegressionInputError("Invalid case id.");
  revision(input.revision);
  const values = content(input);
  await ensureRegressionSchema();
  return transaction(async (client) => {
    await lockSchemaVersion(client);
    const current = (
      await client.query<{ revision: number }>(
        "SELECT revision FROM evestack.regression_cases WHERE id=$1 FOR UPDATE",
        [id],
      )
    ).rows[0];
    if (!current) throw new RegressionInputError("Case not found.");
    if (current.revision !== input.revision)
      throw new RegressionConflictError(
        "This case changed. Refresh and review the latest revision before saving.",
      );
    const previous = (
      await client.query<Version>(
        "SELECT * FROM evestack.regression_versions WHERE case_id=$1 AND revision=$2",
        [id, input.revision],
      )
    ).rows[0];
    const next = input.revision + 1;
    const saved = await insertVersion(
      client,
      id,
      next,
      values,
      previous.baseline,
      previous.baseline_hash,
      actor,
    );
    await client.query(
      "UPDATE evestack.regression_cases SET revision=$2,updated_at=now() WHERE id=$1",
      [id, next],
    );
    return saved;
  });
}
export async function reviewRegressionCandidate(
  id: string,
  input: CandidateInput,
  actor: ApproverIdentity,
) {
  if (!validCaseId(id) || !validCaseId(input.id))
    throw new RegressionInputError("Invalid case or request id.");
  revision(input.revision);
  if (
    !["observed_pass", "observed_fail", "needs_review"].includes(input.verdict)
  )
    throw new RegressionInputError("Choose a manual review result.");
  const note = bounded(input.note, "Review evidence", 10, 4000);
  const candidate = await currentEvidence(
    input.candidateId,
    input.candidateHash,
  );
  await ensureRegressionSchema();
  return transaction(async (client) => {
    await lockSchemaVersion(client);
    const current = (
      await client.query<{ revision: number }>(
        "SELECT revision FROM evestack.regression_cases WHERE id=$1 FOR UPDATE",
        [id],
      )
    ).rows[0];
    if (!current || current.revision !== input.revision)
      throw new RegressionConflictError(
        "The case revision changed or is unavailable. Refresh before reviewing.",
      );
    const version = (
      await client.query<Version>(
        "SELECT * FROM evestack.regression_versions WHERE case_id=$1 AND revision=$2",
        [id, input.revision],
      )
    ).rows[0];
    if (version.baseline_session_id === input.candidateId)
      throw new RegressionInputError(
        "Choose a different candidate task from the original baseline.",
      );
    const saved = await client.query<Review>(
      `INSERT INTO evestack.regression_reviews(id,case_id,revision,candidate_session_id,candidate_hash,candidate,verdict,note,actor,actor_via) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO NOTHING RETURNING *`,
      [
        input.id,
        id,
        input.revision,
        input.candidateId,
        input.candidateHash,
        JSON.stringify(candidate),
        input.verdict,
        note,
        actor.approver,
        actor.via,
      ],
    );
    if (saved.rows[0]) return saved.rows[0];
    const previous = (
      await client.query<Review>(
        "SELECT * FROM evestack.regression_reviews WHERE id=$1",
        [input.id],
      )
    ).rows[0];
    if (
      previous.case_id === id &&
      previous.revision === input.revision &&
      previous.candidate_session_id === input.candidateId &&
      previous.candidate_hash === input.candidateHash &&
      previous.verdict === input.verdict &&
      previous.note === note
    )
      return previous;
    throw new RegressionConflictError(
      "This request id already records a different review. Inspect the case history before retrying.",
    );
  });
}
export type RegressionCase = NonNullable<
  Awaited<ReturnType<typeof getRegressionCase>>
>;
