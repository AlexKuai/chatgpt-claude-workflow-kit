import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {execute} from '../.claude/scripts/chatgpt-workflow.mjs';
function fixture(t){
 const parent=fs.realpathSync(process.env.CHATGPT_TEST_TMP||os.tmpdir());
 const root=fs.mkdtempSync(path.join(parent,'auto-task-'));
 t.after(()=>{if(path.dirname(root)!==parent)throw Error('Unsafe cleanup');fs.rmSync(root,{recursive:true,force:true});});
 const capture=path.join(root,'.chatgpt-workflow/capture.jsonl');
 const options={command:[process.execPath,fileURLToPath(new URL('./fake-codex.mjs',import.meta.url))],env:{CHATGPT_KIT_TRANSPORT:'exec',FAKE_CAPTURE:capture}};
 const run=(r,env={})=>execute(root,{sessionId:'session-a',...r},{...options,env:{...options.env,...env}});
 const calls=()=>fs.existsSync(capture)?fs.readFileSync(capture,'utf8').trim().split('\n').map(JSON.parse):[];
 const create=(text='修复密码检查',suggestedTask='password-policy-fix')=>({action:'new',text,suggestedTask,requestId:crypto.randomUUID()});
 return {root,run,calls,create};
}

test('automatic task preserves all Chinese/English input and binds the actual normalized name',async t=>{
 const p=fixture(t),text='Login 登录页面\n保留首词、引号 " 和参数 --wait；全部为需求';
 const request=p.create(text,' Email_Login PAGE! '),s=await p.run(request);
 assert.equal(s.task,'email-login-page');assert.equal(s.sessionBinding.task,s.task);
 assert.equal(s.creation.requestId,request.requestId);assert.equal(s.creation.requirementsHash,crypto.createHash('sha256').update(text).digest('hex'));
 assert.ok(p.calls()[0].text.endsWith(text));assert.equal(p.calls().length,1);
});

test('missing/invalid suggestion uses stable requirement hash, including Windows reserved names',async t=>{
 const p=fixture(t),text='调查故障';const expected='task-'+crypto.createHash('sha256').update(text).digest('hex').slice(0,8);
 const first=await p.run({...p.create(text),suggestedTask:undefined});assert.equal(first.task,expected);
 const second=await p.run(p.create(text,'纯中文'));assert.equal(second.task,expected+'-2');
 const third=await p.run(p.create(text,'CON'));assert.equal(third.task,expected+'-3');
});

test('collisions allocate suffixes under the lock and preserve existing tasks',async t=>{
 const p=fixture(t),names=[];let first;
 for(let i=0;i<3;i++){const s=await p.run(p.create());names.push(s.task);if(!i)first=s;}
 assert.deepEqual(names,['password-policy-fix','password-policy-fix-2','password-policy-fix-3']);
 await p.run({action:'use',task:first.task});assert.equal((await p.run({action:'status'})).threadId,first.threadId);
 assert.equal(p.calls().length,3);
});

test('long suggested names and suffixed collisions remain at most 64 characters',async t=>{
 const p=fixture(t),base='a'.repeat(90);
 assert.equal((await p.run(p.create('one',base))).task,'a'.repeat(64));
 assert.equal((await p.run(p.create('two',base))).task,'a'.repeat(62)+'-2');
});

test('missing requirements or invalid creation ID cause no filesystem writes or inference',async t=>{
 const p=fixture(t);
 for(const r of [{action:'new',requestId:crypto.randomUUID()},{...p.create(),text:' '},{...p.create(),requestId:'not-a-uuid'},{action:'new',text:'需求'}]){
  await assert.rejects(p.run(r));assert.equal(fs.existsSync(path.join(p.root,'.chatgpt-workflow')),false);assert.equal(p.calls().length,0);
 }
});

test('same creation ID returns the original task without another worker call; changed text is rejected',async t=>{
 const p=fixture(t),r=p.create(),first=await p.run(r);
 const again=await p.run({...r,suggestedTask:'a-different-advisory-name'});
 assert.equal(again.task,first.task);assert.equal(again.creationReplay,true);assert.equal(again.threadId,first.threadId);assert.equal(p.calls().length,1);
 await assert.rejects(p.run({...r,text:r.text+'增加范围'}),/需求|requirements/);
 await assert.rejects(p.run({...r,sessionId:'session-b'}),/session|会话/);
 assert.equal(p.calls().length,1);
});

