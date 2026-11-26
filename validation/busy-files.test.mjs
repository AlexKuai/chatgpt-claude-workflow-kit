// A task file that another program has open for a moment must not cost a run its result.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {kit,SESSION} from './kit-fixture.mjs';

const PRELOAD=pathToFileURL(fileURLToPath(new URL('./busy-preload.mjs',import.meta.url))).href;
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}};
const until=async(f,ms=15000)=>{for(const end=Date.now()+ms;Date.now()<end;){if(f())return true;await new Promise(r=>setTimeout(r,50));}return false;};
const taskDir=p=>path.join(p.root,'.chatgpt-workflow/tasks/demo');
const load=p=>JSON.parse(fs.readFileSync(path.join(taskDir(p),'state.json'),'utf8'));
const turns=p=>p.captured().filter(c=>c.method==='turn/start').length;
const done=action=>`"lastRun": \\{[^{}]*"action": "${action}"[^{}]*"status": "completed"`,CONVERSATION='"threadId": "[0-9a-f]';
// Runs `action` while the rules apply; the rules end with it. Returns how often a failure was injected.
async function whileBusy(p,rules,action){
  const log=path.join(p.parent,`busy-${Math.random().toString(36).slice(2)}.log`),old={NODE_OPTIONS:process.env.NODE_OPTIONS};
  fs.writeFileSync(log,'');
  Object.assign(process.env,{NODE_OPTIONS:`${old.NODE_OPTIONS||''} --import ${PRELOAD}`.trim(),BUSY:JSON.stringify(rules),BUSY_LOG:log});
  let value,error;const at=Date.now();
  try{value=await action();}catch(e){error=e;}
  finally{
    if(old.NODE_OPTIONS===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=old.NODE_OPTIONS;
    delete process.env.BUSY;delete process.env.BUSY_LOG;
  }
  const hits=fs.readFileSync(log,'utf8').split('\n').filter(Boolean);
  assert.ok(hits.length,'the rule never applied');
  return {value,error,hits,ms:Date.now()-at};
}
function clean(p){
  assert.equal(fs.existsSync(path.join(p.root,'.chatgpt-workflow/lock.json')),false,'lock left behind');
  const walk=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(d,e.name)):[path.join(d,e.name)]);
  assert.deepEqual(walk(path.join(p.root,'.chatgpt-workflow')).filter(f=>f.endsWith('.tmp')),[]);
}
const state=(over={})=>({op:'rename',file:'/state\\.json$',worker:true,ms:2500,...over});

// ---- briefly in use ----
for(const [moment,rule] of [['when a run starts',{}],['when the conversation starts',{match:CONVERSATION}],['when the finished run is saved',{match:done('new')}]])
  test(`planning survives a state file in use ${moment}`,{timeout:60000},async t=>{
    const p=kit(t),r=await whileBusy(p,[state(rule)],()=>p.plan());
    assert.ifError(r.error);assert.equal(r.value.phase,'planned');assert.equal(load(p).lastRun.status,'completed');
    assert.match(load(p).threadId,/^12345678-/);assert.equal(turns(p),1);clean(p);
  });
test('a finished execution keeps its delivery record',{timeout:60000},async t=>{
  const p=kit(t);await p.approved();
  const r=await whileBusy(p,[state({match:done('implement')})],()=>p.call({action:'implement'},{steps:[{write:path.join(p.root,'app.txt'),content:'changed'}]}));
  assert.ifError(r.error);assert.equal(r.value.phase,'needs-code-review');
  const s=load(p);assert.equal(s.delivery.assessment,'needs-review');assert.equal(s.delivery.changesDetected,true);assert.equal(s.lastRun.status,'completed');clean(p);
});
test('cancelling works while the state file is in use',{timeout:60000},async t=>{
  const p=kit(t);const r=await whileBusy(p,[state({match:'"cancellation"'})],async()=>{
    const run=p.plan({steps:[{delay:20000}]}).catch(e=>e);
    assert.ok(await until(()=>turns(p)===1));
    const cancelled=await p.call({action:'cancel'}).catch(e=>e);return `${cancelled}${await run}`;
  });
  assert.ifError(r.error);assert.match(r.value,/取消/);assert.doesNotMatch(r.value,/意外结束/);assert.ok(load(p).lastRun.cancellation);clean(p);
});
for(const file of ['plan\\.md','questions\\.md','[^/]+\\.request\\.txt'])
  test(`planning survives ${file.replace(/\\|\[\^\/\]\+/g,'')} in use`,{timeout:60000},async t=>{
    const p=kit(t),r=await whileBusy(p,[state({file:`/${file}$`})],()=>p.plan());
    assert.ifError(r.error);assert.equal(r.value.phase,'planned');clean(p);
  });
