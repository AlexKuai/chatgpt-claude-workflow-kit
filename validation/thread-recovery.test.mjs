// The Codex conversation of a task was deleted outside the workflow: nothing is lost here, and the user can rebuild it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {kit,SESSION} from './kit-fixture.mjs';
import {fixtureContract} from './fixture-goals.mjs';
import {fileURLToPath} from 'node:url';

const OLD='12345678-1234-4234-8234-123456789abc',NEW='abcdef12-1234-4234-8234-123456789abc';
const LOST={lostThread:true},REBUILT={newThread:NEW};
const stateFile=p=>path.join(p.root,'.chatgpt-workflow/tasks/demo/state.json');
const load=p=>JSON.parse(fs.readFileSync(stateFile(p),'utf8'));
// Everything that must be exactly as it was; the failed run itself is recorded.
const kept=s=>{const {lastRun,runHistory,threadLost,updatedAt,...rest}=s;return rest;};
const methods=p=>p.captured().filter(c=>c.kind==='request').map(c=>c.method);
const turns=p=>methods(p).filter(m=>m==='turn/start').length;
const ask=JSON.stringify({status:'needs_questions',plan:'',contract:null,questions:[{id:'q1',header:'范围',question:'选哪个？',multiSelect:false,options:[{label:'甲',description:'a'},{label:'乙',description:'b'}]}]});
async function review(p,kind,text='通过'){const s=await p.call({action:'review-start',kind});return p.call({action:'review-save',kind,ticket:s.ticket,text});}
async function lostDuring(p,request){
  const before=load(p),n=turns(p);let error;
  await p.call(request,LOST).catch(e=>{error=e;});
  assert.ok(error,'the run must fail');assert.match(error.message,/找不到本任务的会话/);assert.match(error.message,/\/chatgpt-resume/);assert.match(error.message,/no rollout found/);
  const after=load(p);
  assert.deepEqual(kept(after),kept(before));
  assert.equal(after.threadId,OLD);assert.equal(after.threadLost.threadId,OLD);assert.equal(after.threadLost.action,request.action);
  assert.equal(after.lastRun.status,'failed');assert.equal(after.lastRun.action,request.action);
  assert.equal(turns(p),n,'no turn may start');assert.ok(!methods(p).slice(-2).includes('thread/start'),'never rebuilt automatically');
  return after;
}
const rebuild=(p,scenario=REBUILT)=>p.call({action:'resume',rebuildThread:true},scenario);

