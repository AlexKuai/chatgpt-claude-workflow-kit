import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {execute} from '../.claude/scripts/chatgpt-workflow.mjs';

const contract={kind:'modify',deliverables:[{id:'D1',description:'修复登录并验证'}],allowedChanges:['登录代码和测试'],excludedChanges:['部署'],acceptanceCriteria:['正确密码可登录，错误密码被拒绝']};
const result={outcome:'completed',deliverables:[{id:'D1',status:'completed',summary:'已有实现满足要求',evidence:['app.txt 检查记录']}],verification:[{description:'登录行为检查',status:'passed',evidence:['实际检查记录']}],unfinished:[],changeExplanation:'原有实现满足需求，无需重复修改',report:'# 结果\n已检查现有实现。'};
function fixture(t){
 const root=fs.mkdtempSync(path.join(process.env.CHATGPT_TEST_TMP||os.tmpdir(),'goal-kit-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const capture=path.join(root,'.chatgpt-workflow/calls.jsonl');
 const options={command:[process.execPath,fileURLToPath(new URL('./fake-codex.mjs',import.meta.url))],env:{CHATGPT_KIT_TRANSPORT:'exec',FAKE_CAPTURE:capture}};
 const run=(request,response,env={})=>execute(root,{sessionId:'goal-session',...request},{...options,env:{...options.env,...(response===undefined?{}:{FAKE_RAW_RESPONSE:typeof response==='string'?response:JSON.stringify(response)}),...env}});
 const git=(...args)=>{const r=spawnSync('git',args,{cwd:root,encoding:'utf8'});assert.equal(r.status,0,r.stderr||r.stdout||String(r.error||r.signal));};
 git('init','-q');fs.writeFileSync(path.join(root,'.gitignore'),'calls.jsonl\n');fs.writeFileSync(path.join(root,'app.txt'),'base');git('add','.');git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','base');
 const calls=()=>fs.existsSync(capture)?fs.readFileSync(capture,'utf8').trim().split('\n').map(JSON.parse):[];
 const stateFile=path.join(root,'.chatgpt-workflow/tasks/task/state.json');
 return {root,run,calls,stateFile,saveState:s=>fs.writeFileSync(stateFile,JSON.stringify(s))};
}
const ready=(goal=contract)=>({status:'ready',plan:'## 执行步骤\n检查目标文件并完成验收。',questions:[],contract:goal});
async function review(p,kind='plan'){const r=await p.run({action:'review-start',kind});return p.run({action:'review-save',kind,ticket:r.ticket,text:'检查范围与验收；R1 修复范围内问题。'});}
async function prepared(p,goal=contract){await p.run({action:'new',task:'task',text:'明确交付目标'},ready(goal));await review(p);return p.run({action:'approve'});}

test('ready plan persists a generated goal summary and rejects missing or contradictory goal data',async t=>{
 const p=fixture(t);const s=await p.run({action:'new',task:'task',text:'修复登录'},ready());
 assert.deepEqual(s.plan.contract,contract);assert.match(fs.readFileSync(s.paths.plan,'utf8'),/交付目标[\s\S]*修复登录并验证/);
 assert.equal(s.executionSummary.kind,'modify');assert.ok(s.plan.contractHash);
 for(const goal of [null,{...contract,deliverables:[]},{...contract,deliverables:[...contract.deliverables,...contract.deliverables]},{...contract,kind:'unknown'}]){
  await assert.rejects(p.run({action:'plan',text:'明确目标'},ready(goal)),/contract|目标|deliverable/i);
 }
});

test('goal changes invalidate approvals and review-guided revisions cannot silently inherit widened scope',async t=>{
 const p=fixture(t);await prepared(p);
 const s=await p.run({action:'revise-plan'},ready({...contract,allowedChanges:['整个产品']}));
 assert.equal(s.reviewedRevision,null);assert.equal(s.approved,null);
 await assert.rejects(p.run({action:'approve'}),/review/i);
 await assert.rejects(p.run({action:'implement'},result),/approv/i);
});

test('editing only structured goal invalidates version, even if plan text is unchanged',async t=>{
 const p=fixture(t);await prepared(p);const s=JSON.parse(fs.readFileSync(p.stateFile));
 s.plan.contract={...contract,allowedChanges:['所有文件']};p.saveState(s);
 await assert.rejects(p.run({action:'implement'},result),/目标|contract|changed/i);
});

test('modify task without changes retains evidence, warns and does not claim verified completion',async t=>{
 const p=fixture(t);await prepared(p);const s=await p.run({action:'implement'},result);
 assert.equal(s.lastRun.status,'completed');assert.equal(s.delivery.outcome,'completed');assert.equal(s.delivery.assessment,'needs-review');
 assert.equal(s.delivery.changesDetected,false);assert.match(s.delivery.warnings.join(' '),/未检测到/);
 assert.ok(fs.existsSync(s.delivery.beforeSnapshot));assert.ok(fs.existsSync(s.delivery.afterSnapshot));
 assert.equal(fs.readFileSync(s.lastRun.result,'utf8'),result.report);
 assert.deepEqual(JSON.parse(fs.readFileSync(s.delivery.structuredResult)),result);
 const call=p.calls().at(-1);assert.ok(call.text.includes(JSON.stringify(contract)));assert.match(call.args.join(' '),/workspace-write/);
 assert.match(call.text,/planning-phase restrictions/);assert.ok(call.args.includes('--output-schema'));
});

test('report task can complete without source changes; partial and blocked reports remain explicit',async t=>{
 const p=fixture(t);await prepared(p,{...contract,kind:'investigate',allowedChanges:[],deliverables:[{id:'D1',description:'原因报告'}]});
 const s=await p.run({action:'implement'},result);assert.equal(s.delivery.warnings.length,0);assert.equal(s.delivery.changesDetected,false);
 await review(p,'result');
 const partial={...result,outcome:'partial',deliverables:[{...result.deliverables[0],status:'blocked'}],unfinished:['缺少现场信息'],verification:[{description:'现场验证',status:'blocked',evidence:['未获得访问条件']}]};
 const f=await p.run({action:'fix'},partial);assert.equal(f.delivery.outcome,'partial');assert.equal(f.phase,'needs-code-review');
 assert.equal(f.delivery.runId,f.lastRun.id);assert.notEqual(f.delivery.beforeSnapshot,s.delivery.beforeSnapshot);
});

test('invalid execution output is retained for review and resume never repeats implementation',async t=>{
 const p=fixture(t);await prepared(p);
 for(const bad of ['', '仅完成原因报告', {...result,deliverables:[]}, {...result,deliverables:[...result.deliverables,...result.deliverables]}, {...result,verification:[]}, {...result,unfinished:['尚未修复']}]){
  const s=await p.run({action:'implement'},bad);assert.equal(s.lastRun.status,'completed');assert.equal(s.delivery.assessment,'invalid-result');
  assert.equal(s.delivery.outcome,null);assert.ok(fs.existsSync(s.delivery.rawResult));
  assert.equal(s.phase,'needs-code-review');
 }
 const before=p.calls().length;await p.run({action:'resume'},'只读回顾');
 assert.equal(p.calls().length,before+1);assert.match(p.calls().at(-1).args.join(' '),/read-only/);
 const resumed=await p.run({action:'status'});assert.equal(resumed.delivery.assessment,'invalid-result');
 await review(p,'result');
});

test('legacy tasks keep UUID/history/reports but cannot implement or fix until replanned and reviewed',async t=>{
 const p=fixture(t);await prepared(p);let s=await p.run({action:'implement'},result);await review(p,'result');
 const old=JSON.parse(fs.readFileSync(p.stateFile));delete old.plan.contract;delete old.plan.contractHash;
 old.questionHistory=[{id:'old-round',questions:[],answers:[{id:'scope',answer:'仅调查'}]}];p.saveState(old);
 const count=p.calls().length;
 for(const action of ['implement','fix'])await assert.rejects(p.run({action},result),/chatgpt-plan/);
 assert.equal(p.calls().length,count);
 const before=fs.readFileSync(p.stateFile,'utf8');const status=await p.run({action:'status'});assert.equal(status.executionSummary.migrationRequired,true);assert.equal(fs.readFileSync(p.stateFile,'utf8'),before);
 const restored=await p.run({action:'resume'},'历史回顾');assert.equal(restored.threadId,s.threadId);assert.deepEqual(restored.questionHistory,old.questionHistory);assert.ok(fs.existsSync(s.lastRun.result));
 const updated=await p.run({action:'plan',text:'补齐原有范围'},ready());assert.equal(updated.approved,null);assert.equal(updated.reviewedRevision,null);
 assert.equal(updated.threadId,s.threadId);assert.deepEqual(updated.questionHistory,old.questionHistory);
});

test('scope questions and partial answers resume unchanged before a goal may be finalized',async t=>{
 const p=fixture(t);const questions=[{id:'scope',header:'交付目标',question:'只调查还是完成修复？',multiSelect:false,options:[{label:'只调查',description:'交原因报告'},{label:'完成修复',description:'交修改与验证'}]},{id:'limits',header:'限制',question:'还有哪些限制？',multiSelect:false,options:[]}];
 const s=await p.run({action:'new',task:'task',text:'排查问题'},{status:'needs_questions',plan:'',contract:null,questions});
 await p.run({action:'record-answers',roundId:s.pendingQuestions.id,answers:[{id:'scope',answer:'完成修复'}]});
 const restored=await p.run({action:'resume'});assert.equal(restored.pendingQuestions.partialAnswers[0].answer,'完成修复');
 await assert.rejects(p.run({action:'implement'},result),/approv|question/i);
 const done=await p.run({action:'answer',roundId:s.pendingQuestions.id,answers:[{id:'scope',answer:'完成修复'},{id:'limits',answer:'不部署'}]},ready());
 assert.equal(done.plan.contract.kind,'modify');assert.match(p.calls().at(-1).text,/完成修复/);
});

test('real file changes are captured per run and do not upgrade a partial outcome to completed',async t=>{
 const p=fixture(t);await prepared(p,{...contract,kind:'investigate-and-modify'});
 const partial={...result,outcome:'partial',deliverables:[{...result.deliverables[0],status:'partial'}],unfinished:['尚缺回归测试']};
 const s=await p.run({action:'implement'},partial,{FAKE_WRITE_APP:'修复后的实际文件'});
 assert.equal(s.delivery.changesDetected,true);assert.equal(s.delivery.outcome,'partial');assert.equal(s.delivery.assessment,'needs-review');
 assert.notEqual(JSON.parse(fs.readFileSync(s.delivery.beforeSnapshot)).hash,JSON.parse(fs.readFileSync(s.delivery.afterSnapshot)).hash);assert.ok(s.delivery.changes.some(e=>e.path==='app.txt'&&e.change==='modified'));
 await review(p,'result');const f=await p.run({action:'fix'},result);
 assert.equal(f.delivery.changesDetected,false);assert.match(f.delivery.warnings.join(' '),/未检测到/);
 assert.equal(JSON.parse(fs.readFileSync(f.delivery.beforeSnapshot)).hash,JSON.parse(fs.readFileSync(s.delivery.afterSnapshot)).hash);
});

test('unchanged goal in review-guided revision retains lineage, but any later plan invalidates it',async t=>{
 const p=fixture(t);await prepared(p);let s=await p.run({action:'revise-plan'},ready());
 assert.equal(s.reviewedRevision,s.plan.revision);await p.run({action:'approve'});
 s=await p.run({action:'plan',text:'补充执行步骤'},ready());assert.equal(s.reviewedRevision,null);assert.equal(s.approved,null);
 await assert.rejects(p.run({action:'implement'},result),/approval/);
});

test('failed re-planning leaves old delivery as historical rather than current completion',async t=>{
 const p=fixture(t);await prepared(p);await p.run({action:'implement'},result);
 await assert.rejects(p.run({action:'plan',text:'修改需求'},undefined,{FAKE_FAIL:'1'}),/failed/);
 const s=await p.run({action:'status'});assert.equal(s.executionSummary.deliveryMatchesCurrentPlan,false);assert.equal(s.executionSummary.planCurrent,false);
 assert.equal(s.delivery.outcome,'completed');assert.equal(s.lastRun.status,'failed');
});

test('failed worker may leave changes and records snapshots without claiming completion or retrying',async t=>{
 const p=fixture(t);await prepared(p);const calls=p.calls().length;
 await assert.rejects(p.run({action:'implement'},undefined,{FAKE_WRITE_APP:'部分修改',FAKE_FAIL_AFTER_WRITE:'1'}),/failed after write/);
 const s=await p.run({action:'status'});
 assert.equal(s.lastRun.status,'failed');assert.equal(s.delivery.assessment,'execution-failed');assert.equal(s.delivery.outcome,null);
 assert.equal(s.delivery.changesDetected,true);assert.ok(fs.existsSync(s.delivery.afterSnapshot));assert.equal(p.calls().length,calls+1);
 assert.equal(fs.existsSync(path.join(s.paths.runtime,'lock.json')),false);
});
