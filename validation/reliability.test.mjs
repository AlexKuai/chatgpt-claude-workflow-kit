import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {kit,SESSION,command} from './kit-fixture.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(f){for(let i=0;i<200;i++){if(f())return;await sleep(30);}throw Error('Timed out waiting for fixture');}
const questions=()=>({request:'item/tool/requestUserInput',params:{questions:['first','second'].map(id=>({id,header:id,question:id+'?',options:[],isSecret:false}))}});

test('cancel during initialization never starts a turn or modifies deliverables',async t=>{
  const p=kit(t);await p.approved();const n=p.captured().length;
  const file=path.join(p.root,'cancelled.txt');
  const run=p.raw({action:'implement'},{initializeDelay:1500,steps:[{write:file},{delay:3000}]});
  await until(()=>p.captured().slice(n).some(c=>c.method==='initialize'));
  await p.raw({action:'cancel'});await run;
  assert.equal(p.captured().slice(n).some(c=>c.method==='turn/start'),false);
  assert.equal(fs.existsSync(file),false);
  assert.equal(fs.existsSync(path.join(p.root,'.chatgpt-workflow/lock.json')),false);
});

test('a newly bound session can take over a pending run without changing task state',async t=>{
  const p=kit(t);await p.approved();const pending=await p.call({action:'implement'},{steps:[command()]});
  const stateFile=path.join(p.root,'.chatgpt-workflow/tasks/demo/state.json'),before=fs.readFileSync(stateFile,'utf8');
  const selected=await p.call({action:'use',task:'demo',sessionId:'other'});
  assert.equal(selected.sessionBinding.task,'demo');assert.equal(fs.readFileSync(stateFile,'utf8'),before);
  const resumed=await p.call({action:'resume',sessionId:'other'});
  assert.equal(resumed.runId,pending.runId);assert.equal(resumed.approval.id,pending.approval.id);
  assert.equal((await p.hook({command:pending.approveCommand})).permissionDecision,'deny');
  await p.userApproves(resumed.approveCommand,{session_id:'other'});
  assert.equal(p.captured().filter(c=>c.method==='turn/start').length,2);
});

test('runtime answers are staged per question and restored before submitting',async t=>{
  const p=kit(t);await p.approved();const r=await p.call({action:'implement'},{steps:[questions()]});
  const id=r.userInput.id;
  await p.call({action:'user-input-record-answers',id,answers:[{id:'first',answer:'A with notes'}]});
  const resumed=await p.call({action:'resume'});
  assert.deepEqual(resumed.userInput.partialAnswers,[{id:'first',answer:'A with notes'}]);
  assert.deepEqual(resumed.userInput.unansweredQuestionIds,['second']);assert.equal(p.responses().length,0);
  const status=await p.call({action:'status'});
  assert.equal(status.activeRun.owner.sessionId,SESSION);
  assert.deepEqual(status.activeRun.pending[0].userInput.unansweredQuestionIds,['second']);
  await p.call({action:'user-input-record-answers',id,answers:[{id:'second',answer:'B'}]});
  await p.call({action:'user-input-answer',id});
  assert.deepEqual(p.responses(),[{answers:{first:{answers:['A with notes']},second:{answers:['B']}}}]);
});

test('cancel during thread resume stops before turn/start',async t=>{
  const p=kit(t);await p.approved();const n=p.captured().length;
  const run=p.raw({action:'implement'},{threadDelay:1500,steps:[{delay:3000}]});
  await until(()=>p.captured().slice(n).some(c=>c.method==='thread/resume'));
  await p.raw({action:'cancel'});await run;
  assert.equal(p.captured().slice(n).some(c=>c.method==='turn/start'),false);
});

test('cancel with a delayed turn/start reply interrupts and preserves the started thread',async t=>{
  const p=kit(t);const run=p.raw({action:'new',task:'demo',text:'x'},{turnResponseDelay:1200,steps:[{delay:5000}]});
  await until(()=>p.captured().some(c=>c.method==='turn/start'));
  const cancelled=await p.raw({action:'cancel'});await run;
  assert.equal(cancelled.status,1);assert.ok(p.captured().some(c=>c.method==='turn/interrupt'));
  const s=await p.call({action:'status'});assert.match(s.threadId,/^12345678-/);
  assert.equal(s.lastRun.cancellation.phase,'after-start');
});

test('approval gates issued before takeover are invalid; new owner can approve',async t=>{
  const p=kit(t);await p.approved();const r=await p.call({action:'implement'},{steps:[command()]});
  const h=await p.hook({command:r.approveCommand}),gate=h.updatedInput.command.split('--gate ')[1];
  await p.call({action:'use',task:'demo',sessionId:'other'});await p.call({action:'resume',sessionId:'other'});
  await assert.rejects(p.argv(['approve-codex',r.approval.id,r.approval.digest,'--gate',gate]),/接管|hook/);
  await assert.rejects(p.call({action:'approval-decline',id:r.approval.id}),/会话/);
  await p.userApproves(r.approveCommand,{session_id:'other'});
  assert.equal(p.responses().length,1);
});

