import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Shared with an isolated PostgreSQL/WASM validation run. The normal runtime
// suite calls this against its pgvector Postgres service, without a model key.
export async function checkActivationIdentity(client, t) {
  const equal = (actual, expected, label) => t.ok(actual === expected, label, { actual, expected });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const schema = `activation_${suffix}`;
  const workflow = `activation_runs_${suffix}`;
  const sql = readFileSync(new URL('../../../packages/dashboard/sql/traces.sql', import.meta.url), 'utf8')
    .replaceAll('evestack.', `${schema}.`).replaceAll('SCHEMA IF NOT EXISTS evestack', `SCHEMA IF NOT EXISTS ${schema}`)
    .replaceAll('workflow.workflow_runs', `${workflow}.workflow_runs`);
  const insert = async (trace, span, parent, attributes) => client.query(
    `INSERT INTO ${schema}.spans (trace_id,span_id,parent_span_id,name,start_unix_nano,end_unix_nano,start_time,attributes)
     VALUES ($1,$2,$3,'invoke_agent example',1000000000,2000000000,now(),$4)`,
    [trace, span, parent, JSON.stringify(attributes)],
  );
  try {
    await client.query(`CREATE SCHEMA ${workflow}; CREATE TABLE ${workflow}.workflow_runs (id text PRIMARY KEY, attributes jsonb)`);
    await client.query(sql);
    await client.query(`INSERT INTO ${workflow}.workflow_runs VALUES ($1,$2)`, ['wrun_turn1', { '$eve.type': 'turn', '$eve.parent': 'wrun_session1' }]);
    // Child first: ingestion may split or reorder a trace across batches.
    await insert('a'.repeat(32), '2'.repeat(16), '1'.repeat(16), {});
    await insert('a'.repeat(32), '1'.repeat(16), null, { 'gen_ai.conversation.id': 'external-correlation', 'agent.turn.id': 'wrun_turn1' });
    const identities = async () => (await client.query(`SELECT resolved_session_id AS sid, resolved_turn_id AS tid FROM ${schema}.spans WHERE trace_id=$1 ORDER BY span_id`, ['a'.repeat(32)])).rows;
    const expected = [{ sid: 'wrun_session1', tid: 'wrun_turn1' }, { sid: 'wrun_session1', tid: 'wrun_turn1' }];
    equal(JSON.stringify(await identities()), JSON.stringify(expected), 'out-of-order activation descendants resolve to the actual turn parent');
    const unchanged = (await client.query(`SELECT ${schema}.resolve_span_ancestry($1) AS changed`, [['a'.repeat(32)]])).rows[0];
    equal(Number(unchanged.changed), 0, 're-resolving current identities performs no writes');
    // Simulate a v4 installation with stored rows and missing new metadata.
    await client.query(`DROP TRIGGER spans_resolved_after_update ON ${schema}.spans;
      ALTER TABLE ${schema}.spans DROP COLUMN conversation_id;
      UPDATE ${schema}.spans SET resolved_session_id=NULL;
      UPDATE ${schema}.schema_version SET version=4 WHERE component='spans'`);
    await client.query(sql);
    equal(JSON.stringify(await identities()), JSON.stringify(expected), 'v4 migration backfills stored activation identity');
    await client.query(sql);
    equal(JSON.stringify(await identities()), JSON.stringify(expected), 'applying the schema twice preserves attribution');
    await insert('b'.repeat(32), '3'.repeat(16), null, { 'agent.session.id': 'wrun_legacy', 'agent.turn.id': 'wrun_legacy_turn' });
    const legacy = (await client.query(`SELECT resolved_session_id AS sid FROM ${schema}.spans WHERE trace_id=$1`, ['b'.repeat(32)])).rows[0];
    equal(legacy.sid, 'wrun_legacy', 'legacy spans retain their original session');
    await insert('c'.repeat(32), '4'.repeat(16), null, { 'gen_ai.conversation.id': 'wrun_some_other_session', 'agent.turn.id': 'wrun_missing' });
    const orphan = (await client.query(`SELECT resolved_session_id AS sid FROM ${schema}.spans WHERE trace_id=$1`, ['c'.repeat(32)])).rows[0];
    equal(orphan.sid, null, 'an external conversation ID is never treated as a session ID');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; DROP SCHEMA IF EXISTS ${workflow} CASCADE`);
  }
}

async function connect() {
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: process.env.WORKFLOW_POSTGRES_URL });
  client.on('error', () => {});
  await client.connect();
  return client;
}
export default {
  id: 'telemetry/activation-identity-survives-upgrade',
  title: 'activation identities survive upgrades and out-of-order ingestion',
  needs: ['postgres'],
  why: 'Eve 0.54 removes agent.session.id. Correlation IDs cannot replace durable session identity; the turn run supplies its real parent.',
  async available() {
    if (!process.env.WORKFLOW_POSTGRES_URL) return ['WORKFLOW_POSTGRES_URL is not set'];
    try { const client = await connect(); await client.end(); return []; }
    catch (error) { return [error.message]; }
  },
  async run(t) {
    const client = await connect();
    try { await checkActivationIdentity(client, t); } finally { await client.end(); }
  },
};
