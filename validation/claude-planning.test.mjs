// Claude writes the plan, Codex reviews it, Claude revises it; implementation and result review stay as they were.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execute} from '../.claude/scripts/chatgpt-workflow.mjs';
import {kit,SESSION} from './kit-fixture.mjs';

const UUID='12345678-1234-4234-8234-123456789abc',REQUEST='0b7c1e2a-1111-4111-8111-111111111111';
const contract={kind:'modify',deliverables:[{id:'D1',description:'登录页拒绝错误密码'}],allowedChanges:['登录代码和测试'],excludedChanges:['部署'],acceptanceCriteria:['错误密码被拒绝']};
const wider={...contract,allowedChanges:['整个产品']};
const PLAN='## 执行步骤\n检查登录代码，修改校验并补测试。';
const question={id:'q1',header:'范围',question:'是否包含锁定策略？',multiSelect:false,options:[{label:'包含',description:'一并实现'},{label:'不包含',description:'只修校验'}]};
const review=(verdict='revise')=>({verdict,summary:'计划基本可行。',findings:verdict==='approve'?[]:[{id:'F1',severity:'major',section:'执行步骤',problem:'缺少回归测试说明',suggestion:'补充测试范围'}],openQuestions:[],report:'## 评审\n缺少回归测试说明。'});
const done={outcome:'completed',deliverables:[{id:'D1',status:'completed',summary:'已修改',evidence:['app.txt']}],verification:[{description:'登录检查',status:'passed',evidence:['记录']}],unfinished:[],changeExplanation:'修改校验',report:'# 完成'};