test('implement: a deleted conversation changes nothing, and after a rebuild the same approval is executed',async t=>{
  const p=kit(t);await p.approved();const approval=load(p).approved,plan=load(p).plan;
  const s=await lostDuring(p,{action:'implement'});assert.equal(s.phase,'approved');assert.equal(s.implementation,undefined);assert.equal(s.delivery,undefined);
  const r=await rebuild(p);
  assert.equal(r.threadId,NEW);assert.equal(r.threadLost,undefined);assert.equal(r.phase,'approved');
  assert.deepEqual(load(p).approved,approval);assert.deepEqual(load(p).plan,plan);
  assert.equal(load(p).threadHistory.length,1);assert.equal(load(p).threadHistory[0].threadId,OLD);
  const done=await p.call({action:'implement'});assert.equal(done.phase,'needs-code-review');assert.equal(done.threadId,NEW);
  assert.equal(p.captured().filter(c=>c.method==='thread/resume').at(-1).params.threadId,NEW);
});
test('a skipped plan review stays a valid approval',async t=>{
  const p=kit(t);await p.plan();await p.call({action:'approve',withoutReview:true});
  await lostDuring(p,{action:'implement'});await rebuild(p);
  assert.equal((await p.call({action:'implement'})).delivery.planReview,'skipped');
});
test('plan: the approval, the review and the previous delivery survive',async t=>{
  const p=kit(t);await p.approved();await p.call({action:'implement'});await review(p,'code');
  const s=await lostDuring(p,{action:'plan',text:'再改一点'});assert.equal(s.phase,'reviewed-code');assert.ok(s.approved);
  assert.equal((await p.call({action:'status'})).executionSummary.resultReview,'current');
  await rebuild(p);assert.equal((await p.call({action:'fix'})).phase,'needs-code-review');
});
test('plan: an unfinished review is not discarded',async t=>{
  const p=kit(t);await p.approved();await p.call({action:'implement'});const started=await p.call({action:'review-start',kind:'code'});
  await lostDuring(p,{action:'plan',text:'再改一点'});
  const files=fs.readFileSync(path.join(path.dirname(stateFile(p)),'review-questions.json'),'utf8');assert.doesNotMatch(files,/superseded/);
  assert.equal((await p.call({action:'review-save',kind:'code',ticket:started.ticket,text:'通过'})).phase,'reviewed-code');
});
test('revise-plan and fix keep the review they were based on',async t=>{
  const p=kit(t);await p.plan();await review(p,'plan','请修改');
  await lostDuring(p,{action:'revise-plan'});await rebuild(p);
  assert.equal((await p.call({action:'revise-plan'})).phase,'planned');
  const q=kit(t);await q.approved();await q.call({action:'implement'});await review(q,'code','请修复');
  await lostDuring(q,{action:'fix'});await rebuild(q);
  assert.equal((await q.call({action:'fix'})).phase,'needs-code-review');
});
test('answer: the saved answers are kept and delivered to the rebuilt conversation',async t=>{
  const p=kit(t),s=await p.plan({answer:ask}),request={action:'answer',roundId:s.pendingQuestions.id,answers:[{id:'q1',answer:'甲'}]};
  await p.call({action:'record-answers',roundId:request.roundId,answers:request.answers});
  let error;await p.call(request,LOST).catch(e=>{error=e;});assert.match(error.message,/找不到本任务的会话/);
  const saved=load(p);assert.equal(saved.phase,'awaiting-answers');assert.deepEqual(saved.pendingQuestions.answers,[{id:'q1',answer:'甲'}]);
  assert.equal(saved.questionHistory[0].answers[0].answer,'甲');assert.equal(saved.questionHistory[0].deliveredAt,undefined);
  const r=await rebuild(p);assert.equal(r.threadId,NEW);assert.equal(r.pendingQuestions.id,request.roundId,'the round is still open');
  const done=await p.call(request);assert.equal(done.phase,'planned');assert.equal(done.pendingQuestions,null);
});
test('resume and clarify report it too; resume never rebuilds without the explicit choice',async t=>{
  const p=kit(t);await p.plan();
  await lostDuring(p,{action:'resume'});await lostDuring(p,{action:'clarify',text:'解释一下'});await lostDuring(p,{action:'resume'});
  assert.equal(load(p).threadHistory,undefined);
});
test('a rebuild needs a recorded loss, an exact flag and the resume action',async t=>{
  const p=kit(t);await p.approved();
  await assert.rejects(rebuild(p),/没有会话丢失记录/);
  await lostDuring(p,{action:'implement'});
  for(const value of ['true',1,false,null])await assert.rejects(p.call({action:'resume',rebuildThread:value},REBUILT),/rebuildThread/);
  await assert.rejects(p.call({action:'implement',rebuildThread:true},REBUILT),/rebuildThread/);
  const s=load(p);s.threadLost.threadId=NEW;fs.writeFileSync(stateFile(p),JSON.stringify(s)); // a record about another conversation
  await assert.rejects(rebuild(p),/没有会话丢失记录/);
  assert.equal(load(p).threadId,OLD);
});
test('the rebuilt conversation is read-only and receives the saved records',async t=>{
  const p=kit(t),s=await p.call({action:'new',task:'demo',text:'需求原文甲乙丙'},{answer:ask});
  await p.call({action:'answer',roundId:s.pendingQuestions.id,answers:[{id:'q1',answer:'回答原文丁'}]});
  await review(p,'plan','评审原文戊');await p.call({action:'approve'});
  await lostDuring(p,{action:'implement'});await rebuild(p);
  const start=p.captured().filter(c=>c.method==='thread/start').at(-1).params,input=p.captured().filter(c=>c.method==='turn/start').at(-1).params;
  assert.equal(start.sandbox,'read-only');assert.equal(input.threadId,NEW);assert.equal(input.outputSchema,undefined);
  const text=input.input[0].text;
  for(const part of ['需求原文甲乙丙','回答原文丁','评审原文戊',fixtureContract.deliverables[0].description,'no longer exists'])assert.ok(text.includes(part),part);
});
test('requirements added later are handed over too, but not the input of an action that never started',async t=>{
  const p=kit(t);await p.plan();
  await p.call({action:'plan',text:'补充需求己庚\n第二行'},{answer:ask}); // not yet part of any plan
  await lostDuring(p,{action:'clarify',text:'未启动的输入辛'});await rebuild(p);
  const text=p.captured().filter(c=>c.method==='turn/start').at(-1).params.input[0].text;
  assert.ok(text.includes('补充需求己庚\\n第二行'));assert.ok(!text.includes('未启动的输入辛'));assert.ok(!text.includes('no additional input)"'));
});
test('a large delivery is summarised in the handover',async t=>{
  const p=kit(t);await p.approved();await p.call({action:'implement'});
  const s=load(p);s.delivery.changes=Array.from({length:20000},(_,i)=>({path:`generated/file-${i}.txt`,change:'added'}));fs.writeFileSync(stateFile(p),JSON.stringify(s));
  await p.call({action:'resume'},LOST).catch(()=>{});await rebuild(p);
  const text=p.captured().filter(c=>c.method==='turn/start').at(-1).params.input[0].text;
  assert.ok(text.length<200000,`${text.length}`);assert.ok(text.includes('20000'));
  assert.equal(load(p).delivery.changes.length,20000,'the saved record stays complete');
});
test('a rebuild that fails before its turn can be repeated; afterwards the new conversation is used',async t=>{
  const p=kit(t);await p.approved();await lostDuring(p,{action:'implement'});
  await assert.rejects(rebuild(p,{...REBUILT,threadError:'service unavailable'}),/service unavailable/);
  let s=load(p);assert.equal(s.threadId,OLD);assert.ok(s.threadLost);assert.equal(s.threadHistory,undefined);assert.equal(s.phase,'approved');
  await assert.rejects(rebuild(p,{...REBUILT,turnStatus:'failed',turnError:'quota exceeded'}),/quota exceeded/);
  s=load(p);assert.equal(s.threadId,NEW);assert.equal(s.threadLost,undefined);assert.equal(s.threadHistory.length,1);
  assert.equal((await p.call({action:'resume'})).threadId,NEW);assert.equal((await p.call({action:'implement'})).phase,'needs-code-review');
});
test('a conversation that was found again continues and clears the record',async t=>{
  const p=kit(t);await p.approved();await lostDuring(p,{action:'implement'});
  const s=await p.call({action:'implement'});assert.equal(s.phase,'needs-code-review');assert.equal(s.threadId,OLD);
  assert.equal(load(p).threadLost,undefined);assert.equal(load(p).threadHistory,undefined);
  await assert.rejects(rebuild(p),/没有会话丢失记录/);
});
test('other failures are not mistaken for a deleted conversation',async t=>{
  for(const message of ['service unavailable','stream disconnected',`no rollout found for thread id ${NEW}`]){
    const p=kit(t);await p.approved();
    await assert.rejects(p.call({action:'implement'},{threadError:message}),e=>!/找不到本任务的会话/.test(e.message));
    const s=load(p);assert.equal(s.threadLost,undefined);assert.equal(s.delivery.assessment,'execution-failed');
    await assert.rejects(rebuild(p),/没有会话丢失记录/);
  }
  const p=kit(t);await p.approved();
  await assert.rejects(p.call({action:'implement'},{turnStatus:'failed',turnError:`no rollout found for thread id ${OLD}`}),e=>!/找不到本任务的会话/.test(e.message));
  assert.equal(load(p).threadLost,undefined,'a turn had started');
});
test('a conversation that is open elsewhere is explained',async t=>{
  const p=kit(t);await p.approved();
  await assert.rejects(p.call({action:'implement'},{threadError:`thread ${OLD} already has an active writer`}),/正被占用[\s\S]*active writer/);
  assert.equal(load(p).threadLost,undefined);assert.equal((await p.call({action:'implement'})).phase,'needs-code-review');
});
test('a task left behind by an older version can be rebuilt and continued',async t=>{
  const p=kit(t);await p.approved();await p.call({action:'implement'},{threadError:`no rollout found for thread id ${NEW}`}).catch(()=>{});
  const old=load(p);assert.equal(old.phase,'implementing');assert.equal(old.threadLost,undefined); // the state older versions leave
  await lostDuring(p,{action:'resume'});await rebuild(p);
  const s=await p.call({action:'implement'});assert.equal(s.phase,'needs-code-review');assert.equal(s.threadId,NEW);
});
test('an unfinished review continues after the rebuild',async t=>{
  const p=kit(t);await p.approved();await lostDuring(p,{action:'implement'});
  const started=await p.call({action:'review-start',kind:'plan'});
  assert.equal((await p.call({action:'resume'})).resumeOwner,'claude');
  const r=await rebuild(p);assert.equal(r.threadId,NEW);assert.equal(r.reviewSession.ticket,started.ticket);
  await p.call({action:'review-save',kind:'plan',ticket:started.ticket,text:'通过'});await p.call({action:'approve'});
  assert.equal((await p.call({action:'implement'})).phase,'needs-code-review');
});
test('a rebuild is not swallowed by an earlier result nobody collected, and never runs beside another run',async t=>{
  const p=kit(t);await p.approved();await lostDuring(p,{action:'implement'});
  const runs=path.join(p.control,'runs');for(const id of fs.readdirSync(runs))fs.rmSync(path.join(runs,id,'delivered'),{force:true});
  assert.equal((await rebuild(p)).threadId,NEW);
  await p.call({action:'resume'},LOST).catch(()=>{});
  const n=turns(p),slow=p.call({action:'plan',text:'x'},{steps:[{delay:2500}]}),end=Date.now()+8000;
  while(turns(p)===n&&Date.now()<end)await new Promise(r=>setTimeout(r,50));
  await assert.rejects(rebuild(p),/已有执行/);await slow;
});
test('the first planning of a task can lose its conversation as well',async t=>{
  const p=kit(t);await p.plan({turnStatus:'failed',turnError:'quota'}).catch(()=>{});
  assert.equal(load(p).phase,'planning-error');assert.equal(load(p).threadId,OLD);
  await lostDuring(p,{action:'plan',text:'继续'});await rebuild(p);
  assert.equal((await p.call({action:'plan',text:'继续'})).phase,'planned');
});
test('a first planning whose UUID is only in the event log reports the loss and can be rebuilt',async t=>{
  const p=kit(t);await p.plan({turnStatus:'failed',turnError:'quota'}).catch(()=>{});
  const s=load(p);s.threadId=null;fs.writeFileSync(stateFile(p),JSON.stringify(s));
  await assert.rejects(p.call({action:'resume'},LOST),/找不到本任务的会话/);
  const lost=load(p);assert.equal(lost.phase,'planning-error');assert.equal(lost.threadId,OLD);assert.equal(lost.threadLost.threadId,OLD);assert.equal(lost.revision,s.revision);
  assert.equal((await rebuild(p)).threadId,NEW);assert.equal((await p.call({action:'plan',text:'继续'})).phase,'planned');
});
test('status shows the loss without calling Codex',async t=>{
  const p=kit(t);await p.approved();await lostDuring(p,{action:'implement'});const n=methods(p).length;
  const s=await p.call({action:'status'});assert.equal(s.threadLost.threadId,OLD);assert.equal(methods(p).length,n);
});
test('exec transport recognises it, restores the task and rebuilds',async t=>{
  const p=kit(t),{execute}=await import('../.claude/scripts/chatgpt-workflow.mjs');await p.approved();
  const fake=path.join(p.parent,'exec-fake.mjs');
  fs.writeFileSync(fake,`const e=o=>console.log(JSON.stringify(o));for await(const c of process.stdin);const a=process.argv.slice(2),i=a.indexOf('resume');
if(i>=0&&a[i+1]==='${OLD}'){console.error('Error: thread/resume: thread/resume failed: no rollout found for thread id ${OLD} (code -32600)');process.exit(1);}
e({type:'thread.started',thread_id:i>=0?a[i+1]:'${NEW}'});e({type:'item.completed',item:{type:'agent_message',text:'# Recap'}});e({type:'turn.completed'});`);
  const run=request=>execute(p.root,{sessionId:SESSION,...request},{transport:'exec',command:[process.execPath,fake]});
  const before=load(p);await assert.rejects(run({action:'implement'}),/找不到本任务的会话/);
  assert.deepEqual(kept(load(p)),kept(before));assert.equal(load(p).threadLost.threadId,OLD);
  const r=await run({action:'resume',rebuildThread:true});assert.equal(r.threadId,NEW);assert.equal(load(p).threadLost,undefined);assert.equal(load(p).threadHistory[0].threadId,OLD);
  assert.equal((await run({action:'resume'})).threadId,NEW);
});
test('the documents describe the recovery card, its limits and left-behind processes',()=>{
  const read=file=>fs.readFileSync(fileURLToPath(new URL(`../${file}`,import.meta.url)),'utf8'),refs='.claude/skills/chatgpt/references/';
  const flow=read(refs+'workflow.md'),card=flow.split('### 会话恢复卡片')[1]?.split('\n### ')[0]||'';
  for(const part of ['AskUserQuestion','重建 Codex 会话（推荐）','重试原会话','{"action":"resume","rebuildThread":true}','模型不得自行决定','取消、跳过问题、空白、超时都不算选择'])assert.ok(card.includes(part),part);
  assert.match(read('.claude/skills/chatgpt-resume/SKILL.md'),/threadLost[\s\S]*会话恢复卡片/);
  for(const part of ['rebuildThread','threadLost','threadHistory','leftoverProcesses'])assert.ok(read(refs+'runner.md').includes(part),part);
  for(const part of ['threadLost','leftoverProcesses'])assert.ok(read(refs+'status.md').includes(part),part);
  const readme=read('README.zh-CN.md');assert.match(readme,/不要在 Codex 或 ChatGPT 应用里删除/);assert.match(readme,/残留进程/);
});
test('exec transport still refuses a conversation that changes its UUID, also while rebuilding',async t=>{
  const p=kit(t),{execute}=await import('../.claude/scripts/chatgpt-workflow.mjs'),fake=path.join(p.parent,'exec-fake.mjs');
  fs.writeFileSync(fake,`const e=o=>console.log(JSON.stringify(o));for await(const c of process.stdin);e({type:'thread.started',thread_id:'${NEW}'});e({type:'thread.started',thread_id:'${OLD.replace('12345678','99999999')}'});e({type:'item.completed',item:{type:'agent_message',text:'# Recap'}});e({type:'turn.completed'});`);
  const run=request=>execute(p.root,{sessionId:SESSION,...request},{transport:'exec',command:[process.execPath,fake]});
  await assert.rejects(run({action:'new',task:'fresh',text:'需求'}),/different thread UUID/);
  await p.approved();await lostDuring(p,{action:'implement'});
  await assert.rejects(run({action:'resume',rebuildThread:true}),/different thread UUID/);
});
