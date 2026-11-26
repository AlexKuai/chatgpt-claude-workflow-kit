import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {kit,SESSION,command} from './kit-fixture.mjs';
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}};
const until=async(f,ms=8000)=>{for(const end=Date.now()+ms;Date.now()<end;){if(f())return true;await new Promise(r=>setTimeout(r,50));}return false;};

test('app-server transport plans, resumes the saved UUID and leaves model selection to Codex',async t=>{
  const p=kit(t),s=await p.plan();
  assert.equal(s.runState,'completed');assert.equal(s.phase,'planned');assert.match(s.threadId,/^12345678-/);
  const r=await p.call({action:'resume'});assert.equal(r.threadId,s.threadId);
  const requests=p.captured().filter(c=>c.kind==='request');
  const start=requests.find(c=>c.method==='thread/start').params,turn=requests.find(c=>c.method==='turn/start').params,resume=requests.find(c=>c.method==='thread/resume').params;
  assert.equal(start.sandbox,'read-only');assert.equal(start.approvalPolicy,'on-request');assert.equal(resume.threadId,s.threadId);assert.equal(resume.sandbox,'read-only');
  assert.ok(turn.outputSchema.properties.plan);
  for(const params of [start,turn,resume])for(const key of ['model','effort','sandboxPolicy','profile'])assert.equal(params[key],undefined,key);
});
test('implementation uses workspace-write and records the approval route with the delivery',async t=>{
  const p=kit(t);await p.approved();const s=await p.call({action:'implement'});
  const last=p.captured().filter(c=>c.method==='thread/resume').at(-1).params;
  assert.equal(last.sandbox,'workspace-write');assert.equal(last.approvalsReviewer,'user');
  assert.equal(s.phase,'needs-code-review');assert.equal(s.delivery.approvals.route,'user');assert.equal(s.delivery.approvals.mode,'default');
});
test('retryable errors do not end the run; a failed turn does and keeps its message',async t=>{
  const p=kit(t);const s=await p.plan({steps:[{error:'Reconnecting... 1/5',willRetry:true},{error:'Reconnecting... 2/5',willRetry:true}]});
  assert.equal(s.phase,'planned');
  await assert.rejects(p.call({action:'plan',text:'again'},{turnStatus:'failed',turnError:'quota exceeded'}),/quota exceeded/);
});
test('an unexpected effective sandbox or reviewer stops before any turn',async t=>{
  const p=kit(t);
  await assert.rejects(p.plan({forceSandbox:{type:'dangerFullAccess'}}),/沙箱/);
  const q=kit(t);await assert.rejects(q.plan({forceReviewer:'auto_review'}),/审批方/);
  for(const x of [p,q])assert.ok(!x.captured().some(c=>c.method==='turn/start'));
});
test('a thread that never started a turn is not saved, so first planning can be retried',async t=>{
  const p=kit(t);await assert.rejects(p.plan({threadError:'boom'}),/boom/);
  const s=await p.call({action:'status'});assert.equal(s.threadId,null);assert.equal(s.phase,'planning-error');
  assert.equal((await p.call({action:'resume'})).phase,'planned');
});
test('a run outlives the foreground wait and is picked up again without a second start',async t=>{
  const p=kit(t),pending=p.plan({steps:[{delay:2500}]});
  assert.ok(await until(()=>p.captured().some(c=>c.method==='turn/start')));
  const s=await p.call({action:'status'});assert.equal(s.activeRun.alive,true);assert.equal(s.activeRun.action,'new');
  await assert.rejects(p.call({action:'plan',text:'x'}),/已有执行|running/);
  const [a,b]=await Promise.all([pending,p.call({action:'wait'})]);
  assert.equal([a,b].filter(r=>r.phase==='planned').length>=1,true);
  assert.equal(p.captured().filter(c=>c.method==='turn/start').length,1);
  assert.equal((await p.call({action:'wait'})).runState,'none');
});
test('the wait limit returns progress instead of killing Codex',async t=>{
  const p=kit(t);
  const code=`import('file:///${path.join(p.root,'.claude/scripts/chatgpt-workflow.mjs').replaceAll('\\','/')}').then(async m=>console.log(JSON.stringify(await m.dispatch(${JSON.stringify(p.root)},${JSON.stringify({action:'new',task:'demo',text:'x',sessionId:SESSION})},{maxWaitMs:300}))))`;
  const r=await p.exec(['--input-type=module','-e',code],{scenario:{steps:[{delay:1500}]}});
  assert.equal(JSON.parse(r.out).runState,'running',r.err);
  assert.equal((await p.call({action:'wait'})).phase,'planned');
});
test('cancel interrupts the turn and reports it as cancelled',async t=>{
  const p=kit(t),run=p.plan({steps:[{delay:20000}]}).catch(e=>e);
  assert.ok(await until(()=>p.captured().some(c=>c.method==='turn/start')));
  await assert.rejects(p.call({action:'cancel'}),/取消|另一次/);
  await run;assert.ok(p.captured().some(c=>c.method==='turn/interrupt'));
  assert.equal(fs.existsSync(path.join(p.root,'.chatgpt-workflow/lock.json')),false);
});
test('cancel kills the whole process tree when Codex ignores the interrupt',{timeout:60000},async t=>{
  const p=kit(t),pidFile=path.join(p.parent,'grandchild.pid');
  const run=p.plan({steps:[{grandchild:pidFile},{ignoreInterrupt:true}]}).catch(e=>e);
  assert.ok(await until(()=>fs.existsSync(pidFile)&&fs.readFileSync(pidFile,'utf8')));
  const pid=Number(fs.readFileSync(pidFile,'utf8'));
  const cancelled=p.call({action:'cancel'}).catch(e=>e);
  assert.match(String(await cancelled)+String(await run),/取消/);
  assert.ok(await until(()=>!alive(pid)),'grandchild still running');
});
test('a crashed app-server fails clearly and a lost worker is never rerun automatically',async t=>{
  const p=kit(t);await assert.rejects(p.plan({steps:[{exit:3}]}),/exited/);
  const q=kit(t),pending=q.plan({steps:[{delay:30000}]}).catch(e=>e);
  assert.ok(await until(()=>q.captured().some(c=>c.method==='turn/start')));
  const runs=path.join(q.control,'runs'),id=fs.readdirSync(runs)[0];
  process.kill(JSON.parse(fs.readFileSync(path.join(runs,id,'worker.json'))).pid);
  assert.match(String(await pending),/意外结束/);
  assert.equal(q.captured().filter(c=>c.method==='turn/start').length,1);
});
test('requirements and results do not linger in the control directory after delivery',async t=>{
  const p=kit(t);await p.call({action:'new',task:'demo',text:'机密需求文本'});
  const walk=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(d,e.name)):[path.join(d,e.name)]);
  for(const f of walk(p.control))assert.ok(!fs.readFileSync(f,'utf8').includes('机密需求文本'),f);
  const q=kit(t),s=await q.plan({steps:[command({command:'echo 机密命令'})]});
  const done=await q.call({action:'approval-decline',id:s.approval.id,text:'机密反馈'});
  for(const f of walk(q.control))assert.ok(!/机密命令|机密反馈/.test(fs.readFileSync(f,'utf8')),f);
  assert.match(fs.readFileSync(done.lastRun.approvalLog,'utf8'),/机密命令[\s\S]*机密反馈/);
});
test('exec remains available as a fallback and a retry notice no longer aborts it',async t=>{
  const p=kit(t);const {execute}=await import('../.claude/scripts/chatgpt-workflow.mjs');
  const fake=path.join(p.parent,'exec-fake.mjs');
  fs.writeFileSync(fake,`const e=o=>console.log(JSON.stringify(o));for await(const c of process.stdin);e({type:'thread.started',thread_id:'12345678-1234-4234-8234-123456789abc'});e({type:'error',message:'Reconnecting... 1/5'});e({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({status:'ready',plan:'p',questions:[],contract:{kind:'modify',deliverables:[{id:'D1',description:'d'}],allowedChanges:['a'],excludedChanges:[],acceptanceCriteria:['ok']}})}});e({type:'turn.completed'});`);
  const s=await execute(p.root,{action:'new',task:'x',text:'t',sessionId:'s'},{transport:'exec',command:[process.execPath,fake]});
  assert.equal(s.phase,'planned');
});
test('plan mode never starts a writing run and an unknown mode is disclosed',async t=>{
  const p=kit(t);await p.approved();p.setMode('plan');
  await assert.rejects(p.call({action:'implement'}),/Plan 模式/);
  const q=kit(t,{mode:null});assert.match((await q.plan({steps:[command()]})).permissionNotice,/hook/);
  assert.deepEqual(q.responses(),[{decision:'decline'}]);
});
test('several waiters on one run all see a failure as a failure, and none loses the outcome',async t=>{
  const {waitRun}=await import('../.claude/scripts/codex-bridge.mjs');
  const p=kit(t),dir=path.join(p.parent,'run');fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir,'outcome.json'),JSON.stringify({ok:false,error:'取消原因'}));
  for(let i=0;i<3;i++)await assert.rejects(waitRun({dir,meta:{pid:process.pid}}),/取消原因/);
  const run=p.plan({steps:[{delay:1200}],turnStatus:'failed',turnError:'quota exceeded'}).catch(e=>e);
  assert.ok(await until(()=>p.captured().some(c=>c.method==='turn/start')));
  const all=await Promise.all([run,...Array.from({length:4},()=>p.call({action:'wait'}).catch(e=>e))]);
  for(const r of all)assert.ok(r instanceof Error&&/quota exceeded/.test(r.message)||r.runState==='none',JSON.stringify(r.runState??r.message));
});
