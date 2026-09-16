import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,existsSync,rmSync,mkdirSync,statSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseEnv} from 'node:util';
import {spawnSync} from 'node:child_process';
import {configurationPlan,applyConfiguration,configure} from '../src/configure.mjs';
import {main,projectCommand} from '../src/cli.mjs';

function fixture(t,env='# deployment comment\nUNRELATED="keep # and spaces"\nEVESTACK_PROVIDER=openai\nOPENAI_API_KEY=old-fixture-secret\n') {
  const root=mkdtempSync(join(tmpdir(),'evestack-configure-')),dir=join(root,'project'),backupRoot=join(root,'private-backups');mkdirSync(dir);
  writeFileSync(join(dir,'.env.local'),env,{mode:0o600});writeFileSync(join(dir,'package.json'),'{"dependencies":{"eve":"0.54.3"}}');
  t.after(()=>rmSync(root,{recursive:true,force:true}));return {dir,backupRoot,found:{dir,envFiles:['.env.local']},path:join(dir,'.env.local')};
}
const sink=()=>({text:'',write(value){this.text+=value;return true;}});

test('configure help routes without finding a project or writing',async()=>{
  assert.equal(projectCommand(['configure']),'configure');const stdout=sink();assert.equal(await main(['configure','--help'],{stdout,stderr:sink()}),0);assert.match(stdout.text,/Preview is read-only/);
});
test('preview is read-only and redacts old and new secrets; apply preserves unrelated content and restores a private backup',t=>{
  const f=fixture(t),before=readFileSync(f.path,'utf8');
  const plan=configurationPlan(f.found,{EVESTACK_PROVIDER:'anthropic',ANTHROPIC_API_KEY:'new-fixture-secret',OPENAI_API_KEY:null},{backupRoot:f.backupRoot});
  assert.equal(readFileSync(f.path,'utf8'),before);assert.equal(existsSync(f.backupRoot),false);assert.doesNotMatch(JSON.stringify(plan.review),/old-fixture-secret|new-fixture-secret/);
  const result=applyConfiguration(plan,plan.fingerprint);assert.equal(result.applied,true);if(process.platform!=="win32"){assert.equal(statSync(f.path).mode&0o777,0o600);assert.equal(statSync(result.backupDirectory).mode&0o777,0o700);}
  const after=readFileSync(f.path,'utf8');assert.match(after,/# deployment comment\nUNRELATED="keep # and spaces"/);const values=parseEnv(after);assert.equal(values.EVESTACK_PROVIDER,'anthropic');assert.equal(values.ANTHROPIC_API_KEY,'new-fixture-secret');assert.equal(values.OPENAI_API_KEY,undefined);
  const restore=configurationPlan(f.found,{}, {restore:result.backupId,backupRoot:f.backupRoot});assert.equal(restore.review.restoredFrom,result.backupId);applyConfiguration(restore,restore.fingerprint);assert.equal(readFileSync(f.path,'utf8'),before);
});
test('a stale preview refuses changes in either env file without writing or creating backups',t=>{
  const f=fixture(t);writeFileSync(join(f.dir,'.env'),'OTHER=one\n');const plan=configurationPlan(f.found,{EVESTACK_MODEL:'model-fixture'},{backupRoot:f.backupRoot});
  writeFileSync(join(f.dir,'.env'),'OTHER=two\n');assert.throws(()=>applyConfiguration(plan,plan.fingerprint),/changed after preview/);assert.equal(existsSync(f.backupRoot),false);assert.doesNotMatch(readFileSync(f.path,'utf8'),/model-fixture/);
  const next=configurationPlan(f.found,{EVESTACK_MODEL:'other-model'},{backupRoot:f.backupRoot});assert.throws(()=>applyConfiguration(next,plan.fingerprint),/fingerprint changed/);
});
test('duplicate or multiline source values require review; malicious and unsupported settings cannot enter the file',t=>{
  const f=fixture(t);for(const raw of ['KEY=one\nKEY=two\n',"KEY='first\nsecond'\n"]){writeFileSync(f.path,raw);assert.throws(()=>configurationPlan(f.found,{EVESTACK_PROVIDER:'openai'}),/manual review/);}
  writeFileSync(f.path,'KEY=one\n');for(const changes of [{WORKFLOW_POSTGRES_URL:'secret'},{EVESTACK_PROVIDER:'ollamma'},{EVESTACK_MODEL:'one\nTWO=oops'},{EVESTACK_BASE_URL:'https://user:secret@fixture.test'},{EVESTACK_EMBED_DIMENSIONS:'0'},{'KEY\u001b[2J':'bad'}])assert.throws(()=>configurationPlan(f.found,changes));
});
test('literal shell substitutions in a file remain data and never execute',t=>{
  const f=fixture(t);const text='literal-$(touch forbidden)-`whoami`-#-value';const plan=configurationPlan(f.found,{OPENAI_API_KEY:text},{backupRoot:f.backupRoot});applyConfiguration(plan,plan.fingerprint);assert.equal(parseEnv(readFileSync(f.path,'utf8')).OPENAI_API_KEY,text);assert.equal(existsSync(join(f.dir,'forbidden')),false);
});
test('wildcard channel access requires explicit acknowledgement, including on restore',t=>{
  const f=fixture(t,'TELEGRAM_ALLOWED_USER_IDS=*\n');assert.throws(()=>configurationPlan(f.found,{SLACK_ALLOWED_USER_IDS:'*'}),/allow-public-channel/);
  const plan=configurationPlan(f.found,{TELEGRAM_ALLOWED_USER_IDS:'1234'},{backupRoot:f.backupRoot});const saved=applyConfiguration(plan,plan.fingerprint);
  assert.throws(()=>configurationPlan(f.found,{}, {restore:saved.backupId,backupRoot:f.backupRoot}),/allow-public-channel/);
  assert.equal(configurationPlan(f.found,{}, {restore:saved.backupId,allowPublic:true,backupRoot:f.backupRoot}).review.changes[0].after,'*');
});
test('symbolic links and duplicate cooperating writers are refused',t=>{
  const f=fixture(t),plan=configurationPlan(f.found,{EVESTACK_MODEL:'next'},{backupRoot:f.backupRoot});writeFileSync(join(f.dir,'..env.local.evestack-lock'),'');assert.throws(()=>applyConfiguration(plan,plan.fingerprint),/in progress/);rmSync(join(f.dir,'..env.local.evestack-lock'));
  const target=join(f.dir,'other-env');writeFileSync(target,'KEY=one\n');rmSync(f.path);symlinkSync(target,f.path);assert.throws(()=>configurationPlan(f.found,{EVESTACK_MODEL:'next'}),/non-regular/);assert.equal(readFileSync(target,'utf8'),'KEY=one\n');
});
test('Git-tracked and unignored env files are refused; ignored env files can be saved',t=>{
  const f=fixture(t);assert.equal(spawnSync('git',['init','-q',f.dir]).status,0);
  const plan=()=>configurationPlan(f.found,{EVESTACK_MODEL:'next'},{backupRoot:f.backupRoot});let p=plan();assert.throws(()=>applyConfiguration(p,p.fingerprint),/gitignore/);
  spawnSync('git',['-C',f.dir,'add','.env.local']);writeFileSync(join(f.dir,'.gitignore'),'.env.local\n');p=plan();assert.throws(()=>applyConfiguration(p,p.fingerprint),/tracked by Git/);
  spawnSync('git',['-C',f.dir,'rm','--cached','--quiet','.env.local']);p=plan();assert.equal(applyConfiguration(p,p.fingerprint).applied,true);
});
test('no-op edits preserve bytes and create no backup',t=>{
  const f=fixture(t),plan=configurationPlan(f.found,{EVESTACK_PROVIDER:'openai'},{backupRoot:f.backupRoot});assert.deepEqual(plan.review.changes,[]);assert.equal(applyConfiguration(plan,plan.fingerprint).applied,false);assert.equal(existsSync(f.backupRoot),false);
});
test('CLI secrets come from a bounded file and never appear in normal or JSON output',async t=>{
  const f=fixture(t),stdout=sink(),stderr=sink();assert.equal(await configure(['--set=OPENAI_API_KEY=do-not-print'],{cwd:f.dir,stdout,stderr}),1);assert.doesNotMatch(stderr.text,/do-not-print/);
  const settings=join(f.dir,'input.json');writeFileSync(settings,JSON.stringify({OPENAI_API_KEY:'file-secret-fixture',EVESTACK_MODEL:'my-model'}));
  assert.equal(await configure([`--from-file=${settings}`,'--json'],{cwd:f.dir,stdout,stderr,backupRoot:f.backupRoot}),0);const preview=JSON.parse(stdout.text);assert.equal(preview.applied,false);assert.doesNotMatch(stdout.text,/file-secret-fixture|old-fixture-secret/);
  const applied=sink();assert.equal(await configure([`--from-file=${settings}`,'--json','--apply',`--expect=${preview.fingerprint}`],{cwd:f.dir,stdout:applied,stderr,backupRoot:f.backupRoot}),0);assert.equal(JSON.parse(applied.text).applied,true);assert.doesNotMatch(applied.text,/file-secret-fixture/);
});

test('backups inside a project and corrupted restore files are refused without leaking contents',async t=>{
  const f=fixture(t);let plan=configurationPlan(f.found,{EVESTACK_MODEL:'new'},{backupRoot:join(f.dir,'backups')});assert.throws(()=>applyConfiguration(plan,plan.fingerprint),/outside the project/);
  plan=configurationPlan(f.found,{EVESTACK_MODEL:'new'},{backupRoot:f.backupRoot});const result=applyConfiguration(plan,plan.fingerprint);
  writeFileSync(join(result.backupDirectory,result.backupId+'.json'),'secret-malformed-backup');const stderr=sink();assert.equal(await configure([`--restore=${result.backupId}`],{cwd:f.dir,stdout:sink(),stderr,backupRoot:f.backupRoot}),1);assert.doesNotMatch(stderr.text,/secret-malformed-backup/);assert.match(stderr.text,/not valid JSON/);
});
test('invalid UTF-8 source files cannot be silently rewritten',t=>{
  const f=fixture(t);writeFileSync(f.path,Buffer.from([0xff,0xfe,0x0a]));assert.throws(()=>configurationPlan(f.found,{EVESTACK_MODEL:'new'}),/UTF-8/);
});
