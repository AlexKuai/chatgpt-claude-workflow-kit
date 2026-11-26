import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {kit,SESSION,command} from './kit-fixture.mjs';

// A task the size of a real multi-round document job.
function inflate(p){
  const file=path.join(p.root,'.chatgpt-workflow/tasks/demo/state.json'),state=JSON.parse(fs.readFileSync(file,'utf8'));
  const entry=i=>({path:`.work/task/render/page-${i}.png`,type:'file',size:12345,hash:'a'.repeat(64),backupReason:'binary'});
  state.delivery.changes=[...Array.from({length:299},(_,i)=>({path:entry(i).path,change:i%3?'added':'modified',before:entry(i),after:entry(i)})),
    {path:'report.docx',change:'added',before:null,after:{...entry(0),path:'report.docx'}}];
  state.reviewHistory=Array.from({length:12},(_,i)=>({ticket:`t${i}`,kind:'plan',rounds:[{id:`r${i}`,questions:[],partialAnswers:[]}],draft:{text:'评'.repeat(900)}}));
  state.runHistory=Array.from({length:20},(_,i)=>({id:`run-${i}`,action:'plan',status:'completed',startedAt:'2026-01-01',finishedAt:'2026-01-02',log:'x'.repeat(150),stderrFile:'y'.repeat(150)}));
  state.questionHistory=Array.from({length:10},(_,i)=>({id:`q${i}`,questions:[{id:'a',header:'h',question:'问'.repeat(150),multiSelect:false,options:[]}],answers:[{id:'a',answer:'答'.repeat(150)}]}));
  state.requirements='需求'.repeat(4000);
  fs.writeFileSync(file,JSON.stringify(state,null,2));return file;
}
const status=async(p,...extra)=>{const r=await p.exec([p.runner,'status',SESSION,...extra]);assert.equal(r.status,0,r.err);return r.out;};

test('a large task stays within the tool output limit and keeps everything needed to act',async t=>{
  const p=kit(t);await p.approved();await p.call({action:'implement'});
  const file=inflate(p),before=fs.readFileSync(file);
  const out=await status(p),s=JSON.parse(out);
  assert.ok(out.length<20000,`status printed ${out.length} characters`);
  assert.equal(s.delivery.changes,undefined);assert.equal(s.executionSummary.delivery,undefined);
  assert.equal(s.delivery.changesSummary.total,300);
  assert.equal(s.delivery.changesSummary.byChange.added+s.delivery.changesSummary.byChange.modified,300);
  assert.equal(s.delivery.changesSummary.sample.length,20);assert.deepEqual(s.delivery.changesSummary.sample[0],{path:'report.docx',change:'added'});
  for(const key of ['outcome','assessment','deliverables','verification','unfinished','changeExplanation','warnings','approvals','report'])assert.ok(key in s.delivery,key);
  assert.ok(fs.existsSync(s.delivery.detailFile));assert.ok(fs.existsSync(s.stateFile));
  assert.deepEqual(s.executionSummary.deliverables.map(d=>d.id),JSON.parse(before).plan.contract.deliverables.map(d=>d.id));
  assert.equal(s.plan.contract,undefined);assert.ok(s.plan.contractHash);
  assert.equal(s.reviewHistory.count,12);assert.equal(s.questionHistory.count,10);assert.equal(s.runHistory.count,20);assert.equal(s.runHistory.recent.length,3);
  assert.equal(s.threadId,JSON.parse(before).threadId);assert.equal(s.phase,'needs-code-review');
  assert.deepEqual(fs.readFileSync(file),before,'state.json must not change');
});
test('--full prints the untouched status',async t=>{
  const p=kit(t);await p.approved();await p.call({action:'implement'});inflate(p);
  const s=JSON.parse(await status(p,'--full'));
  assert.equal(s.delivery.changes.length,300);assert.equal(s.executionSummary.delivery.changes.length,300);
  assert.equal(s.reviewHistory.length,12);assert.equal(s.questionHistory.length,10);assert.ok(s.plan.contract.deliverables.length>0);
});
test('pending questions, review rounds and approvals are never shortened',async t=>{
  const long='很长的问题'.repeat(60),questions=[{id:'a',header:'范围',question:long,multiSelect:false,options:[{label:'甲',description:'说明'.repeat(200)},{label:'乙',description:'说明'}]}];
  const p=kit(t);const s=await p.plan({answer:JSON.stringify({status:'needs_questions',plan:'草稿',questions,contract:null})});
  assert.deepEqual(s.pendingQuestions.questions,questions);
  const q=kit(t);await q.approved();const a=await q.call({action:'implement'},{steps:[command({command:'echo '+'x'.repeat(3000)})]});
  assert.equal(a.runState,'awaiting-approval');assert.match(a.approval.text,/x{3000}/);assert.ok(a.approveCommand);
  await q.argv(['decline-codex',a.approval.id,SESSION]);
  const r=kit(t);await r.plan();const start=await r.call({action:'review-start',kind:'plan'});
  const asked=await r.call({action:'review-questions',kind:'plan',ticket:start.ticket,questions,text:'笔记'.repeat(500)});
  assert.deepEqual(asked.reviewSession.rounds[0].questions,questions);assert.equal(asked.reviewSession.notes,'笔记'.repeat(500));
});
test('a saved review draft is reported without repeating its text',async t=>{
  const {compactView}=await import('../.claude/scripts/output-view.mjs');
  const s=compactView({paths:{task:'x'},reviewSession:{ticket:'t',rounds:[],draft:{text:'报告'.repeat(5000),model:null}}});
  assert.deepEqual(s.reviewSession.draft,{saved:true,characters:10000,model:null});
});
test('planning results point to their file; long reports are cut with a path',async t=>{
  const p=kit(t);const s=await p.plan();
  assert.equal(s.result,undefined);assert.ok(fs.existsSync(s.resultFile));assert.ok(fs.existsSync(s.paths.plan));
  const {compactView}=await import('../.claude/scripts/output-view.mjs');
  const base={paths:{task:'x'},lastRun:{action:'resume',result:'r.md'}};
  assert.equal(compactView({...base,result:'短'}).result,'短');
  const cut=compactView({...base,result:'长'.repeat(7000)});
  assert.ok(cut.result.length<6200);assert.match(cut.result,/未显示/);assert.equal(cut.resultFile,'r.md');
});
test('notices come first so a shortened reading still shows them',async t=>{
  const p=kit(t,{mode:null});const r=await p.raw({action:'new',task:'demo',text:'需求'});
  assert.deepEqual(Object.keys(JSON.parse(r.out)).slice(0,2),['runState','permissionNotice']);
  const {compactView}=await import('../.claude/scripts/output-view.mjs');
  assert.deepEqual(Object.keys(compactView({phase:'x',archiveWarnings:['w'],warnings:['v'],runState:'completed'})).slice(0,3),['runState','warnings','archiveWarnings']);
  assert.equal(compactView(null),null);assert.deepEqual(compactView({tasks:[{task:'a'}]}),{tasks:[{task:'a'}]});
});