test('saving a review survives its files in use',{timeout:60000},async t=>{
  const p=kit(t);await p.plan();const s=await p.call({action:'review-start',kind:'plan'});
  const r=await whileBusy(p,['/[^/]+\\.plan-review\\.md$','/state\\.json$','/review-questions\\.json$'].map(file=>({op:'rename',file,ms:700})),
    ()=>p.call({action:'review-save',kind:'plan',ticket:s.ticket,text:'通过'}));
  assert.ifError(r.error);assert.equal(r.value.phase,'reviewed-plan');assert.equal(new Set(r.hits).size,3);clean(p);
});
test('creating and deleting the lock survive a brief conflict',{timeout:60000},async t=>{
  const p=kit(t),r=await whileBusy(p,[{op:'create',file:'/lock\\.json$',worker:true,ms:400},{op:'unlink',file:'/lock\\.json$',worker:true,ms:400}],()=>p.plan());
  assert.ifError(r.error);assert.equal(r.value.phase,'planned');assert.equal(new Set(r.hits.map(h=>h.split(' ')[0])).size,2);clean(p);
});
for(const code of ['EPERM','EBUSY','EACCES'])test(`status reads a state file that is briefly ${code}`,{timeout:60000},async t=>{
  const p=kit(t);await p.plan();
  const r=await whileBusy(p,[{op:'read',file:'/state\\.json$',ms:400,code}],()=>p.call({action:'status'}));
  assert.ifError(r.error);assert.equal(r.value.phase,'planned');
});
for(const [moment,skip] of [['starts',0],['ends',1]])test(`settings being rewritten while a run ${moment} do not fail it`,{timeout:60000},async t=>{
  const p=kit(t);fs.writeFileSync(path.join(p.root,'.claude/settings.local.json'),'{}');
  const r=await whileBusy(p,[{op:'read',file:'/settings\\.local\\.json$',worker:true,skip,ms:400,code:'EBUSY'}],()=>p.plan());
  assert.ifError(r.error);assert.equal(r.value.phase,'planned');
});
test('exec transport keeps running when the state file is in use as the conversation starts',{timeout:60000},async t=>{
  const p=kit(t),fake=path.join(p.parent,'exec-fake.mjs'),script=path.join(p.root,'.claude/scripts/chatgpt-workflow.mjs');
  fs.writeFileSync(fake,`const e=o=>console.log(JSON.stringify(o));for await(const c of process.stdin);e({type:'thread.started',thread_id:'12345678-1234-4234-8234-123456789abc'});await new Promise(r=>setTimeout(r,300));e({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({status:'ready',plan:'p',questions:[],contract:{kind:'modify',deliverables:[{id:'D1',description:'d'}],allowedChanges:['a'],excludedChanges:[],acceptanceCriteria:['ok']}})}});e({type:'turn.completed'});`);
  const code=`import(${JSON.stringify(pathToFileURL(script).href)}).then(async m=>console.log((await m.execute(${JSON.stringify(p.root)},{action:'new',task:'demo',text:'x',sessionId:${JSON.stringify(SESSION)}},{transport:'exec',command:[process.execPath,${JSON.stringify(fake)}]})).phase)).catch(e=>{console.error(e.message);process.exitCode=1;})`;
  const r=await whileBusy(p,[state({worker:false,match:CONVERSATION})],()=>p.exec(['--input-type=module','-e',code]));
  assert.equal(r.value.out.trim(),'planned',r.value.err);clean(p);
});