test('own active run prevents switching tasks; another session can bind without unlocking execution',async t=>{
  const p=kit(t);await p.call({action:'new',task:'second',text:'x'});await p.approved();
  const r=await p.call({action:'implement'},{steps:[command()]});
  await assert.rejects(p.call({action:'use',task:'second'}),/活动运行/);
  await p.call({action:'use',task:'demo',sessionId:'other'});
  await assert.rejects(p.call({action:'implement',sessionId:'other'}),/执行|running/);
  assert.equal(p.captured().filter(c=>c.method==='turn/start').length,3);
  await p.call({action:'approval-decline',id:r.approval.id});
});

test('partial answers merge concurrently, keep corrections, and reject stale or empty submissions',async t=>{
  const p=kit(t);await p.approved();const r=await p.call({action:'implement'},{steps:[questions(),{delay:500}]});const id=r.userInput.id;
  await Promise.all(['first','second'].map(id2=>p.call({action:'user-input-record-answers',id,answers:[{id:id2,answer:id2}]})));
  await p.call({action:'user-input-record-answers',id,answers:[{id:'first',answer:'corrected exact text'}]});
  await assert.rejects(p.call({action:'user-input-record-answers',id,answers:[{id:'first',answer:'  '}]}),/为空/);
  await p.call({action:'use',task:'demo',sessionId:'other'});await p.call({action:'resume',sessionId:'other'});
  await assert.rejects(p.call({action:'user-input-answer',id}),/会话/);
  const done=await p.call({action:'user-input-answer',id,sessionId:'other'});
  await assert.rejects(p.call({action:'user-input-answer',id,sessionId:'other'}),/没有该待处理/);
  const archive=JSON.parse(fs.readFileSync(path.join(done.paths.task,r.runId+'.runtime-questions.json'),'utf8'));
  assert.equal(archive.entries[0].history.length,3);assert.equal(archive.entries[0].status,'answered');
  assert.equal(p.responses().length,1);
  await p.call({action:'resume',sessionId:'other'});
  assert.match(p.captured().filter(c=>c.method==='turn/start').at(-1).params.input[0].text,/corrected exact text/);
});

test('failed archive keeps answers externally; a later resume retries archive and restores context',async t=>{
  const p=kit(t);await p.approved();const r=await p.call({action:'implement'},{steps:[questions()]});const id=r.userInput.id;
  const archive=path.join(p.root,'.chatgpt-workflow/tasks/demo',r.runId+'.runtime-questions.json');
  fs.mkdirSync(archive);
  const staged=await p.call({action:'user-input-record-answers',id,answers:[{id:'first',answer:'durable-choice'}]});
  assert.ok(staged.archiveWarning);await p.raw({action:'cancel'});
  const journal=path.join(p.control,'runs',r.runId,'interactions',id+'.json');assert.ok(fs.existsSync(journal));
  fs.rmdirSync(archive);
  await p.call({action:'resume'});
  assert.ok(fs.existsSync(archive));assert.equal(fs.existsSync(journal),false);
  assert.match(p.captured().filter(c=>c.method==='turn/start').at(-1).params.input[0].text,/durable-choice/);
});

test('failed partial-answer save leaves previous answers intact and can be retried',async t=>{
  const p=kit(t);await p.approved();const r=await p.call({action:'implement'},{steps:[questions()]});const id=r.userInput.id;
  await p.call({action:'user-input-record-answers',id,answers:[{id:'first',answer:'saved'}]});
  const journal=path.join(p.control,'runs',r.runId,'interactions',id+'.json'),backup=journal+'.saved';
  fs.renameSync(journal,backup);fs.mkdirSync(journal);
  await assert.rejects(p.call({action:'user-input-record-answers',id,answers:[{id:'second',answer:'retry-me'}]}));
  fs.rmdirSync(journal);fs.renameSync(backup,journal);
  assert.deepEqual((await p.call({action:'resume'})).userInput.partialAnswers,[{id:'first',answer:'saved'}]);
  await p.call({action:'user-input-record-answers',id,answers:[{id:'second',answer:'retry-me'}]});
  await p.call({action:'user-input-answer',id});
});

