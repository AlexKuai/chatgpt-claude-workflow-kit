import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {execute as executeRunner} from '../.claude/scripts/chatgpt-workflow.mjs';
const execute=(root,request,options)=>executeRunner(root,{sessionId:'workflow-test-session',...request},options);

const fixture = fileURLToPath(new URL('./fake-codex.mjs', import.meta.url));
const uuid = '12345678-1234-4234-8234-123456789abc';
function project(t) {
  const root = fs.mkdtempSync(path.join(process.env.CHATGPT_TEST_TMP || os.tmpdir(), 'chatgpt-kit-test-'));
  t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  const capture=path.join(root,'.chatgpt-workflow/capture.jsonl');
  const options={command:[process.execPath,fixture],env:{CHATGPT_KIT_TRANSPORT:'exec',FAKE_CAPTURE:capture}};
  return {root,capture,options,run:r=>execute(root,r,options),calls:()=>fs.existsSync(capture)?fs.readFileSync(capture,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[]};
}
async function planReview(p) {
  const ticket=await p.run({action:'review-start',kind:'plan'});
  await p.run({action:'review-save',kind:'plan',ticket:ticket.ticket,text:'R1: Add validation.',model:'claude-fixture-a'});
}
function git(root,...args) {
  const r=spawnSync('git',args,{cwd:root,encoding:'utf8'});
  assert.equal(r.status,0,r.stderr); return r.stdout.trim();
}
function repository(p) {
  git(p.root,'init','-q');
  fs.writeFileSync(path.join(p.root,'.gitignore'),'capture.jsonl\n');
  fs.writeFileSync(path.join(p.root,'app.txt'),'base\n');
  git(p.root,'add','.'); git(p.root,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','base');
}
test('new and resumed Codex calls inherit native model selection without model overrides',async t=>{
 const p=project(t);const r=await p.run({action:'new',task:'login',text:'Need login'});
 assert.equal(r.threadId,uuid);assert.ok(!p.calls()[0].args.includes('--model'));
 assert.match(p.calls()[0].args.join(' '),/--sandbox read-only/);
 await p.run({action:'plan',text:'Add MFA'});
 const args=p.calls()[1].args;assert.equal(args[args.indexOf('resume')+1],uuid);assert.ok(!args.includes('--last'));
 assert.ok(!args.includes('--model'));assert.ok(!args.includes('-m'));
 assert.ok(!p.calls().some(call=>/Required model:/.test(call.text)));
});
test('implementation requires the current plan to have review and explicit approval',async t=>{
 const p=project(t);repository(p);await p.run({action:'new',task:'login',text:'Need login'});
 await assert.rejects(p.run({action:'implement'}),/approv/i);
 await assert.rejects(p.run({action:'approve'}),/review/i);
 await planReview(p);await p.run({action:'approve'});await p.run({action:'implement'});
 assert.match(p.calls().at(-1).args.join(' '),/--sandbox workspace-write/);
});
test('new planning after approval invalidates review and permission to implement',async t=>{
 const p=project(t);await p.run({action:'new',task:'login',text:'Need login'});await planReview(p);await p.run({action:'approve'});
 await execute(p.root,{action:'plan',text:'New requirement'}, {...p.options,env:{...p.options.env,FAKE_ANSWER:'A different plan'}});
 await assert.rejects(p.run({action:'implement'}),/approv/i);
 await assert.rejects(p.run({action:'approve'}),/review/i);
});
test('review-guided plan revision can be explicitly approved without compulsory extra review',async t=>{
 const p=project(t);repository(p);await p.run({action:'new',task:'login',text:'Need login'});await planReview(p);
 await p.run({action:'revise-plan'});await p.run({action:'approve'});await p.run({action:'implement'});
 assert.match(p.calls()[1].text,/R1: Add validation/);
 assert.match(p.calls()[1].args.join(' '),/--sandbox read-only/);
});
test('reviews accept the current Claude model and still reject stale tickets',async t=>{
 const p=project(t);await p.run({action:'new',task:'login',text:'Need login'});
 const v=await p.run({action:'review-start',kind:'plan'});
 const saved=await p.run({action:'review-save',kind:'plan',ticket:v.ticket,text:'ok',model:'claude-current-fixture'});
 assert.equal(saved.reviews.plan.model,'claude-current-fixture');
 const current=await p.run({action:'review-start',kind:'plan'});
 await p.run({action:'plan',text:'Change scope'});
 await assert.rejects(p.run({action:'review-save',kind:'plan',ticket:current.ticket,text:'ok',model:'claude-current-fixture'}),/stale/i);
});

test('unknown reviewer model does not block a review and is not fabricated',async t=>{
 const p=project(t);await p.run({action:'new',task:'unknown',text:'x'});
 const ticket=await p.run({action:'review-start',kind:'plan'});
 const state=await p.run({action:'review-save',kind:'plan',ticket:ticket.ticket,text:'No findings'});
 assert.equal(state.reviews.plan.model,null);
 await p.run({action:'approve'});
});
test('code review includes untracked files and changes invalidate the fix handoff',async t=>{
 const p=project(t);repository(p);await p.run({action:'new',task:'login',text:'Need login'});await planReview(p);await p.run({action:'approve'});await p.run({action:'implement'});
 fs.writeFileSync(path.join(p.root,'new.txt'),'before');
 const v=await p.run({action:'review-start',kind:'code'});
 await p.run({action:'review-save',kind:'code',ticket:v.ticket,text:'R1: Correct new.txt',model:'claude-fixture-b'});
 fs.writeFileSync(path.join(p.root,'new.txt'),'after');
 await assert.rejects(p.run({action:'fix'}),/stale/i);
});
test('fix receives actual saved review and uses write permissions',async t=>{
 const p=project(t);repository(p);await p.run({action:'new',task:'login',text:'Need login'});await planReview(p);await p.run({action:'approve'});await p.run({action:'implement'});
 const v=await p.run({action:'review-start',kind:'code'});
 await p.run({action:'review-save',kind:'code',ticket:v.ticket,text:'R1: Fix boundary',model:'claude-fixture-b'});
 await p.run({action:'fix',text:'Only R1'});
 assert.match(p.calls().at(-1).text,/R1: Fix boundary/);assert.match(p.calls().at(-1).text,/Only R1/);
});
test('failed existing thread is retained and never silently replaced with a fresh run',async t=>{
 const p=project(t);await p.run({action:'new',task:'login',text:'Need login'});
 await assert.rejects(execute(p.root,{action:'resume'}, {...p.options,env:{...p.options.env,FAKE_FAIL:'1'}}),/failed/i);
 const state=await p.run({action:'status'});assert.equal(state.threadId,uuid);assert.equal(state.lastRun.status,'failed');
 assert.equal(p.calls().length,2);assert.ok(p.calls()[1].args.includes('resume'));
});
test('task IDs cannot traverse and existing tasks cannot be overwritten',async t=>{
 const p=project(t);await assert.rejects(p.run({action:'new',task:'../escape',text:'x'}),/task/i);
 await p.run({action:'new',task:'login',text:'x'});await assert.rejects(p.run({action:'new',task:'login',text:'y'}),/exists/i);
});
test('concurrent task mutation is rejected and lock released after completion',async t=>{
 const p=project(t);const a=execute(p.root,{action:'new',task:'login',text:'x'},{...p.options,env:{...p.options.env,FAKE_DELAY:'300'}});
 await new Promise(r=>setTimeout(r,80));await assert.rejects(p.run({action:'plan',text:'race'}),/lock|running/i);
 await a;await p.run({action:'resume'});
});
test('all user text including shell syntax travels through stdin without shell execution',async t=>{
 const p=project(t);const text="Unicode 中文 ' \" ` $(echo nope) ; & |\n@'\n'@";
 await p.run({action:'new',task:'quotes',text});assert.ok(p.calls()[0].text.includes(text));
 assert.ok(!p.calls()[0].args.some(a=>a.includes('echo nope')));
});
test('separate tasks retain their own UUID and selecting one restores it',async t=>{
 const p=project(t);await p.run({action:'new',task:'one',text:'one'});
 const id2='22345678-1234-4234-8234-123456789abc';
 await execute(p.root,{action:'new',task:'two',text:'two'},{...p.options,env:{...p.options.env,FAKE_THREAD:id2}});
 await p.run({action:'use',task:'one'});assert.equal((await p.run({action:'status'})).threadId,uuid);
});

test('CLI continues the saved thread across independent processes and unrelated working directories',t=>{
 const p=project(t),scripts=path.join(p.root,'.claude','scripts');fs.mkdirSync(scripts,{recursive:true});
 const runner=path.join(scripts,'chatgpt-workflow.mjs');fs.copyFileSync(fileURLToPath(new URL('../.claude/scripts/chatgpt-workflow.mjs',import.meta.url)),runner);
 for(const name of ['app-server-client.mjs','control-store.mjs','codex-bridge.mjs','runtime-questions.mjs','output-view.mjs'])fs.copyFileSync(fileURLToPath(new URL('../.claude/scripts/'+name,import.meta.url)),path.join(scripts,name));
 fs.copyFileSync(fileURLToPath(new URL('../.claude/scripts/goal-contract.mjs',import.meta.url)),path.join(scripts,'goal-contract.mjs'));
 fs.copyFileSync(fileURLToPath(new URL('../.claude/scripts/file-snapshot.mjs',import.meta.url)),path.join(scripts,'file-snapshot.mjs'));
 fs.writeFileSync(path.join(p.root,'.claude','chatgpt-workflow.json'),JSON.stringify({codexCommand:p.options.command}));
 const call=request=>{const r=spawnSync(process.execPath,[runner,'--stdin'],{cwd:path.dirname(p.root),input:JSON.stringify({sessionId:'cli-test-session',...request}),encoding:'utf8',env:{...process.env,CHATGPT_KIT_HOME:path.join(p.root,'.chatgpt-workflow','kit-home'),...p.options.env}});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
 assert.equal(call({action:'new',task:'restart',text:'跨进程继续'}).threadId,uuid);
 assert.equal(call({action:'status'}).threadId,uuid);
 assert.equal(call({action:'resume'}).threadId,uuid);
 const args=p.calls()[1].args;assert.equal(args[args.indexOf('resume')+1],uuid);
});
test('failure after thread creation saves its UUID; failure before creation never silently retries',async t=>{
 const p=project(t);
 await assert.rejects(execute(p.root,{action:'new',task:'partial',text:'x'},{...p.options,env:{...p.options.env,FAKE_FAIL:'1'}}),/failed/);
 assert.equal((await p.run({action:'status'})).threadId,uuid);
 await p.run({action:'plan',text:'Recover interrupted planning'});
 await assert.rejects(execute(p.root,{action:'new',task:'early',text:'x'},{...p.options,env:{...p.options.env,FAKE_EARLY_FAIL:'1'}}),/failed/);
 const recovered=await p.run({action:'resume'});assert.equal(recovered.task,'early');assert.ok(recovered.threadId);assert.equal(p.calls().length,4);
});
test('resuming a different UUID fails without replacing the saved thread',async t=>{
 const p=project(t);await p.run({action:'new',task:'one',text:'x'});
 await assert.rejects(execute(p.root,{action:'resume'},{...p.options,env:{...p.options.env,FAKE_THREAD:'22345678-1234-4234-8234-123456789abc'}}),/different thread/);
 assert.equal((await p.run({action:'status'})).threadId,uuid);
});
test('incomplete re-planning cannot reuse the old plan review',async t=>{
 const p=project(t);await p.run({action:'new',task:'one',text:'x'});await planReview(p);await p.run({action:'approve'});
 await assert.rejects(execute(p.root,{action:'plan',text:'new scope'},{...p.options,env:{...p.options.env,FAKE_FAIL:'1'}}),/failed/);
 await assert.rejects(p.run({action:'review-start',kind:'plan'}),/incomplete/);
 await assert.rejects(p.run({action:'implement'}),/approval/i);
});
test('editing a saved plan externally invalidates implementation approval',async t=>{
 const p=project(t);await p.run({action:'new',task:'one',text:'x'});await planReview(p);await p.run({action:'approve'});
 const state=await p.run({action:'status'});fs.appendFileSync(state.paths.plan,'\nNew scope');
 await assert.rejects(p.run({action:'implement'}),/changed outside/);
});
test('code review cannot apply to a new plan that has never been implemented',async t=>{
 const p=project(t);repository(p);await p.run({action:'new',task:'one',text:'x'});await planReview(p);await p.run({action:'approve'});await p.run({action:'implement'});
 await p.run({action:'plan',text:'new scope'});
 await assert.rejects(p.run({action:'review-start',kind:'code'}),/not been implemented/);
});
test('baseline preserves pre-existing untracked content even if later deleted',async t=>{
 const p=project(t);repository(p);fs.writeFileSync(path.join(p.root,'existing.txt'),'original untracked content');
 await p.run({action:'new',task:'one',text:'x'});await planReview(p);await p.run({action:'approve'});
 const state=await p.run({action:'implement'});fs.unlinkSync(path.join(p.root,'existing.txt'));
 const baseline=JSON.parse(fs.readFileSync(state.implementation.baseline,'utf8'));
 const entry=baseline.entries.find(e=>e.path==='existing.txt');assert.equal(fs.readFileSync(entry.contentFile,'utf8'),'original untracked content');
});
test('recorded code review updates status and a new plan review requires renewed approval',async t=>{
 const p=project(t);repository(p);await p.run({action:'new',task:'one',text:'x'});await planReview(p);await p.run({action:'approve'});await p.run({action:'implement'});
 const ticket=await p.run({action:'review-start',kind:'code'});
 const state=await p.run({action:'review-save',kind:'code',ticket:ticket.ticket,text:'No findings',model:'claude-fixture-b'});assert.equal(state.phase,'reviewed-code');
 await planReview(p);await assert.rejects(p.run({action:'review-start',kind:'code'}),/approval/);
});
test('legacy state resumes its original UUID and ambiguous state roots are rejected',async t=>{
 const p=project(t),base=path.join(p.root,'.astra-workflow'),dir=path.join(base,'tasks','legacy');
 fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(path.join(base,'active.json'),JSON.stringify({task:'legacy'}));
 fs.writeFileSync(path.join(dir,'state.json'),JSON.stringify({schema:1,projectRoot:fs.realpathSync(p.root),task:'legacy',threadId:uuid,phase:'planning',revision:0,reviews:{}}));
 await p.run({action:'use',task:'legacy'});
 const state=await p.run({action:'resume'});
 assert.equal(state.threadId,uuid);assert.equal(state.paths.runtime,base);assert.ok(!p.calls()[0].args.includes('--model'));
 assert.equal(p.calls()[0].args[p.calls()[0].args.indexOf('resume')+1],uuid);
 const modern=path.join(p.root,'.chatgpt-workflow');fs.mkdirSync(modern,{recursive:true});
 fs.writeFileSync(path.join(modern,'active.json'),JSON.stringify({task:'other'}));
 await assert.rejects(p.run({action:'status'}),/Both current and legacy/);
});
test('exec fallback reports permission settings changed during a writing run',async t=>{
  const p=project(t);await p.run({action:'new',task:'local-settings',text:'x'});await planReview(p);await p.run({action:'approve'});
  const clean=await p.run({action:'implement'});assert.ok(!clean.delivery.warnings.some(w=>/权限配置/.test(w)));
  const s=await execute(p.root,{action:'implement'},{...p.options,env:{...p.options.env,FAKE_WRITE_LOCAL_SETTINGS:'{"permissions":{"allow":["Bash(*)"]}}'}});
  assert.ok(s.delivery.warnings.some(w=>/权限配置[^]*settings.local.json/.test(w)),JSON.stringify(s.delivery.warnings));
});
