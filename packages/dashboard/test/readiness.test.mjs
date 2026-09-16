import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {checkReadiness,readReadiness} from '../lib/readiness.ts';

test('readiness distinguishes configured secrets, observed health and unknown runtime providers',async t=>{
  const keys=['COMPOSIO_API_KEY','EVESTACK_ALERT_WEBHOOK_URL','EVESTACK_AGENT_URL'];
  const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  let requests=0,status=200;
  const server=createServer((_request,response)=>{requests++;response.writeHead(status,{'content-type':'application/json'});response.end('{}');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}await new Promise(resolve=>server.close(resolve));});
  process.env.EVESTACK_AGENT_URL=`http://127.0.0.1:${server.address().port}`;
  process.env.COMPOSIO_API_KEY='fixture-present-key';
  process.env.EVESTACK_ALERT_WEBHOOK_URL='https://receiver.example.test/secret-fixture';
  for(const id of ['connections','notifications']) {
    const result=await checkReadiness(id);assert.equal(result.status,'configured');assert.equal(result.ready,false);
    assert.equal(JSON.stringify(result).includes('secret-fixture'),false);assert.equal(JSON.stringify(result).includes('fixture-present-key'),false);
  }
  for(const id of ['model','embeddings']){const result=await checkReadiness(id);assert.equal(result.status,'unknown');assert.equal(result.ready,false);}
  assert.equal(requests,0,'configuration checks must not invoke the agent or send notifications');
  let result=await readReadiness('agent');assert.equal(result.checks.length,1);assert.equal(result.checks[0].status,'verified');assert.equal(requests,1);
  status=503;result=await readReadiness('agent');assert.equal(result.checks[0].status,'unavailable');assert.equal(result.checks[0].ready,false);
  process.env.EVESTACK_ALERT_WEBHOOK_URL='file:///private/fixture';assert.equal((await checkReadiness('notifications')).status,'unavailable');
  process.env.COMPOSIO_API_KEY=' ';assert.equal((await checkReadiness('connections')).status,'unconfigured');
});