// ---- really in use ----
test('a whole workflow runs while other processes keep reading the state file',{timeout:120000},async t=>{
  const p=kit(t),file=path.join(taskDir(p),'state.json');fs.mkdirSync(taskDir(p),{recursive:true});fs.rmdirSync(taskDir(p));
  const reader=`const fs=require('fs'),pause=new Int32Array(new SharedArrayBuffer(4));for(;;Atomics.wait(pause,0,0,1))try{fs.readFileSync(${JSON.stringify(file)});fs.readFileSync(${JSON.stringify(path.join(p.root,'.chatgpt-workflow/lock.json'))});}catch{/* not there yet */}`;
  const readers=Array.from({length:3},()=>spawn(process.execPath,['-e',reader],{stdio:'ignore',windowsHide:true}));
  const stop=()=>Promise.all(readers.map(c=>new Promise(r=>{if(c.exitCode!==null||c.signalCode!==null)return r();c.once('exit',r);c.kill();})));
  t.after(stop);
  for(let i=0;i<3;i++){
    if(i===0)await p.approved();else{await p.call({action:'plan',text:'继续'});const s=await p.call({action:'review-start',kind:'plan'});await p.call({action:'review-save',kind:'plan',ticket:s.ticket,text:'通过'});await p.call({action:'approve'});}
    assert.equal((await p.call({action:'implement'})).phase,'needs-code-review');
    assert.equal((await p.call({action:'status'})).phase,'needs-code-review');
  }
  await stop();clean(p);
});
test('a program holding the state file exclusively for seconds does not fail a run',{timeout:120000,skip:process.platform!=='win32'},async t=>{
  const p=kit(t);await p.approved();const file=path.join(taskDir(p),'state.json');
  const run=p.call({action:'implement'},{steps:[{delay:2500}]}).then(value=>({value,at:Date.now()}),error=>({error,at:Date.now()}));
  assert.ok(await until(()=>turns(p)===2));
  const holder=spawn('powershell',['-NoProfile','-Command',`$f=[IO.File]::Open('${file}','Open','Read','None');'held';Start-Sleep -Seconds 6;$f.Close()`],{windowsHide:true});
  t.after(()=>holder.kill());let held=0,released=0;holder.stdout.on('data',()=>{held=held||Date.now();});holder.on('exit',()=>{released=Date.now();});
  const r=await run;assert.ok(held,'the file was never held');
  assert.ifError(r.error);assert.equal(r.value.phase,'needs-code-review');
  await until(()=>released);assert.ok(r.at>=held+5500,'the run must have met the held file');
  assert.equal(load(p).lastRun.status,'completed');clean(p);
});