test('cancel before worker execution never calls execute; cancellation after completion is a no-op',async t=>{
  const p=kit(t),id=crypto.randomUUID(),dir=path.join(p.control,'runs',id);fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'request.json'),JSON.stringify({request:{action:'new',sessionId:SESSION},permissionMode:'default'}));
  fs.writeFileSync(path.join(dir,'cancel.json'),'{}');
  const uri=new URL('../.claude/scripts/codex-bridge.mjs',import.meta.url).href;
  const code=`import {runWorker} from ${JSON.stringify(uri)};await runWorker(${JSON.stringify(p.root)},${JSON.stringify(id)},()=>{throw Error('EXECUTE_WAS_CALLED');});`;
  const r=await p.exec(['--input-type=module','-e',code]);assert.equal(r.status,0,r.err);
  const outcome=JSON.parse(fs.readFileSync(path.join(dir,'outcome.json'),'utf8'));assert.match(outcome.error,/启动回合前取消/);
  await p.plan();const file=path.join(p.root,'.chatgpt-workflow/tasks/demo/state.json'),before=fs.readFileSync(file,'utf8');
  assert.equal((await p.call({action:'cancel'})).runState,'none');assert.equal(fs.readFileSync(file,'utf8'),before);
});

test('concurrent takeovers serialize ownership and do not submit another turn',async t=>{
  const p=kit(t);await p.approved();const r=await p.call({action:'implement'},{steps:[command()]});
  await Promise.all(['B','C'].map(sessionId=>p.call({action:'use',task:'demo',sessionId})));
  await Promise.all(['B','C'].map(sessionId=>p.call({action:'resume',sessionId})));
  const owner=JSON.parse(fs.readFileSync(path.join(p.control,'runs',r.runId,'owner.json'),'utf8'));
  assert.equal(owner.revision,2);assert.ok(['B','C'].includes(owner.sessionId));
  const loser=owner.sessionId==='B'?'C':'B';
  await assert.rejects(p.call({action:'approval-decline',id:r.approval.id,sessionId:loser}),/会话/);
  await p.call({action:'approval-decline',id:r.approval.id,sessionId:owner.sessionId});
  assert.equal(p.captured().filter(c=>c.method==='turn/start').length,2);
});

test('withdrawn runtime questions retain partial answers but reject further submission',async t=>{
  const p=kit(t);await p.approved();const r=await p.call({action:'implement'},{withdrawAfter:1800,steps:[questions(),{delay:400}]});
  await p.call({action:'user-input-record-answers',id:r.userInput.id,answers:[{id:'first',answer:'keep-on-withdrawal'}]});
  await until(()=>p.responses().some(r=>r.withdrawn));
  await p.call({action:'wait'});
  await assert.rejects(p.call({action:'user-input-answer',id:r.userInput.id}),/没有该待处理/);
  const archive=JSON.parse(fs.readFileSync(path.join(p.root,'.chatgpt-workflow/tasks/demo',r.runId+'.runtime-questions.json'),'utf8'));
  assert.equal(archive.entries[0].status,'unanswered');assert.match(archive.entries[0].reason,/撤回/);
  assert.equal(archive.entries[0].partialAnswers[0].answer,'keep-on-withdrawal');
});

test('runtime question timeout archives partial answers without answering missing questions',async t=>{
  const p=kit(t);await p.approved();
  const {runAppServer}=await import('../.claude/scripts/codex-bridge.mjs');
  const {recordRuntimeAnswers,archiveRuntimeInputs}=await import('../.claude/scripts/runtime-questions.mjs');
  const previous=process.env.CHATGPT_KIT_HOME;process.env.CHATGPT_KIT_HOME=p.home;
  t.after(()=>{if(previous===undefined)delete process.env.CHATGPT_KIT_HOME;else process.env.CHATGPT_KIT_HOME=previous;});
  const id=crypto.randomUUID(),dir=path.join(p.control,'runs',id),taskDir=path.join(p.root,'.chatgpt-workflow/tasks/demo');fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'worker.json'),JSON.stringify({sessionId:SESSION,pid:process.pid,startedAt:Date.now()}));
  fs.writeFileSync(path.join(dir,'task.json'),JSON.stringify({task:'demo',taskDir}));
  const state={task:'demo',threadId:null,lastRun:{}};
  const run=runAppServer({root:p.root,dir:taskDir,state,request:{action:'implement',prompt:'x'},command:JSON.parse(fs.readFileSync(path.join(p.root,'.claude/chatgpt-workflow.json'))).codexCommand,
    env:{...process.env,FAKE_SCENARIO:JSON.stringify({steps:[questions()]}),FAKE_CAPTURE:path.join(p.parent,'capture.jsonl')},persist(){},runId:id,log:path.join(taskDir,id+'.events'),stderrFile:path.join(taskDir,id+'.stderr'),writing:true,
    bridge:{dir,runId:id,permissionMode:'default',approvalTimeoutMs:1000}});
  await until(()=>fs.existsSync(path.join(dir,'pending'))&&fs.readdirSync(path.join(dir,'pending')).length);
  const qid=fs.readdirSync(path.join(dir,'pending'))[0].replace('.json','');
  recordRuntimeAnswers(p.root,{id:qid,sessionId:SESSION,answers:[{id:'first',answer:'retain-on-timeout'}]});
  await run;const archived=JSON.parse(fs.readFileSync(archiveRuntimeInputs({dir,id}),'utf8'));
  assert.equal(archived.entries[0].status,'unanswered');assert.match(archived.entries[0].reason,/超时/);
  assert.equal(archived.entries[0].partialAnswers[0].answer,'retain-on-timeout');assert.deepEqual(p.responses().at(-1),{answers:{}});
  // The fixture cleanup must never kill the test runner itself.
  fs.unlinkSync(path.join(dir,'worker.json'));
});