test('failed startup remains failed on creation replay, with or without a saved UUID',async t=>{
 const p=fixture(t);
 for(const env of [{FAKE_EARLY_FAIL:'1'},{FAKE_FAIL:'1'}]){
  const r=p.create();await assert.rejects(p.run(r,env),/failed/i);const count=p.calls().length;
  const s=await p.run(r);assert.equal(s.creationReplay,true);assert.equal(s.lastRun.status,'failed');assert.ok(s.lastRun.error);assert.equal(p.calls().length,count);
  if(env.FAKE_EARLY_FAIL){assert.equal(s.threadId,null);const recovered=await p.run({action:'resume'});assert.equal(recovered.task,s.task);assert.ok(recovered.threadId);}
  else{assert.ok(s.threadId);const repaired=await p.run({action:'plan',text:'继续已失败的规划'});assert.equal(repaired.threadId,s.threadId);}
 }
});

test('replaying an older creation request does not replace a newer session binding',async t=>{
 const p=fixture(t),a=p.create('任务 A','task-a');await p.run(a);const b=await p.run(p.create('任务 B','task-b'));
 const replay=await p.run(a);assert.equal(replay.task,'task-a');assert.equal(replay.sessionBinding.task,b.task);assert.equal(replay.bindingUnchanged,true);
 assert.equal((await p.run({action:'status'})).task,b.task);assert.equal(p.calls().length,2);
});

test('binding-save failure can replay the durable creation without creating another task',async t=>{
 const p=fixture(t),r=p.create(),base=path.join(p.root,'.chatgpt-workflow');fs.mkdirSync(base);fs.writeFileSync(path.join(base,'sessions'),'blocks directory');
 await assert.rejects(p.run(r),/Unsafe state directory/);assert.equal(p.calls().length,0);
 fs.unlinkSync(path.join(base,'sessions'));
 const s=await p.run(r);assert.equal(s.creationReplay,true);assert.equal(s.sessionBinding.task,s.task);assert.equal(s.threadId,null);
 assert.equal(fs.readdirSync(path.join(base,'tasks')).length,1);assert.equal(p.calls().length,0);
});

test('explicit legacy task IDs still work and are never auto-suffixed',async t=>{
 const p=fixture(t),s=await p.run({action:'new',task:'old_task',text:'旧调用'});
 assert.equal(s.task,'old_task');await assert.rejects(p.run({action:'new',task:'old_task',text:'另一需求'}),/already exists/);
 await p.run({action:'use',task:'old_task'});const resumed=await p.run({action:'resume'});assert.equal(resumed.threadId,s.threadId);
});

test('reserved name after an interrupted initial save is not reused by another creation',async t=>{
 const p=fixture(t),r=p.create(),base=path.join(p.root,'.chatgpt-workflow'),dir=path.join(base,'creations');fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(path.join(dir,crypto.createHash('sha256').update(r.requestId).digest('hex')+'.json'),JSON.stringify({requestId:r.requestId,sessionId:'session-a',task:'password-policy-fix',requirementsHash:crypto.createHash('sha256').update(r.text).digest('hex'),requestedTask:null}));
 await assert.rejects(p.run(r),/状态缺失/);assert.equal(p.calls().length,0);
 const fresh=await p.run(p.create());assert.equal(fresh.task,'password-policy-fix-2');
});

test('parallel creation is serialized and a retried contender gets the next suffix',async t=>{
 const p=fixture(t),a=p.create(),b=p.create();
 const pending=p.run(a,{FAKE_DELAY:'350'});
 await assert.rejects(p.run(b),/lock|running/);await pending;
 assert.equal((await p.run(b)).task,'password-policy-fix-2');assert.equal(p.calls().length,2);
});

test('creation replay survives separate runner processes without another model call',t=>{
 const p=fixture(t),scripts=path.join(p.root,'.claude/scripts');fs.mkdirSync(scripts,{recursive:true});
 for(const name of ['chatgpt-workflow.mjs','goal-contract.mjs','file-snapshot.mjs','app-server-client.mjs','control-store.mjs','codex-bridge.mjs','runtime-questions.mjs','output-view.mjs'])fs.copyFileSync(fileURLToPath(new URL('../.claude/scripts/'+name,import.meta.url)),path.join(scripts,name));
 fs.writeFileSync(path.join(p.root,'.claude/chatgpt-workflow.json'),JSON.stringify({codexCommand:[process.execPath,fileURLToPath(new URL('./fake-codex.mjs',import.meta.url))]}));
 const request={...p.create('Design a login page','login-page'),sessionId:'cli-session'};
 const call=()=>{const r=spawnSync(process.execPath,[path.join(scripts,'chatgpt-workflow.mjs'),'--stdin'],{cwd:p.root,input:JSON.stringify(request),encoding:'utf8',env:{...process.env,CHATGPT_KIT_TRANSPORT:'exec',CHATGPT_KIT_HOME:path.join(p.root,'.chatgpt-workflow/kit-home'),FAKE_CAPTURE:path.join(p.root,'.chatgpt-workflow/capture.jsonl')}});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
 const first=call(),second=call();assert.equal(first.task,second.task);assert.equal(second.creationReplay,true);assert.equal(first.threadId,second.threadId);assert.equal(p.calls().length,1);
});