// ---- in use for good ----
const HELD=/无法保存 [^\n]*state\.json：[\s\S]*占用[\s\S]*可能已经完成[\s\S]*不要直接重新执行/;
test('when the final save stays impossible the message says so, and nothing is run again',{timeout:120000},async t=>{
  const p=kit(t);await p.approved();const n=turns(p);
  const r=await whileBusy(p,[state({match:done('implement'),ms:-1})],()=>p.call({action:'implement'},{steps:[{write:path.join(p.root,'app.txt'),content:'changed'}]}));
  assert.match(String(r.error),HELD);assert.doesNotMatch(String(r.error),/意外结束/);clean(p);
  assert.ok(fs.readdirSync(taskDir(p)).some(f=>f.endsWith('.result.raw.txt')),'the output is kept');
  const s=await p.call({action:'status'});assert.equal(s.lastRun.status,'running');assert.equal(turns(p),n+1);
  assert.equal((await p.call({action:'review-start',kind:'code'})).reviewSession.kind,'code','the work can still be reviewed');
});
test('a save that fails inside an event ends the run in order instead of losing the worker',{timeout:180000},async t=>{
  const p=kit(t),r=await whileBusy(p,[state({match:CONVERSATION,ms:-1})],()=>p.plan({steps:[{delay:60000}]}));
  assert.match(String(r.error),HELD);assert.doesNotMatch(String(r.error),/意外结束/);
  assert.ok(r.ms<35000,`took ${r.ms} ms`); // the full wait happens once
  const pid=load(p).lastRun.childPid;assert.ok(pid);assert.ok(await until(()=>!alive(pid)),'Codex still running');clean(p);
});
test('the original failure is kept when it cannot be saved',{timeout:120000},async t=>{
  const p=kit(t);await p.plan();
  const r=await whileBusy(p,[state({match:'"status": "failed"',ms:-1})],()=>p.call({action:'plan',text:'x'},{turnStatus:'failed',turnError:'quota exceeded'}));
  assert.match(String(r.error),/quota exceeded/);assert.match(String(r.error),HELD);
  const q=kit(t),first=await whileBusy(q,[state({match:'"status": "failed"',ms:-1})],()=>q.plan({turnStatus:'failed',turnError:'quota exceeded'}));
  assert.match(String(first.error),/任务 demo 已创建[\s\S]*quota exceeded/);assert.match(String(first.error),HELD);
});
test('a deleted conversation is still reported when the restored state cannot be saved',{timeout:60000},async t=>{
  const p=kit(t);await p.approved();
  const r=await whileBusy(p,[state({match:'"threadLost": \\{',ms:-1})],()=>p.call({action:'implement'},{lostThread:true}));
  assert.match(String(r.error),/找不到本任务的会话/);assert.match(String(r.error),HELD);clean(p);
  await assert.rejects(p.call({action:'resume'},{lostThread:true}),/找不到本任务的会话/);assert.ok(load(p).threadLost,'recorded by the next command');
});
test('unlock survives a lock that is briefly in use',{timeout:60000},async t=>{
  const p=kit(t);await p.plan();const lock=path.join(p.root,'.chatgpt-workflow/lock.json');fs.writeFileSync(lock,JSON.stringify({pid:2147483646}));
  const r=await whileBusy(p,[{op:'unlink',file:'/lock\\.json$',ms:400}],()=>p.call({action:'unlock'}));
  assert.ifError(r.error);assert.equal(r.value.unlocked,true);clean(p);
});
test('a lock that cannot be deleted does not hide the result',{timeout:60000},async t=>{
  const p=kit(t),r=await whileBusy(p,[{op:'unlink',file:'/lock\\.json$',worker:true,ms:-1}],()=>p.plan());
  assert.ifError(r.error);assert.equal(r.value.phase,'planned');
  await assert.rejects(p.call({action:'plan',text:'x'}),/stale lock/);
  await p.call({action:'unlock'});assert.equal((await p.call({action:'plan',text:'x'})).phase,'planned');
});

// ---- not merely in use ----
test('a directory in place of a file fails at once',{timeout:60000},async t=>{
  const p=kit(t);await p.plan();const s=await p.call({action:'review-start',kind:'plan'}),report=path.join(taskDir(p),`${s.ticket}.plan-review.md`);
  fs.mkdirSync(report);const at=Date.now();
  await assert.rejects(p.call({action:'review-save',kind:'plan',ticket:s.ticket,text:'通过'}),e=>/EPERM|EISDIR|EEXIST/.test(e.message)&&!/占用/.test(e.message));
  assert.ok(Date.now()-at<5000,`${Date.now()-at} ms`);fs.rmdirSync(report);
  assert.equal((await p.call({action:'review-save',kind:'plan',ticket:s.ticket,text:'通过'})).phase,'reviewed-plan');
});
test('an existing lock is refused at once',{timeout:60000},async t=>{
  const p=kit(t);await p.plan();const lock=path.join(p.root,'.chatgpt-workflow/lock.json');fs.writeFileSync(lock,JSON.stringify({pid:process.pid}));
  const at=Date.now();await assert.rejects(p.call({action:'review-start',kind:'plan'}),/Another workflow is running or a stale lock/);
  assert.ok(Date.now()-at<5000);fs.unlinkSync(lock);
});
test('a file that stays unreadable is still an error',{timeout:60000},async t=>{
  const p=kit(t);await p.plan();
  const r=await whileBusy(p,[{op:'read',file:'/state\\.json$',ms:-1,code:'EACCES'}],()=>p.call({action:'status'}));
  assert.match(String(r.error),/EACCES/);assert.ok(r.ms<8000,`${r.ms} ms`);
});
test('the documents say what to do when a task file stays in use',()=>{
  const doc=file=>fs.readFileSync(fileURLToPath(new URL(`../${file}`,import.meta.url)),'utf8');
  assert.match(doc('.claude/skills/chatgpt/references/runner.md'),/无法保存[\s\S]*不重新执行/);
  assert.match(doc('README.zh-CN.md'),/任务文件被占用/);
});
