// A run ends when Codex itself ends, even if a process it left behind still holds its output pipes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {kit} from './kit-fixture.mjs';
import {AppServerClient,killChild} from '../.claude/scripts/app-server-client.mjs';

const LIMIT=20000; // the left-behind process lives for 40 s
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}};
const until=async(f,ms=8000)=>{for(const end=Date.now()+ms;Date.now()<end;){if(f())return true;await new Promise(r=>setTimeout(r,50));}return false;};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function leftover(t,dir,name='leftover.pid'){
  const file=path.join(dir,name),pid=()=>Number(fs.readFileSync(file,'utf8'));
  t.after(()=>{try{process.kill(pid());}catch{/* already gone */}});
  return {file,pid};
}
const timed=async f=>{const at=Date.now();let value,error;try{value=await f();}catch(e){error=e;}return {value,error,ms:Date.now()-at};};
// A bare app-server stand-in: exits when stdin ends, optionally leaving a pipe holder behind.
function server(t,{hold,body=''}={}){
  const dir=fs.mkdtempSync(path.join(process.env.CHATGPT_TEST_TMP||os.tmpdir(),'finish-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const holder=leftover(t,dir),file=path.join(dir,'server.mjs'),up=path.join(dir,'up');
  fs.writeFileSync(file,`import fs from 'node:fs';import {spawn} from 'node:child_process';
${hold?`const c=spawn(process.execPath,['-e','setTimeout(()=>{},40000)'],{stdio:['ignore','inherit','inherit'],detached:true,windowsHide:true});c.unref();fs.writeFileSync(${JSON.stringify(holder.file)},String(c.pid));`:''}
const HOLDER=${JSON.stringify(holder.file)};process.stdin.resume();process.stdin.on('end',()=>{${body}process.exit(0);});fs.writeFileSync(${JSON.stringify(up)},'');`);
  const seen=[],client=new AppServerClient({command:[process.execPath,file],cwd:os.tmpdir(),env:process.env,onRequest:()=>({}),onNotification:m=>seen.push(m)});
  return {client,seen,holder,ready:()=>until(()=>fs.existsSync(up),15000)};
}
function innocent(t){
  const c=spawn(process.execPath,['-e','setTimeout(()=>{},40000)'],{stdio:'ignore',windowsHide:true});
  t.after(()=>c.kill());return c;
}

test('planning finishes although a process left behind by Codex still holds its output',{timeout:60000},async t=>{
  const p=kit(t),l=leftover(t,p.parent),r=await timed(()=>p.plan({steps:[{leftover:l.file}]}));
  assert.ifError(r.error);assert.equal(r.value.phase,'planned');assert.equal(r.value.lastRun.status,'completed');
  assert.ok(r.ms<LIMIT,`took ${r.ms} ms`);assert.equal(r.value.lastRun.leftoverProcesses,true);
  assert.ok(alive(l.pid()),'the left-behind process must not be ended');
  assert.equal(fs.existsSync(path.join(p.root,'.chatgpt-workflow/lock.json')),false);
  assert.equal((await p.call({action:'resume'})).runState,'completed');
});
test('the detached worker itself also ends',{timeout:60000},async t=>{
  const p=kit(t),l=leftover(t,p.parent);await timed(()=>p.plan({steps:[{leftover:l.file}]}));
  const runs=path.join(p.control,'runs'),pid=JSON.parse(fs.readFileSync(path.join(runs,fs.readdirSync(runs)[0],'worker.json'))).pid;
  assert.ok(await until(()=>!alive(pid)),'worker still running');assert.ok(alive(l.pid()));
});
test('an execution keeps its result and warns that a left-behind process may still change files',{timeout:60000},async t=>{
  const p=kit(t),l=leftover(t,p.parent);await p.approved();
  const r=await timed(()=>p.call({action:'implement'},{steps:[{write:path.join(p.root,'app.txt'),content:'changed'},{leftover:l.file}]}));
  assert.ifError(r.error);assert.ok(r.ms<LIMIT,`took ${r.ms} ms`);
  assert.equal(r.value.phase,'needs-code-review');assert.equal(r.value.delivery.assessment,'needs-review');assert.equal(r.value.delivery.outcome,'partial'); // as the fixture reports
  assert.ok(r.value.delivery.changesSummary.total>=1);
  assert.match(r.value.delivery.warnings.join('\n'),/残留进程/);assert.ok(alive(l.pid()));
});
test('without a left-behind process nothing is recorded or warned',async t=>{
  const p=kit(t);await p.approved();const s=await p.call({action:'implement'});
  assert.equal(s.lastRun.leftoverProcesses,undefined);assert.doesNotMatch(s.delivery.warnings.join('\n'),/残留进程/);
});
test('a crash reports its exit code promptly despite a left-behind process',{timeout:60000},async t=>{
  const p=kit(t),l=leftover(t,p.parent);await p.approved();
  const r=await timed(()=>p.call({action:'implement'},{steps:[{leftover:l.file},{exit:3}]}));
  assert.match(String(r.error),/exited \(3\)/);assert.ok(r.ms<LIMIT,`took ${r.ms} ms`);
  const s=await p.call({action:'status'});assert.equal(s.delivery.assessment,'execution-failed');assert.match(s.delivery.warnings.join('\n'),/残留进程/);
});
test('cancelling finishes promptly despite a left-behind process',{timeout:60000},async t=>{
  const p=kit(t),l=leftover(t,p.parent),run=p.plan({steps:[{leftover:l.file},{delay:30000}]}).catch(e=>e);
  assert.ok(await until(()=>fs.existsSync(l.file)&&fs.readFileSync(l.file,'utf8')));
  const r=await timed(()=>p.call({action:'cancel'}));
  assert.match(String(r.error)+String(await run),/取消/);assert.ok(r.ms<LIMIT,`took ${r.ms} ms`);
});
test('a run whose Codex is still working is not cut short',{timeout:60000},async t=>{
  const p=kit(t),l=leftover(t,p.parent),r=await timed(()=>p.plan({steps:[{leftover:l.file},{delay:4500}]}));
  assert.ifError(r.error);assert.ok(r.ms>=4500);assert.equal(r.value.phase,'planned');
});
test('exec transport finishes the same way',{timeout:60000},async t=>{
  const p=kit(t),l=leftover(t,p.parent),{execute}=await import('../.claude/scripts/chatgpt-workflow.mjs'),fake=path.join(p.parent,'exec-fake.mjs');
  fs.writeFileSync(fake,`import fs from 'node:fs';import os from 'node:os';import {spawn} from 'node:child_process';
const e=o=>fs.writeSync(1,JSON.stringify(o)+'\\n');for await(const c of process.stdin);
const c=spawn(process.execPath,['-e','setTimeout(()=>{},40000)'],{cwd:os.tmpdir(),stdio:['ignore','inherit','inherit'],detached:true,windowsHide:true});c.unref();fs.writeFileSync(${JSON.stringify(l.file)},String(c.pid));
e({type:'thread.started',thread_id:'12345678-1234-4234-8234-123456789abc'});
e({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({status:'ready',plan:'p',questions:[],contract:{kind:'modify',deliverables:[{id:'D1',description:'d'}],allowedChanges:['a'],excludedChanges:[],acceptanceCriteria:['ok']}})}});e({type:'turn.completed'});process.exit(0);`);
  const r=await timed(()=>execute(p.root,{action:'new',task:'x',text:'t',sessionId:'s'},{transport:'exec',command:[process.execPath,fake]}));
  assert.ifError(r.error);assert.equal(r.value.phase,'planned');assert.ok(r.ms<LIMIT,`took ${r.ms} ms`);
  assert.equal(r.value.lastRun.leftoverProcesses,true);assert.ok(alive(l.pid()));
});
test('output written just before Codex exits is read completely',{timeout:60000},async t=>{
  const s=server(t,{hold:true,body:"for(let i=0;i<4000;i++)fs.writeSync(1,JSON.stringify({method:'n',params:{i,pad:'x'.repeat(80)}})+'\\n');"});
  assert.ok(await s.ready());const r=await timed(()=>s.client.close());
  assert.ok(r.ms<LIMIT,`took ${r.ms} ms`);assert.equal(s.seen.length,4000);assert.equal(s.client.leftover,true);assert.ok(alive(s.holder.pid()));
});
test('output that arrives shortly after the exit still counts',{timeout:60000},async t=>{
  const line=JSON.stringify(JSON.stringify({method:'late',params:{}})+'\n');
  const child=`setTimeout(()=>require('fs').writeSync(1,${line}),900);setTimeout(()=>{},40000)`;
  const s=server(t,{body:`const c=spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:['ignore','inherit','inherit'],detached:true,windowsHide:true});c.unref();fs.writeFileSync(HOLDER,String(c.pid));`});
  assert.ok(await s.ready());const r=await timed(()=>s.client.close());
  assert.ok(r.ms<LIMIT,`took ${r.ms} ms`);assert.deepEqual(s.seen.map(m=>m.method),['late']);
});
test('an ordinary exit closes at once',async t=>{
  const s=server(t);assert.ok(await s.ready());let exited;s.client.child.once('exit',()=>{exited=Date.now();});
  await s.client.close();const ms=Date.now()-exited;assert.ok(ms<1000,`took ${ms} ms after the exit`);assert.equal(s.client.leftover,false);
});
test('after Codex has exited its PID is never killed, because it may already belong to another process',{timeout:60000},async t=>{
  const s=server(t,{hold:true}),other=innocent(t);assert.ok(await s.ready());
  const exited=new Promise(r=>s.client.child.once('exit',r));
  s.client.child.stdin.end();await exited;
  s.client.pid=other.pid; // the system reused the number
  s.client.kill();await s.client.close(50);await sleep(300);
  assert.equal(other.exitCode,null);assert.equal(other.signalCode,null);assert.ok(alive(other.pid));
  killChild({pid:other.pid,exitCode:0,signalCode:null});killChild({pid:other.pid,exitCode:null,signalCode:'SIGTERM'});
  await sleep(300);assert.ok(alive(other.pid));
  const ended=new Promise(r=>other.once('exit',r));killChild(other);await ended; // a live child is still ended
});
test('progress says when Codex has completed and the run is being finished',{timeout:60000},async t=>{
  const p=kit(t),l=leftover(t,p.parent),run=p.plan({steps:[{leftover:l.file}]}),runs=path.join(p.control,'runs');let seen='';
  const progress=()=>{try{return JSON.parse(fs.readFileSync(path.join(runs,fs.readdirSync(runs)[0],'progress.json'),'utf8')).text;}catch{return '';}};
  assert.ok(await until(()=>/正在收尾/.test(seen=progress()),15000),seen);await run;
});