function fixture(t){
  const root=fs.mkdtempSync(path.join(process.env.CHATGPT_TEST_TMP||os.tmpdir(),'claude-plan-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,'app.txt'),'base');
  const capture=path.join(root,'.chatgpt-workflow/calls.jsonl');
  const options={command:[process.execPath,fileURLToPath(new URL('./fake-codex.mjs',import.meta.url))],env:{CHATGPT_KIT_TRANSPORT:'exec',FAKE_CAPTURE:capture}};
  const run=(request,response,env={})=>execute(root,{sessionId:'claude-plan-session',...request},{...options,env:{...options.env,...(response===undefined?{}:{FAKE_RAW_RESPONSE:JSON.stringify(response)}),...env}});
  const calls=()=>fs.existsSync(capture)?fs.readFileSync(capture,'utf8').trim().split('\n').map(JSON.parse):[];
  const create=()=>run({action:'new',planner:'claude',requestId:REQUEST,suggestedTask:'login-fix',text:'修复登录错误密码校验'});
  const save=(ticket,goal=contract,plan=PLAN)=>run({action:'plan-save',ticket,plan,contract:goal,model:'claude-opus'});
  const planned=async()=>{const c=await create();return save(c.ticket);};
  const gate=async()=>(await run({action:'status'})).executionSummary;
  return {root,run,calls,create,save,planned,gate,state:s=>JSON.parse(fs.readFileSync(path.join(s.paths.task,'state.json'),'utf8'))};
}

test('/claude-new creates and binds a task without calling Codex, and a replay returns the same task',async t=>{
  const p=fixture(t);const c=await p.create();
  assert.equal(c.task,'login-fix');assert.equal(c.planner,'claude');assert.equal(c.phase,'claude-planning');
  assert.equal(c.resumeOwner,'claude-plan');assert.ok(c.ticket);assert.equal(c.threadId,null);
  assert.equal(p.calls().length,0,'no Codex process');
  const again=await p.create();assert.equal(again.creationReplay,true);assert.equal(again.task,'login-fix');assert.equal(again.authoring.ticket,c.ticket);
  const resumed=await p.run({action:'resume'});assert.equal(resumed.resumeOwner,'claude-plan');assert.equal(p.calls().length,0);
  await assert.rejects(p.run({action:'new',planner:'codex',requestId:'0b7c1e2a-2222-4222-8222-222222222222',text:'x'}),/planner/);
});

test('Claude planning questions must be answered, contracts are validated and the saved draft can be retried',async t=>{
  const p=fixture(t);const c=await p.create();
  await assert.rejects(p.run({action:'plan-questions',ticket:'stale',questions:[question]}),/票据/);
  const asked=await p.run({action:'plan-questions',ticket:c.ticket,questions:[question]});
  const roundId=asked.authoring.pendingRoundId;
  await assert.rejects(p.save(c.ticket),/Answer all Claude planning questions/);
  await assert.rejects(p.run({action:'plan-record-answers',ticket:c.ticket,roundId,answers:[{id:'nope',answer:'x'}]}),/Planning answers require unique/);
  await p.run({action:'plan-record-answers',ticket:c.ticket,roundId,answers:[{id:'q1',answer:'不包含'}]});
  await assert.rejects(p.save(c.ticket,{...contract,kind:'whatever'}),/Invalid planning response/);
  await assert.rejects(p.run({action:'plan-save',ticket:c.ticket}),/No saved plan draft/);
  const saved=await p.save(c.ticket);
  assert.equal(saved.planSaved,true);assert.equal(saved.phase,'planned');assert.equal(saved.plan.author,'claude');assert.equal(saved.plan.model,'claude-opus');
  assert.ok(!saved.authoring);assert.equal(saved.revision,1);
  const s=p.state(saved);
  assert.equal(s.questionHistory[0].askedBy,'claude');assert.deepEqual(s.questionHistory[0].answers,[{id:'q1',answer:'不包含'}]);
  assert.match(fs.readFileSync(saved.paths.questions,'utf8'),/提问方：Claude 规划/);
  assert.match(fs.readFileSync(saved.paths.plan,'utf8'),/检查登录代码/);
  // A completed save can be retried; different text cannot.
  assert.equal((await p.save(c.ticket)).planSaved,true);
  await assert.rejects(p.save(c.ticket,contract,'别的计划'),/重试内容不同/);
  const summary=await p.gate();
  assert.equal(summary.planAuthor,'claude');assert.equal(summary.planReview,'none');assert.equal(summary.recommendedPlanReview,'/chatgpt-review-plan');
  assert.equal(p.calls().length,0);
});

test('an interrupted save is retried from the saved draft without resending the plan',async t=>{
  const p=fixture(t);const c=await p.create();
  const file=path.join(c.paths.task,'state.json'),s=JSON.parse(fs.readFileSync(file,'utf8'));
  s.authoring.draft={plan:PLAN,contract,model:null};fs.writeFileSync(file,JSON.stringify(s));
  const saved=await p.run({action:'plan-save',ticket:c.ticket});
  assert.equal(saved.plan.author,'claude');assert.match(fs.readFileSync(saved.paths.plan,'utf8'),/检查登录代码/);
});

test('ChatGPT reviews the Claude plan read-only in a new Codex conversation; approval and implementation follow the normal gates',async t=>{
  const p=fixture(t);await p.planned();
  await assert.rejects(p.run({action:'codex-review-plan'},{verdict:'maybe'}),/Invalid plan review response/);
  assert.equal(p.state(await p.run({action:'status'})).reviews.plan,undefined,'an invalid review is not saved');
  const reviewed=await p.run({action:'codex-review-plan',text:'关注测试'},review());
  assert.ok(!p.calls()[0].args.includes('resume'),'the first Codex call of the task starts its conversation');
  const call=p.calls().at(-1);
  assert.ok(call.args.includes('read-only'));assert.ok(call.args.includes('resume'),'later calls continue it');
  assert.match(call.text,/Review the saved plan read-only/);assert.match(call.text,/written by Claude/);assert.match(call.text,/修复登录错误密码校验/);assert.match(call.text,/关注测试/);
  assert.equal(reviewed.phase,'reviewed-plan');assert.equal(reviewed.threadId,UUID);
  assert.equal(reviewed.codexPlanReview.verdict,'revise');assert.equal(reviewed.codexPlanReview.findings,1);
  assert.equal(reviewed.reviews.plan.reviewer,'codex');
  assert.match(fs.readFileSync(reviewed.codexPlanReview.file,'utf8'),/F1（重要）/);
  assert.equal((await p.gate()).planReview,'current');assert.equal((await p.gate()).planReviewer,'codex');
  const approved=await p.run({action:'approve'});assert.equal(approved.phase,'approved');assert.equal(approved.approved.withoutReview,undefined);
  const implemented=await p.run({action:'implement'},done,{FAKE_WRITE_APP:'changed'});
  assert.equal(implemented.phase,'needs-code-review');
  const last=p.calls().at(-1);assert.ok(last.args.includes('resume')&&last.args.includes(UUID),'implementation continues the review conversation');
  assert.ok(last.args.includes('workspace-write'));
});

test('a Claude plan can be implemented straight away; the first Codex turn starts a conversation with the original requirements',async t=>{
  const p=fixture(t);await p.planned();
  await assert.rejects(p.run({action:'approve'}),/needs an Claude review/);
  await p.run({action:'approve',withoutReview:true});
  const s=await p.run({action:'implement'},done,{FAKE_WRITE_APP:'changed'});
  assert.equal(s.delivery.planReview,'skipped');assert.equal(s.threadId,UUID);
  const call=p.calls().at(-1);assert.ok(!call.args.includes('resume'));assert.match(call.text,/Original user requirements:\n修复登录错误密码校验/);
});

test('Claude revision keeps the ChatGPT review only while the delivery goal is unchanged',async t=>{
  const p=fixture(t);await p.planned();
  await assert.rejects(p.run({action:'plan-start',kind:'revise'}),/current plan review is required/);
  await p.run({action:'codex-review-plan'},review());
  const start=await p.run({action:'plan-start',kind:'revise',text:'补测试'});
  assert.ok(start.sourceReviewFile.endsWith('.plan-review.md'));assert.equal(start.authoring.kind,'revise');assert.equal(start.authoring.focus,'补测试');
  assert.equal((await p.run({action:'plan-start',kind:'revise'})).ticket,start.ticket,'the unfinished revision is reused');
  await assert.rejects(p.run({action:'approve'}),/未完成的 Claude 规划/);
  const kept=await p.save(start.ticket,contract,PLAN+'\n补充回归测试。');
  assert.equal(kept.reviewCarriedOver,true);assert.equal(kept.revision,2);assert.equal((await p.gate()).planReview,'current');
  assert.equal((await p.run({action:'approve'})).phase,'approved');
  await p.run({action:'codex-review-plan'},review());
  const again=await p.run({action:'plan-start',kind:'revise'});
  const changed=await p.save(again.ticket,wider);
  assert.equal(changed.reviewCarriedOver,undefined);assert.equal(changed.approved,null);
  await assert.rejects(p.run({action:'approve'}),/needs an Claude review/);
  assert.equal((await p.gate()).planReview,'none');
});

test('Claude planning, Claude review and Codex planning never run over each other',async t=>{
  const p=fixture(t);await p.planned();
  const r=await p.run({action:'review-start',kind:'plan'});
  await assert.rejects(p.run({action:'plan-start',kind:'plan'}),/unfinished Claude review/);
  await assert.rejects(p.run({action:'codex-review-plan'},review()),/unfinished Claude review/);
  await p.run({action:'review-save',kind:'plan',ticket:r.ticket,text:'通过'});
  const start=await p.run({action:'plan-start',kind:'plan',text:'加日志'});
  await assert.rejects(p.run({action:'review-start',kind:'plan'}),/未完成的 Claude 规划/);
  await assert.rejects(p.run({action:'codex-review-plan'},review()),/未完成的 Claude 规划/);
  // A plan from elsewhere makes the ticket stale.
  const planned=await p.run({action:'plan',text:'换由 Codex 规划'},{status:'ready',plan:'# Codex 计划',questions:[],contract});
  assert.ok(!planned.authoring);assert.equal(planned.plan.author,undefined,'Codex plans keep the original shape');
  const s=p.state(planned);assert.equal(s.authoringHistory.at(-1).outcome,'superseded-planning');
  await assert.rejects(p.save(start.ticket),/票据已失效/);
  assert.equal((await p.gate()).recommendedPlanReview,'/claude-review-plan');
});

test('a plan changed behind an open Claude planning (for example by an older runner) makes its ticket stale',async t=>{
  const p=fixture(t);await p.planned();
  const start=await p.run({action:'plan-start',kind:'plan'});
  const file=path.join(start.paths.task,'state.json'),s=JSON.parse(fs.readFileSync(file,'utf8'));
  s.revision++;fs.writeFileSync(file,JSON.stringify(s));
  assert.equal((await p.run({action:'resume'})).authoring.stale,true);
  await assert.rejects(p.save(start.ticket),/计划已被其他操作改变/);
  const fresh=await p.run({action:'plan-start',kind:'plan'});
  assert.notEqual(fresh.ticket,start.ticket);assert.equal(p.state(fresh).authoringHistory.at(-1).outcome,'superseded-source-changed');
});

test('abandoning a Claude planning leaves the earlier plan and its review usable',async t=>{
  const p=fixture(t);await p.planned();await p.run({action:'codex-review-plan'},review('approve'));
  const start=await p.run({action:'plan-start',kind:'plan'});
  assert.equal((await p.gate()).planReview,'in-progress');
  await assert.rejects(p.run({action:'plan-cancel',ticket:'other'}),/没有匹配/);
  const back=await p.run({action:'plan-cancel',ticket:start.ticket});
  assert.equal(back.phase,'reviewed-plan');assert.ok(!back.authoring);
  assert.equal((await p.run({action:'approve'})).phase,'approved');
});

test('the review choice for a Claude plan after a result points at the unreviewed result like Codex planning does',async t=>{
  const p=fixture(t);await p.planned();await p.run({action:'approve',withoutReview:true});
  await p.run({action:'implement'},done,{FAKE_WRITE_APP:'changed'});
  const start=await p.run({action:'plan-start',kind:'plan'});
  assert.match(start.reviewNotice,/上次执行的成果未评审/);
  const saved=await p.save(start.ticket,wider);
  assert.equal(p.state(saved).delivery.reviewAtPlanning,'none');
});

test('existing Codex-planned tasks are unchanged: Claude planning is opt-in per task',async t=>{
  const p=fixture(t);
  const c=await p.run({action:'new',task:'codex-task',text:'需求'},{status:'ready',plan:'# Plan',questions:[],contract});
  assert.equal(c.planner,undefined);assert.equal(c.plan.author,undefined);
  const summary=await p.gate();assert.equal(summary.planner,'codex');assert.equal(summary.planAuthor,'codex');assert.equal(summary.recommendedPlanReview,'/claude-review-plan');
  // Codex may review a Codex plan too; the resumed conversation is reused.
  const reviewed=await p.run({action:'codex-review-plan'},review('approve'));
  assert.ok(p.calls().at(-1).args.includes('resume'));assert.equal(reviewed.reviews.plan.reviewer,'codex');
  const revised=await p.run({action:'revise-plan'},{status:'ready',plan:'# Plan 2',questions:[],contract});
  assert.match(p.calls().at(-1).text,/Codex plan review:/);assert.equal(revised.revisionReview.reviewer,'codex');
});

test('the permission hook runs the new internal planning actions without a prompt',async t=>{
  const k=kit(t),inbox=path.join(k.root,'.chatgpt-workflow','inbox');fs.mkdirSync(inbox,{recursive:true});
  for(const action of ['plan-start','plan-questions','plan-record-answers','plan-save','plan-cancel','codex-review-plan']){
    const file=path.join(inbox,`request-${action}.json`);fs.writeFileSync(file,JSON.stringify({action,sessionId:SESSION}));
    assert.equal((await k.hook({command:`node "${k.runner}" --request-file "${file}"`})).permissionDecision,'allow',action);
  }
});

test('through the real runner process: Claude planning runs inline and the Codex review uses the app-server worker',async t=>{
  const k=kit(t);
  const c=await k.call({action:'new',planner:'claude',requestId:REQUEST,suggestedTask:'demo',text:'实现功能'});
  assert.equal(c.resumeOwner,'claude-plan');assert.ok(!k.captured().length,'no Codex process for Claude planning');
  await k.call({action:'plan-save',ticket:c.ticket,plan:PLAN,contract});
  const r=await k.call({action:'codex-review-plan'});
  assert.equal(r.runState,'completed');assert.equal(r.codexPlanReview.verdict,'approve');
  const starts=k.captured().filter(m=>m.kind==='request'&&m.method==='thread/start');
  assert.equal(starts.length,1);assert.equal(starts[0].params.sandbox,'read-only');
  assert.ok(k.captured().some(m=>m.method==='turn/start'&&m.params.outputSchema?.properties?.findings));
  const status=await k.call({action:'status'});assert.equal(status.executionSummary.planReview,'current');
});
