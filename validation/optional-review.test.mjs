// Skipping a recommended review: the reviewed flow keeps every gate, the unreviewed flow needs an explicit flag.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execute} from '../.claude/scripts/chatgpt-workflow.mjs';
import {kit} from './kit-fixture.mjs';

const UUID='12345678-1234-4234-8234-123456789abc';
const contract={kind:'modify',deliverables:[{id:'D1',description:'修复登录并验证'}],allowedChanges:['登录代码和测试'],excludedChanges:['部署'],acceptanceCriteria:['错误密码被拒绝']};
const wider={...contract,allowedChanges:['整个产品']};
const ready=(goal=contract)=>({status:'ready',plan:'## 执行步骤\n检查目标文件并完成验收。',questions:[],contract:goal});
const asking={status:'needs_questions',plan:'草稿',questions:[{id:'q1',header:'范围',question:'范围是什么？',multiSelect:false,options:[{label:'甲',description:'甲说明'},{label:'乙',description:'乙说明'}]}],contract:null};
const done={outcome:'partial',deliverables:[{id:'D1',status:'completed',summary:'已修改',evidence:['app.txt']}],verification:[{description:'登录检查',status:'passed',evidence:['记录']}],unfinished:['遗留项-锁定策略'],changeExplanation:'修改了登录',report:'# 结果\n已修改。'};
function fixture(t){
 const root=fs.mkdtempSync(path.join(process.env.CHATGPT_TEST_TMP||os.tmpdir(),'optional-kit-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.writeFileSync(path.join(root,'app.txt'),'base');
 const capture=path.join(root,'.chatgpt-workflow/calls.jsonl');
 const options={command:[process.execPath,fileURLToPath(new URL('./fake-codex.mjs',import.meta.url))],env:{CHATGPT_KIT_TRANSPORT:'exec',FAKE_CAPTURE:capture}};
 const run=(request,response,env={})=>execute(root,{sessionId:'optional-session',...request},{...options,env:{...options.env,...(response===undefined?{}:{FAKE_RAW_RESPONSE:JSON.stringify(response)}),...env}});
 const calls=()=>fs.readFileSync(capture,'utf8').trim().split('\n').map(JSON.parse);
 const stateFile=path.join(root,'.chatgpt-workflow/tasks/task/state.json');
 const gate=async()=>(await run({action:'status'})).executionSummary;
 const skip=()=>run({action:'approve',withoutReview:true});
 const write=async(action,value)=>run({action,...(action==='fix'?{text:'R1'}:{})},done,{FAKE_WRITE_APP:value});
 const planned=(goal=contract)=>run({action:'new',task:'task',text:'明确交付目标'},ready(goal));
 const review=async(kind='plan',text='R1 修复范围内问题。')=>{const r=await run({action:'review-start',kind});return run({action:'review-save',kind,ticket:r.ticket,text});};
 return {root,run,calls,stateFile,gate,skip,write,planned,review,state:()=>JSON.parse(fs.readFileSync(stateFile)),save:s=>fs.writeFileSync(stateFile,JSON.stringify(s))};
}
const app=p=>fs.readFileSync(path.join(p.root,'app.txt'),'utf8');

test('a new plan can be implemented without review only through the explicit choice',async t=>{
 const p=fixture(t);await p.planned();
 assert.equal((await p.gate()).planReview,'none');
 await assert.rejects(p.run({action:'implement'},done),/approval/);
 await assert.rejects(p.run({action:'approve'}),/needs an Claude review/);
 await assert.rejects(p.run({action:'approve',withoutReview:'yes'}),/withoutReview/);
 const approved=await p.skip();assert.equal(approved.approved.withoutReview,'none');assert.equal(approved.phase,'approved');
 const s=await p.write('implement','changed');
 assert.equal(app(p),'changed');assert.equal(s.delivery.planReview,'skipped');assert.equal(s.phase,'needs-code-review');assert.equal(s.threadId,UUID);
});
test('plans after questions, after /chatgpt-plan and after a revision that changed the goal can all skip review',async t=>{
 const p=fixture(t);const asked=await p.run({action:'new',task:'task',text:'需求'},asking);
 assert.equal((await p.gate()).planReview,'unavailable');
 await assert.rejects(p.skip(),/questions/i);
 await p.run({action:'answer',roundId:asked.pendingQuestions.id,answers:[{id:'q1',answer:'甲'}]},ready());
 assert.equal((await p.gate()).planReview,'none');await p.skip();
 await p.run({action:'plan',text:'补充'},ready());
 assert.equal(p.state().approved,null);assert.equal((await p.gate()).planReview,'none');
 await p.review();await p.run({action:'revise-plan'},ready(wider));
 assert.equal((await p.gate()).planReview,'none');await assert.rejects(p.run({action:'approve'}),/needs an Claude review/);
 await p.skip();await p.write('implement','changed');assert.equal(app(p),'changed');
});
test('the reviewed flow is unchanged and never becomes skippable',async t=>{
 const p=fixture(t);await p.planned();await p.review();
 assert.equal((await p.gate()).planReview,'current');await assert.rejects(p.skip(),/已有评审/);
 await p.run({action:'revise-plan'},ready());
 assert.equal((await p.gate()).planReview,'current');await assert.rejects(p.skip(),/已有评审/);
 const a=await p.run({action:'approve'});assert.equal('withoutReview' in a.approved,false);
 const s=await p.write('implement','changed');assert.equal('planReview' in s.delivery,false);
 assert.equal((await p.gate()).planReview,'current');
 await assert.rejects(p.run({action:'approve'}),/stale/);await assert.rejects(p.skip(),/已有评审|已执行/);
});
test('a review that went stale may be skipped explicitly; a tampered or unfinished one may not',async t=>{
 const p=fixture(t);await p.planned();await p.review();
 fs.writeFileSync(path.join(p.root,'app.txt'),'edited by user');
 const gate=await p.gate();assert.equal(gate.planReview,'stale');assert.match(gate.planReviewNote,/app\.txt/);
 await assert.rejects(p.run({action:'approve'}),/stale/);
 assert.equal((await p.skip()).approved.withoutReview,'stale');
 await p.write('implement','changed');assert.equal(app(p),'changed');
 const q=fixture(t);await q.planned();await q.review();
 fs.appendFileSync(q.state().reviews.plan.file,'tampered');
 assert.equal((await q.gate()).planReview,'unavailable');await assert.rejects(q.skip(),/modified/);
 const r=fixture(t);await r.planned();await r.run({action:'review-start',kind:'plan'});
 assert.equal((await r.gate()).planReview,'in-progress');await assert.rejects(r.skip(),/unfinished/i);
});
test('a stale revision-guided review may also be skipped explicitly',async t=>{
 const p=fixture(t);await p.planned();await p.review();await p.run({action:'revise-plan'},ready());
 fs.writeFileSync(path.join(p.root,'app.txt'),'edited by user');
 assert.equal((await p.gate()).planReview,'stale');await assert.rejects(p.run({action:'approve'}),/stale/);
 await p.skip();await p.write('implement','changed');assert.equal(app(p),'changed');
});
test('plans that cannot be approved stay blocked even with the explicit choice',async t=>{
 const p=fixture(t);await p.planned();
 fs.appendFileSync(path.join(path.dirname(p.stateFile),'plan.md'),'\nedited');
 assert.equal((await p.gate()).planReview,'unavailable');await assert.rejects(p.skip(),/outside the workflow/);
 const q=fixture(t);await q.planned();await assert.rejects(q.run({action:'plan',text:'x'},undefined,{FAKE_FAIL:'1'}),/failed/);
 assert.equal((await q.gate()).planReview,'unavailable');await assert.rejects(q.skip(),/incomplete/);
 const r=fixture(t);await r.planned();const s=r.state();delete s.plan.contract;delete s.plan.contractHash;r.save(s);
 assert.equal((await r.gate()).planReview,'unavailable');await assert.rejects(r.skip(),/目标|chatgpt-plan/);
});
test('reviewing after a skipped approval returns to the reviewed flow',async t=>{
 const p=fixture(t);await p.planned();await p.skip();
 await p.run({action:'review-start',kind:'plan'});await assert.rejects(p.run({action:'implement'},done),/unfinished/i);
 const ticket=p.state().reviewSession.ticket;await p.run({action:'review-save',kind:'plan',ticket,text:'通过'});
 assert.equal(p.state().approved,null);await assert.rejects(p.run({action:'implement'},done),/approval/);
 await p.run({action:'approve'});const s=await p.write('implement','changed');assert.equal('planReview' in s.delivery,false);
});
test('an unreviewed plan that already changed files is not executed twice; a clean failure may be retried',async t=>{
 const p=fixture(t);await p.planned();await p.skip();
 await assert.rejects(p.run({action:'implement'},undefined,{FAKE_FAIL:'1'}),/failed/);
 assert.equal((await p.gate()).planReview,'none');await p.skip();await p.write('implement','changed');
 const n=p.calls().length;assert.equal((await p.gate()).planReview,'unavailable');
 await assert.rejects(p.skip(),/已执行/);await assert.rejects(p.run({action:'implement'},done),/已执行/);
 await p.review('code');await p.run({action:'fix',text:'R1'},done);
 assert.equal(p.state().delivery.changesDetected,false);await assert.rejects(p.skip(),/已执行/);assert.equal(p.calls().length,n+1);
 const q=fixture(t);await q.planned();await q.skip();
 await assert.rejects(q.run({action:'implement'},undefined,{FAKE_WRITE_APP:'half',FAKE_FAIL_AFTER_WRITE:'1'}),/failed/);
 await assert.rejects(q.skip(),/已执行/);
});
test('result review, fix and re-review work after an unreviewed implementation',async t=>{
 const p=fixture(t);await p.planned();await p.skip();await p.write('implement','one');
 assert.equal((await p.gate()).resultReview,'none');
 await p.review('code');assert.equal((await p.gate()).resultReview,'current');
 const s=await p.write('fix','two');assert.equal(s.delivery.planReview,'skipped');assert.equal((await p.gate()).resultReview,'none');
 await p.review('code');assert.equal(p.state().phase,'reviewed-code');
});
test('planning after an unreviewed fix keeps the task and carries what nobody verified',async t=>{
 const p=fixture(t);await p.planned();await p.review();await p.run({action:'approve'});await p.write('implement','one');
 await p.review('code','R7 表格合计不对');await p.write('fix','two');
 assert.equal((await p.gate()).resultReview,'none');
 await assert.rejects(p.run({action:'plan',text:'新增需求'},undefined,{FAKE_FAIL:'1'}),/failed/);
 assert.equal((await p.gate()).resultReview,'unavailable');
 const s=await p.run({action:'plan',text:'新增需求'},ready());
 const prompt=p.calls().at(-1).text;
 assert.match(prompt,/R7 表格合计不对/);assert.match(prompt,/遗留项-锁定策略/);assert.match(prompt,/NOT been independently reviewed/);
 assert.match(s.reviewNotice,/未评审/);assert.equal(s.threadId,UUID);assert.equal(s.task,'task');
 await p.skip();await p.write('implement','three');assert.equal(app(p),'three');assert.equal(p.state().threadId,UUID);
});
test('planning after a reviewed result sends exactly the usual prompt',async t=>{
 const p=fixture(t);await p.planned();await p.review();await p.run({action:'approve'});await p.write('implement','one');
 await p.review('code','R7 表格合计不对');await p.write('fix','two');await p.review('code','R8 已核对');
 assert.equal((await p.gate()).resultReview,'current');
 const s=await p.run({action:'plan',text:'新增需求'},ready());
 assert.doesNotMatch(p.calls().at(-1).text,/independently reviewed\.|R7|R8|遗留项/);assert.equal(s.reviewNotice,undefined);
});
test('a failed run without changes needs no result review',async t=>{
 const p=fixture(t);await p.planned();assert.equal((await p.gate()).resultReview,'unavailable');await p.skip();
 await assert.rejects(p.run({action:'implement'},undefined,{FAKE_FAIL:'1'}),/failed/);
 assert.equal((await p.gate()).resultReview,'unavailable');
 const s=await p.run({action:'plan',text:'换方案'},ready());assert.equal(s.reviewNotice,undefined);
});
test('tasks saved before this version report their review state',async t=>{
 const p=fixture(t);await p.planned();await p.review();await p.run({action:'approve'});await p.write('implement','one');await p.review('code');
 const s=p.state();delete s.runHistory;p.save(s);
 assert.equal((await p.gate()).resultReview,'current');assert.equal((await p.gate()).planReview,'current');
});
test('the runner process prints the review state and puts the notice first',async t=>{
 const p=kit(t);await p.plan();
 assert.equal((await p.call({action:'status'})).executionSummary.planReview,'none');
 await p.call({action:'approve',withoutReview:true});await p.call({action:'implement'});
 assert.equal((await p.call({action:'status'})).executionSummary.resultReview,'none');
 const s=await p.call({action:'plan',text:'继续'});
 assert.match(s.reviewNotice,/未评审/);assert.ok(Object.keys(s).indexOf('reviewNotice')<Object.keys(s).indexOf('schema'));
});
test('skills ask with a card, never treat silence as a choice and stop after a chosen review',()=>{
 const doc=f=>fs.readFileSync(fileURLToPath(new URL('../.claude/skills/'+f,import.meta.url)),'utf8');
 const flow=doc('chatgpt/references/workflow.md');
 for(const text of ['评审选择卡片','先评审计划（推荐）','跳过评审，直接实现','先评审成果（推荐）','跳过评审，继续规划','超时都不算选择','然后停下','模型不得自行决定','不沿用以前命令中的选择'])assert.ok(flow.includes(text),text);
 assert.match(doc('chatgpt-implement/SKILL.md'),/planReview[^]*评审选择卡片/);assert.match(doc('chatgpt-plan/SKILL.md'),/resultReview[^]*调用 `plan` 之前/);
 for(const name of ['planReview','resultReview','withoutReview','reviewNotice'])assert.ok(doc('chatgpt/references/runner.md').includes(name),name);
});
