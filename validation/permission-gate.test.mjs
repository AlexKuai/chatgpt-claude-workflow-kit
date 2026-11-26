import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {kit,SESSION,command} from './kit-fixture.mjs';
function setup(t){
  const p=kit(t),inbox=path.join(p.root,'.chatgpt-workflow','inbox');fs.mkdirSync(inbox,{recursive:true});
  const file=(request,name='request-1.json')=>{const f=path.join(inbox,name);fs.writeFileSync(f,JSON.stringify({sessionId:SESSION,...request}));return f;};
  const run=f=>`node "${p.runner}" --request-file "${f}"`;
  return {...p,inbox,file,run};
}
test('kit bookkeeping is allowed without prompting in Bash and PowerShell, with either slash style',async t=>{
  const p=setup(t),f=p.file({action:'status'});
  for(const tool_name of ['Bash','PowerShell'])assert.equal((await p.hook({command:p.run(f)},{tool_name})).permissionDecision,'allow');
  assert.equal((await p.hook({command:`node "${p.runner.replaceAll('\\','/')}" wait ${SESSION}`})).permissionDecision,'allow');
  const viaSkill=path.join(p.root,'.claude').replaceAll('\\','/')+'/skills/chatgpt-new/../../scripts/chatgpt-workflow.mjs';
  assert.equal((await p.hook({command:`node "${viaSkill}" doctor`})).permissionDecision,'allow');
  for(const action of ['new','answer','review-save','user-input-answer'])assert.equal((await p.hook({command:p.run(p.file({action}))})).permissionDecision,'allow',action);
  assert.equal((await p.hook({file_path:path.join(p.inbox,'request-abc.json'),content:'{}'},{tool_name:'Write'})).permissionDecision,'allow');
  const notes=path.join(p.root,'.chatgpt-workflow/tasks/demo/review-notes/12345678-1234-4234-8234-123456789abc.md');
  assert.equal((await p.hook({file_path:notes,content:'x'},{tool_name:'Write'})).permissionDecision,'allow');
});
test('writing phases stay neutral so only the user\'s own slash command covers them',async t=>{
  const p=setup(t);for(const action of ['implement','fix','approve','unlock','unknown'])assert.equal(await p.hook({command:p.run(p.file({action}))}),null,action);
});
test('a kit command that is wrapped or chained is sent back instead of prompting the user',async t=>{
  const p=setup(t),ok=p.run(p.file({action:'status'})),wait=`node "${p.runner}" wait ${SESSION}`;
  for(const bad of [ok+' ; rm -rf x',ok+' && whoami',ok+' | cat',ok+' > out',ok+'\nwhoami',ok+' $(whoami)',ok+' `whoami`',ok+' &','FOO=1 '+ok,'cd / && '+ok,
    wait+' | Select-Object -First 30',`$j = node "${p.runner}" status ${SESSION} | Out-String | ConvertFrom-Json`,
    `node "${p.runner.replaceAll('\\','/')}" cancel ${SESSION} ; ls`,`node "${p.runner}" decline-codex abc ${SESSION} | cat`,`node "${p.runner}" status ${SESSION}\n--full`]){
    const h=await p.hook({command:bad});
    assert.equal(h?.permissionDecision,'deny',bad);assert.match(h.permissionDecisionReason,/单独运行/);
  }
  assert.equal(await p.hook({command:wait+' | cat'},{permission_mode:'plan'}),null);
});
test('unrelated commands and lookalikes get no opinion',async t=>{
  const p=setup(t),ok=p.run(p.file({action:'status'}));
  for(const other of [`node "${p.runner}$HOME" status`,ok.replace('chatgpt-workflow.mjs','other.mjs'),ok.replace('chatgpt-workflow.mjs','other.mjs')+' | cat',
    `node "chatgpt-workflow.mjs" status`,`node "chatgpt-workflow.mjs" status x | cat`,`node -r x "${p.runner}" status`,`node "${p.runner}" wait someone-else`,
    `node "${p.runner}" --worker abc`,`node "${p.runner}" --stdin`,`node --check "${p.runner}" | cat`,`grep -n wait "${p.runner}" | head`,`cat "${p.runner}" ; echo status`])
    assert.equal(await p.hook({command:other}),null,other);
});
test('the full status switch is allowed for the current session only',async t=>{
  const p=setup(t);
  assert.equal((await p.hook({command:`node "${p.runner}" status ${SESSION} --full`})).permissionDecision,'allow');
  for(const bad of ['status someone-else --full',`wait ${SESSION} --full`,`status ${SESSION} --other`])assert.equal(await p.hook({command:`node "${p.runner}" ${bad}`}),null,bad);
});
const modeFile=p=>{const dir=path.join(p.control,'modes');return path.join(dir,fs.readdirSync(dir)[0]);};
test('any hooked call of the main conversation refreshes the mode; subagents do not',async t=>{
  const p=setup(t),name=modeFile(p),read=()=>JSON.parse(fs.readFileSync(name)),age=(mode,ms)=>fs.writeFileSync(name,JSON.stringify({mode,at:Date.now()-ms}));
  for(const [input,over] of [[{command:'ls'},{}],[{command:`node "${p.runner}" wait ${SESSION} | cat`},{}],[{file_path:path.join(p.root,'a.txt'),content:''},{tool_name:'Write'}],[{command:'Get-Date'},{tool_name:'PowerShell'}]]){
    age('default',10*60*1000);await p.hook(input,{...over,permission_mode:'auto'});
    assert.equal(read().mode,'auto');assert.ok(Date.now()-read().at<60000);
  }
  age('default',10*60*1000);await p.hook({command:'ls'},{permission_mode:'bypassPermissions',agent_id:'sub-1'});assert.equal(read().mode,'default');
  age('auto',1000);const recent=read().at;await p.hook({command:'ls'},{permission_mode:'auto'});assert.equal(read().at,recent,'an unchanged fresh mode is not rewritten');
  await p.hook({command:'ls'},{permission_mode:'default'});assert.equal(read().mode,'default','a change is recorded at once');
});
test('a stale mode is refreshed by an ordinary command before the next run',async t=>{
  const p=setup(t);
  fs.writeFileSync(modeFile(p),JSON.stringify({mode:'default',at:Date.now()-10*60*1000}));
  await p.hook({command:'ls'},{permission_mode:'auto'});
  const s=await p.plan();assert.equal(s.permissionNotice,undefined);assert.equal(s.lastRun.permissionMode,'auto');assert.equal(s.lastRun.approvalRoute,'auto-review');
});
test('path traversal, foreign sessions and other writes get no opinion',async t=>{
  const p=setup(t);
  for(const f of [path.join(p.inbox,'..','tasks','x.json'),path.join(p.inbox,'sub','request-1.json'),path.join(p.root,'request-1.json'),path.join(p.inbox,'evil.mjs'),'request-1.json',
    path.join(p.root,'.claude/settings.json'),path.join(p.root,'.chatgpt-workflow/tasks/demo/state.json'),path.join(p.root,'.chatgpt-workflow/tasks/demo/review-notes/a.md')])
    assert.equal(await p.hook({file_path:f,content:''},{tool_name:'Write'}),null,f);
  const outside=path.join(p.parent,'request-1.json');fs.writeFileSync(outside,JSON.stringify({sessionId:SESSION,action:'status'}));
  assert.equal(await p.hook({command:p.run(outside)}),null);
  assert.equal(await p.hook({command:p.run(p.file({action:'status',sessionId:'other'}))}),null);
  assert.equal(await p.hook({command:'ls'},{tool_name:'Edit'}),null);
});
test('plan mode allows nothing and denies approvals',async t=>{
  const p=setup(t),over={permission_mode:'plan'};
  assert.equal(await p.hook({command:p.run(p.file({action:'new'}))},over),null);
  assert.equal(await p.hook({file_path:path.join(p.inbox,'request-1.json'),content:''},{...over,tool_name:'Write'}),null);
  assert.equal((await p.hook({command:`node "${p.runner}" approve-codex aaaa bbbb`},over)).permissionDecision,'deny');
});
test('approvals always ask, show the recorded request, and cannot be pre-answered by the model',async t=>{
  const p=setup(t);await p.approved();const s=await p.call({action:'implement'},{steps:[command()]});
  for(const permission_mode of ['default','acceptEdits','auto','bypassPermissions','dontAsk']){
    const h=await p.hook({command:s.approveCommand,description:'harmless'},{permission_mode});
    assert.equal(h.permissionDecision,'ask',permission_mode);assert.match(h.permissionDecisionReason,/npm install zod[\s\S]*D:\/proj[\s\S]*需要网络[\s\S]*仅此一次/);
    assert.equal(h.updatedInput.description,'harmless');
  }
  assert.match((await p.hook({command:s.approveCommand+' --scope run'})).permissionDecisionReason,/本次运行内/);
  for(const bad of [s.approveCommand+' --gate x',s.approveCommand.slice(0,-2)+'00',s.approveCommand+' --scope always',`node "${p.runner}" approve-codex nope ${s.approval.digest}`])
    assert.equal((await p.hook({command:bad})).permissionDecision,'deny',bad);
  for(const wrapped of [s.approveCommand+' ; ls','true && '+s.approveCommand,s.approveCommand.replace('node ','node --no-warnings ')+' --gate x','cd / ; '+s.approveCommand+' --gate x'])
    assert.equal((await p.hook({command:wrapped},{permission_mode:'auto'})).permissionDecision,'deny',wrapped);
  assert.equal(await p.hook({command:'grep approve-codex chatgpt-workflow.mjs'}),null);
  const a=await p.hook({command:s.approveCommand}),b=await p.hook({command:s.approveCommand});
  assert.equal(a.updatedInput.command,b.updatedInput.command,'duplicate hook registrations agree');
  assert.deepEqual(p.responses(),[]);
  await p.argv(['decline-codex',s.approval.id,'bridge-session']);
});
test('every kit call refreshes the recorded mode used for the next run',async t=>{
  const p=setup(t);await p.hook({command:p.run(p.file({action:'status'}))},{permission_mode:'auto'});
  await p.plan();assert.equal(p.captured().find(c=>c.method==='thread/start').params.approvalsReviewer,'auto_review');
  await p.hook({command:p.run(p.file({action:'status'}))},{permission_mode:'default'});
  await p.call({action:'plan',text:'x'});assert.equal(p.captured().filter(c=>c.method==='thread/resume').at(-1).params.approvalsReviewer,'user');
});
test('malformed hook input is silent rather than permissive',async t=>{
  const p=setup(t);const gate=path.join(p.root,'.claude/scripts/permission-gate.mjs');
  for(const input of ['','not json','{}','{"tool_name":"Bash"}'])assert.equal((await p.exec([gate],{input})).out,'');
});
test('a consumed inbox request is removed after success; new requests and failures are kept for replay',async t=>{
  const p=setup(t);await p.plan();
  const ok=p.file({action:'status'},'request-status.json');let r=await p.exec([p.runner,'--request-file',ok]);
  assert.equal(r.status,0,r.err);assert.equal(fs.existsSync(ok),false);
  const failed=p.file({action:'review-save',kind:'plan',ticket:'stale',text:'x'},'request-failed.json');r=await p.exec([p.runner,'--request-file',failed]);
  assert.notEqual(r.status,0);assert.equal(fs.existsSync(failed),true);
  const created=p.file({action:'new',requestId:'11111111-1111-4111-8111-111111111111',suggestedTask:'second',text:'第二个任务'},'request-new.json');
  r=await p.exec([p.runner,'--request-file',created]);assert.equal(r.status,0,r.err);assert.equal(fs.existsSync(created),true);
  const outside=path.join(p.root,'request-outside.json');fs.writeFileSync(outside,JSON.stringify({sessionId:SESSION,action:'status'}));
  r=await p.exec([p.runner,'--request-file',outside]);assert.equal(r.status,0,r.err);assert.equal(fs.existsSync(outside),true);
});