test('terminal notification ends a cancelled turn even when its start RPC reply is late',{timeout:15000},async t=>{
  const p=kit(t),run=p.raw({action:'new',task:'demo',text:'x'},{turnResponseDelay:20000,steps:[{delay:30000}]});
  await until(()=>p.captured().some(c=>c.method==='turn/start'));
  const now=Date.now();await p.raw({action:'cancel'});await run;
  assert.ok(Date.now()-now<10000,'waited for the late turn/start reply');
  assert.equal(p.captured().filter(c=>c.method==='turn/interrupt').length,1);
});

test('a lost worker keeps unarchived answers recoverable without inventing a successful outcome',async t=>{
  const p=kit(t);await p.approved();const r=await p.call({action:'implement'},{steps:[questions()]});
  const archive=path.join(p.root,'.chatgpt-workflow/tasks/demo',r.runId+'.runtime-questions.json');fs.mkdirSync(archive);
  await p.call({action:'user-input-record-answers',id:r.userInput.id,answers:[{id:'first',answer:'survives-worker-loss'}]});
  const dir=path.join(p.control,'runs',r.runId),meta=JSON.parse(fs.readFileSync(path.join(dir,'worker.json'),'utf8'));
  process.kill(meta.pid);await p.raw({action:'wait'});fs.rmdirSync(archive);
  const s=await p.call({action:'status'});assert.ok(s.archiveWarnings.length,'lost answers must remain visible');
  await sleep(300);await p.call({action:'unlock'});
  const resumed=await p.call({action:'resume'});
  assert.equal(resumed.lastRun.action,'resume');
  assert.equal(fs.existsSync(path.join(dir,'outcome.json')),false,'must not fabricate successful execution');
  const record=JSON.parse(fs.readFileSync(archive,'utf8')).entries[0];
  assert.equal(record.partialAnswers[0].answer,'survives-worker-loss');assert.match(record.reason,/未知|异常/);
  assert.match(p.captured().filter(c=>c.method==='turn/start').at(-1).params.input[0].text,/survives-worker-loss/);
});

test('a committed approval is preserved when another session takes over before turn completion',async t=>{
  const p=kit(t);await p.approved();const r=await p.call({action:'implement'},{steps:[command(),{delay:1800}]});
  const accepted=p.userApproves(r.approveCommand);
  await until(()=>fs.existsSync(path.join(p.control,'runs',r.runId,'decisions',r.approval.id+'.json')));
  await p.call({action:'use',task:'demo',sessionId:'other'});
  await p.call({action:'resume',sessionId:'other'});await accepted;
  assert.deepEqual(p.responses(),[{decision:'accept'}]);
  assert.equal(p.captured().filter(c=>c.method==='turn/start').length,2);
});

test('short locks survive contention between processes',{timeout:60000},async t=>{
  const p=kit(t),lock=path.join(p.parent,'contended.lock'),store=pathToFileURL(path.join(p.root,'.claude/scripts/control-store.mjs')).href;
  const code="import('"+store+"').then(({shortLock})=>{const bad=[];for(let i=0;i<600;i++)try{shortLock(process.argv[1],()=>{});}catch(e){bad.push(e.code||e.message);}console.log(JSON.stringify(bad));})";
  const runs=await Promise.all(Array.from({length:4},()=>p.exec(['-e',code,lock])));
  for(const r of runs)assert.equal(r.out.trim(),'[]',r.err);
  assert.equal(fs.existsSync(lock),false);
});

test('a question Codex has withdrawn is not offered again before the worker settles it',async t=>{
  const p=kit(t);await p.approved();const r=await p.call({action:'implement'},{steps:[questions()]});
  const run=path.join(p.control,'runs',r.runId),marker=path.join(run,'withdrawn',r.userInput.id+'.json');
  assert.equal((await p.call({action:'status'})).activeRun.pending.length,1);
  fs.mkdirSync(path.dirname(marker),{recursive:true});fs.writeFileSync(marker,'{}');
  assert.deepEqual((await p.call({action:'status'})).activeRun.pending,[]);
  await p.raw({action:'cancel'});
});
