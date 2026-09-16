import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

test('read-only recovery retains workflow evidence without an agent or trace tier', {skip: !process.env.EVESTACK_TEST_POSTGRES_URL}, async t => {
  const admin = new pg.Client({connectionString:process.env.EVESTACK_TEST_POSTGRES_URL});
  await admin.connect();
  const name=`recovery_test_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url=new URL(process.env.EVESTACK_TEST_POSTGRES_URL);url.pathname=`/${name}`;
  const original=process.env.WORKFLOW_POSTGRES_URL;process.env.WORKFLOW_POSTGRES_URL=url.href;
  const {getPool,closePool}=await import('../lib/db.ts');
  const {getTaskRecovery}=await import('../lib/task-recovery.ts');
  const {checkReadiness}=await import('../lib/readiness.ts');
  t.after(async()=>{await closePool();if(original===undefined)delete process.env.WORKFLOW_POSTGRES_URL;else process.env.WORKFLOW_POSTGRES_URL=original;await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);await admin.end();});
  const db=getPool();
  await db.query(`CREATE SCHEMA workflow; CREATE TABLE workflow.workflow_runs(id text PRIMARY KEY,status text,attributes jsonb,error_code text,created_at timestamptz DEFAULT now(),completed_at timestamptz);
    INSERT INTO workflow.workflow_runs(id,status,attributes) VALUES('task-a','running','{"$eve.type":"session"}');`);
  const addTurn=async(id,status,model,age,error=null)=>db.query(`INSERT INTO workflow.workflow_runs(id,status,attributes,error_code,created_at,completed_at) VALUES($1,$2,$3,$4,now()-($5::int*interval '1 minute'),now()-($5::int*interval '1 minute'))`,[id,status,JSON.stringify({'$eve.type':'turn','$eve.parent':'task-a',...(model?{'$eve.model':model}:{})}),error,age]);
  await addTurn('failed-turn','failed','model-fixture',3,'PROVIDER_LIMIT');
  await addTurn('completed-turn','completed','model-fixture',2);
  await t.test('a subsequent completed turn does not erase the failure and a missing trace schema is explicit',async()=>{
    const result=await getTaskRecovery('task-a');
    assert.equal(result.failure.code,'PROVIDER_LIMIT');assert.equal(result.completedTurn.id,'completed-turn');
    assert.equal(result.coverage.traces,'unavailable');assert.equal(result.coverage.turns,'available');
    assert.equal(result.response,null);
    assert.equal((await db.query("SELECT to_regnamespace('evestack') AS schema")).rows[0].schema,null,'reading evidence must not create the trace schema');
    assert.equal(await getTaskRecovery('missing-task'),null);
  });
  await t.test('readiness executes a read-only workflow probe',async()=>{
    const result=await checkReadiness('database');assert.equal(result.status,'verified');assert.equal(result.ready,true);
  });
  await db.query(`CREATE SCHEMA evestack; CREATE TABLE evestack.spans(span_id text PRIMARY KEY,name text,status_code smallint,status_message text,start_time timestamptz DEFAULT now(),end_time timestamptz,resolved_session_id text,attributes jsonb DEFAULT '{}');`);
  const span=async(id,name,status,session='task-a',attributes={},ended=true,age=0)=>db.query(`INSERT INTO evestack.spans(span_id,name,status_code,resolved_session_id,attributes,end_time,start_time,status_message) VALUES($1,$2,$3,$4,$5,CASE WHEN $6 THEN now() END,now()-($7::int*interval '1 minute'),'fixture trace error')`,[id,name,status,session,JSON.stringify(attributes),ended,age]);
  await span('good-action','execute_tool fetch_report',1,'task-a',{},true,2);
  await span('unknown-action','execute_tool send_email',0);
  await span('unfinished','execute_tool unfinished',1,'task-a',{},false);
  await span('foreign','execute_tool foreign_secret',1,'task-b',{'ai.response.text':'foreign private text'});
  await span('failure','chat fixture',2,'task-a',{'ai.response.text':'Partial response '+ 'a'.repeat(9000)});
  await t.test('only explicitly successful finished tools qualify, and foreign task spans are excluded',async()=>{
    const result=await getTaskRecovery('task-a');
    assert.equal(result.successfulAction.name,'execute_tool fetch_report');assert.equal(result.traceError.name,'chat fixture');
    assert.equal(result.response.text.length,8000);assert.equal(result.response.truncated,true);
    assert.equal(result.coverage.tracesRead,4);assert.equal(JSON.stringify(result).includes('foreign'),false);
  });
  await addTurn('no-model','completed',null,0);
  await t.test('a terminal turn with no model evidence is not called a successful turn',async()=>{
    const result=await getTaskRecovery('task-a');assert.equal(result.failure.code,'no_recorded_model_call');assert.equal(result.completedTurn.id,'completed-turn');
  });
  await t.test('long histories report bounded coverage and older omitted records',async()=>{
    await db.query(`INSERT INTO workflow.workflow_runs(id,status,attributes,created_at) SELECT 'extra-'||n,'running','{"$eve.type":"turn","$eve.root":"task-a"}'::jsonb,now()+n*interval '1 second' FROM generate_series(1,105)n;
      INSERT INTO evestack.spans(span_id,name,status_code,resolved_session_id,start_time) SELECT 'extra-'||n,'execute_tool recent',0,'task-a',now()+n*interval '1 second' FROM generate_series(1,55)n;`);
    const result=await getTaskRecovery('task-a');assert.equal(result.coverage.turnsRead,100);assert.equal(result.coverage.tracesRead,50);
    assert.equal(result.coverage.turnsTruncated,true);assert.equal(result.coverage.tracesTruncated,true);assert.equal(result.failure,null);assert.equal(result.successfulAction,null);
  });
});
