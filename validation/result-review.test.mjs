// One answer to "is the result review still valid", shared by status, the choice card and planning. Planning is never blocked by it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execute} from '../.claude/scripts/chatgpt-workflow.mjs';
import {compactView} from '../.claude/scripts/output-view.mjs';
import {kit,command} from './kit-fixture.mjs';

const contract={kind:'modify',deliverables:[{id:'D1',description:'修复登录并验证'}],allowedChanges:['登录'],excludedChanges:['部署'],acceptanceCriteria:['错误密码被拒绝']};
const ready={status:'ready',plan:'## 执行步骤\n检查并完成验收。',questions:[],contract};
const outcome=(value,unfinished=['遗留项-锁定策略'])=>({outcome:value,deliverables:[{id:'D1',status:value==='completed'?'completed':value,summary:'说明',evidence:['app.txt']}],verification:[{description:'登录检查',status:'passed',evidence:['记录']}],unfinished,changeExplanation:'说明',report:'# 结果\n内容'});
const done=outcome('partial');
function fixture(t){
 const root=fs.mkdtempSync(path.join(process.env.CHATGPT_TEST_TMP||os.tmpdir(),'result-kit-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.writeFileSync(path.join(root,'app.txt'),'base');
 const capture=path.join(root,'.chatgpt-workflow/calls.jsonl');
 const options={command:[process.execPath,fileURLToPath(new URL('./fake-codex.mjs',import.meta.url))],env:{CHATGPT_KIT_TRANSPORT:'exec',FAKE_CAPTURE:capture}};
 const run=(request,response,env={})=>execute(root,{sessionId:'result-session',...request},{...options,env:{...options.env,...(response===undefined?{}:{FAKE_RAW_RESPONSE:typeof response==='string'?response:JSON.stringify(response)}),...env}});
 const stateFile=path.join(root,'.chatgpt-workflow/tasks/task/state.json');
 const state=()=>JSON.parse(fs.readFileSync(stateFile)),save=s=>fs.writeFileSync(stateFile,JSON.stringify(s));
 const review=async(kind='code',text='R7 锁定策略待核对')=>{const r=await run({action:'review-start',kind});return run({action:'review-save',kind,ticket:r.ticket,text});};
 const gate=async()=>(await run({action:'status'})).executionSummary;
 const prompt=()=>JSON.parse(fs.readFileSync(capture,'utf8').trim().split('\n').at(-1)).text;
 const plan=(text='下一项',env)=>run({action:'plan',text},ready,env);
 const fix=()=>run({action:'fix',text:'R7'},done);
 const config=value=>{fs.mkdirSync(path.join(root,'.claude'),{recursive:true});fs.writeFileSync(path.join(root,'.claude/chatgpt-workflow.json'),JSON.stringify(value));};
 return {root,run,state,save,review,gate,prompt,plan,fix,config,app:path.join(root,'app.txt'),planFile:path.join(path.dirname(stateFile),'plan.md')};
}
async function implemented(p){await p.run({action:'new',task:'task',text:'需求'},ready);await p.review('plan');await p.run({action:'approve'});await p.run({action:'implement'},done,{FAKE_WRITE_APP:'changed'});}
async function reviewed(p){await implemented(p);await p.review();}

test('a current result review is accepted by fix and adds nothing to the next planning prompt',async t=>{
 const p=fixture(t);await reviewed(p);
 assert.equal((await p.gate()).resultReview,'current');
 const s=await p.plan();assert.equal(s.reviewNotice,undefined);assert.doesNotMatch(p.prompt(),/R7|遗留项|independently reviewed/);
 const q=fixture(t);await reviewed(q);await q.fix();
});
for(const change of ['added','modified','deleted','rules'])test(`a result review is stale after ${change} files`,async t=>{
 const p=fixture(t);await reviewed(p);
 if(change==='added')fs.writeFileSync(path.join(p.root,'extra.txt'),'new');
 if(change==='modified')fs.writeFileSync(p.app,'external');
 if(change==='deleted')fs.unlinkSync(p.app);
 if(change==='rules')p.config({snapshot:{excludeDirectories:['cache-custom']}});
 const gate=await p.gate();assert.equal(gate.resultReview,'stale');assert.match(gate.resultReviewNote,change==='rules'?/扫描规则/:/extra\.txt|app\.txt/);
 await assert.rejects(p.fix(),/stale/);
 const s=await p.plan();assert.match(s.reviewNotice,/有变化/);
 assert.match(p.prompt(),/changed after the saved result review/);assert.match(p.prompt(),/R7/);assert.match(p.prompt(),/遗留项-锁定策略/);assert.doesNotMatch(p.prompt(),/NOT been independently reviewed/);
});
for(const damage of ['modified','missing','legacy'])test(`a ${damage} report is invalid: fix refuses it and planning does not quote it`,async t=>{
 const p=fixture(t);await reviewed(p);const s=p.state();
 if(damage==='modified')fs.appendFileSync(s.reviews.code.file,'UNTRUSTED');
 if(damage==='missing')fs.unlinkSync(s.reviews.code.file);
 if(damage==='legacy'){s.reviews.code.evidenceFormat='git-v0';p.save(s);}
 assert.equal((await p.gate()).resultReview,'invalid');await assert.rejects(p.fix());
 const r=await p.plan();assert.match(r.reviewNotice,/报告/);assert.match(p.prompt(),/report cannot be trusted/);assert.doesNotMatch(p.prompt(),/R7|UNTRUSTED/);
});
test('files that cannot be scanned give an unknown review but never stop planning',async t=>{
 const p=fixture(t);await reviewed(p);p.config({snapshot:{excludeDirectories:'bad'}});
 const gate=await p.gate();assert.equal(gate.resultReview,'unknown');assert.ok(gate.resultReviewNote);await assert.rejects(p.fix());
 const s=await p.plan();assert.match(s.reviewNotice,/无法/);assert.equal(s.phase,'planned');
});
test('a file changed after the status query is still noticed when planning starts',async t=>{
 const p=fixture(t);await reviewed(p);assert.equal((await p.gate()).resultReview,'current');
 const s=p.state();fs.writeFileSync(p.app,'external');fs.appendFileSync(s.reviews.code.file,'UNTRUSTED');
 assert.notEqual((await p.gate()).resultReview,'current');
 assert.ok((await p.plan()).reviewNotice);assert.doesNotMatch(p.prompt(),/UNTRUSTED/);
});
test('an unfinished result review is reported and planning may still supersede it',async t=>{
 const p=fixture(t);await implemented(p);await p.run({action:'review-start',kind:'code'});
 assert.equal((await p.gate()).resultReview,'in-progress');
 const s=await p.plan();assert.match(s.reviewNotice,/未完成/);assert.equal(p.state().reviewHistory.at(-1).outcome,'superseded-planning');
});
test('a fix makes the earlier review historical, whose findings are still handed over',async t=>{
 const p=fixture(t);await reviewed(p);await p.fix();
 assert.equal((await p.gate()).resultReview,'none');
 const s=await p.plan();assert.match(s.reviewNotice,/未评审/);assert.match(p.prompt(),/R7/);assert.match(p.prompt(),/NOT been independently reviewed/);
});
test('the judgement is fixed when planning starts and survives a failed attempt',async t=>{
 const p=fixture(t);await reviewed(p);fs.writeFileSync(p.app,'external');
 await assert.rejects(p.plan('x',{FAKE_FAIL:'1'}),/failed/);assert.equal((await p.gate()).resultReview,'unavailable');
 const s=await p.plan();assert.match(s.reviewNotice,/有变化/);
 const q=fixture(t);await reviewed(q);await q.plan();fs.writeFileSync(q.app,'later edit');
 const again=await q.plan('再补充');assert.equal(again.reviewNotice,undefined);assert.doesNotMatch(q.prompt(),/independently reviewed|result review/);
});
test('a revision after a reviewed result does not turn it into an unreviewed one',async t=>{
 const p=fixture(t);await reviewed(p);await p.review('plan');await p.run({action:'revise-plan'},ready);
 const s=await p.plan();assert.equal(s.reviewNotice,undefined);
});
test('tasks saved before the judgement was recorded fall back to what the records show',async t=>{
 const p=fixture(t);await reviewed(p);await p.plan();let s=p.state();delete s.delivery.reviewAtPlanning;p.save(s);
 assert.equal((await p.plan()).reviewNotice,undefined);
 const q=fixture(t);await implemented(q);await q.plan();s=q.state();delete s.delivery.reviewAtPlanning;q.save(s);
 assert.match((await q.plan()).reviewNotice,/未评审/);
});
test('planning stays the way out: plan edited during a review, or a run whose worker disappeared',async t=>{
 const p=fixture(t);await p.run({action:'new',task:'task',text:'需求'},ready);await p.run({action:'review-start',kind:'plan'});
 fs.appendFileSync(p.planFile,'edited');await assert.rejects(p.run({action:'review-start',kind:'plan'}),/chatgpt-plan/);
 assert.equal((await p.plan()).phase,'planned');
 const q=fixture(t);await implemented(q);const s=q.state();s.delivery.assessment='running';delete s.delivery.changesDetected;q.save(s);
 assert.equal((await q.gate()).resultReview,'none');await q.review();assert.equal((await q.gate()).resultReview,'current');await q.fix();assert.equal((await q.plan()).phase,'planned');
});
for(const [name,response] of [['completed',outcome('completed',[])],['partial',outcome('partial')],['blocked',outcome('blocked')],['invalid-result','not json']])
 test(`an unreviewed plan whose run ended as ${name} without file changes is not executed again`,async t=>{
  const p=fixture(t);await p.run({action:'new',task:'task',text:'需求'},ready);await p.run({action:'approve',withoutReview:true});
  await p.run({action:'implement'},response);
  const d=p.state().delivery;assert.equal(d.changesDetected,false);assert.equal(d.assessment,name==='invalid-result'?'invalid-result':'needs-review');
  assert.equal((await p.gate()).planReview,'unavailable');
  await assert.rejects(p.run({action:'approve',withoutReview:true}),/已执行/);await assert.rejects(p.run({action:'implement'},response),/已执行/);
 });
test('only an explicit failure without changes may be retried',async t=>{
 const p=fixture(t);await p.run({action:'new',task:'task',text:'需求'},ready);await p.run({action:'approve',withoutReview:true});
 await assert.rejects(p.run({action:'implement'},undefined,{FAKE_FAIL:'1'}),/failed/);
 const s=p.state();for(const [assessment,changesDetected] of [['running',undefined],['execution-failed',null],['execution-failed',true]]){
  p.save({...s,delivery:{...s.delivery,assessment,changesDetected}});await assert.rejects(p.run({action:'approve',withoutReview:true}),/已执行/);
 }
 p.save(s);await p.run({action:'approve',withoutReview:true});await p.run({action:'implement'},done,{FAKE_WRITE_APP:'x'});
});
function withoutHardLinks(t,p){
 const file=path.join(p.parent,'no-links.mjs');
 fs.writeFileSync(file,"import fs from 'node:fs';fs.linkSync=()=>{throw Object.assign(new Error('EPERM: operation not permitted, link'),{code:'EPERM'});};");
 const before=process.env.NODE_OPTIONS;process.env.NODE_OPTIONS=`--import=${pathToFileURL(file).href}`;
 t.after(()=>{if(before===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=before;});
}
test('approvals, refusals and answers work where hard links are not permitted',async t=>{
 const p=kit(t);await p.approved();withoutHardLinks(t,p);
 const ask={request:'item/tool/requestUserInput',params:{questions:[{id:'q',header:'q',question:'q?',options:[],isSecret:false}]}};
 let s=await p.call({action:'implement'},{steps:[command(),command({command:'npm test'}),ask]});
 s=await p.userApproves(s.approveCommand);assert.equal(s.runState,'awaiting-approval');
 s=await p.call({action:'approval-decline',id:s.approval.id,text:'不要'});assert.equal(s.runState,'awaiting-user-input');
 s=await p.call({action:'user-input-answer',id:s.userInput.id,answers:[{id:'q',answer:'原文'}]});assert.equal(s.runState,'completed');
 assert.deepEqual(p.responses(),[{decision:'accept'},{decision:'decline'},{answers:{q:{answers:['原文']}}}]);
});
test('of a simultaneous approval and refusal exactly one takes effect',async t=>{
 const p=kit(t);await p.approved();const s=await p.call({action:'implement'},{steps:[command()]});
 const h=await p.hook({command:s.approveCommand}),args=[...h.updatedInput.command.matchAll(/"([^"]*)"|(\S+)/g)].map(m=>m[1]??m[2]).slice(1);
 const results=await Promise.all([p.exec(args),p.raw({action:'approval-decline',id:s.approval.id})]);
 assert.equal(results.filter(r=>r.status===0).length,1,results.map(r=>r.err).join('|'));assert.equal(p.responses().length,1);
 assert.equal(p.responses()[0].decision,results[0].status===0?'accept':'decline');
});
test('an oversized delivery record is shortened with a way to the full file; ordinary ones are not',()=>{
 const item=i=>({id:`D${i}`,description:'述'.repeat(500),status:'completed',summary:'说'.repeat(900),evidence:Array.from({length:9},(_,n)=>`证据${n}`)});
 const base={runId:'r',outcome:'partial',changes:[],warnings:['必须完整'.repeat(200)]};
 const big=compactView({paths:{task:'T'},delivery:{...base,deliverables:Array.from({length:40},(_,i)=>item(i)),verification:Array.from({length:30},(_,i)=>item(i)),unfinished:Array.from({length:30},()=>'缺'.repeat(800)),changeExplanation:'因'.repeat(5000)}}).delivery;
 assert.equal(big.deliverables.length,20);assert.equal(big.deliverables[0].id,'D0');assert.equal(big.deliverables[0].status,'completed');assert.ok(big.deliverables[0].summary.length<400);assert.equal(big.deliverables[0].evidence.length,3);
 assert.deepEqual(big.shortened.totals,{deliverables:40,verification:30,unfinished:30});assert.match(big.shortened.fullRecord,/state\.json|delivery\.json/);
 assert.ok(big.changeExplanation.length<500);assert.deepEqual(big.warnings,base.warnings);
 const small={...base,deliverables:[item(1)],verification:[item(2)],unfinished:['x'],changeExplanation:'y'},view=compactView({paths:{task:'T'},delivery:small}).delivery;
 assert.deepEqual(view.deliverables,small.deliverables);assert.equal(view.shortened,undefined);
});
test('one status scans the project once at most, and not at all when no result review exists',async t=>{
 const p=fixture(t);await implemented(p);
 const scans=async()=>{const open=fs.openSync;let n=0;fs.openSync=(file,...rest)=>{if(String(file)===fs.realpathSync(p.app))n++;return open(file,...rest);};try{await p.gate();}finally{fs.openSync=open;}return n;};
 assert.equal(await scans(),0);
 await p.review();assert.equal(await scans(),1);
 await p.run({action:'review-start',kind:'code'});fs.writeFileSync(p.app,'external');assert.equal(await scans(),1);
});
test('reported flow: skipped plan review, reviewed result, then both the file and the report are edited',async t=>{
 const p=fixture(t);await p.run({action:'new',task:'task',text:'需求'},ready);await p.run({action:'approve',withoutReview:true});
 await p.run({action:'implement'},done,{FAKE_WRITE_APP:'changed'});await p.review();
 fs.writeFileSync(p.app,'external');assert.equal((await p.gate()).resultReview,'stale');
 fs.appendFileSync(p.state().reviews.code.file,'UNTRUSTED');assert.equal((await p.gate()).resultReview,'invalid');
 const s=await p.plan();assert.ok(s.reviewNotice);assert.match(p.prompt(),/遗留项-锁定策略/);assert.doesNotMatch(p.prompt(),/UNTRUSTED/);
});
test('shortening keeps unfinished and failed items ahead of finished ones',()=>{
 const list=Array.from({length:40},(_,i)=>({id:`D${i}`,status:i>=37?'blocked':'completed',summary:'说'.repeat(400),evidence:[]}));
 const view=compactView({paths:{task:'T'},delivery:{runId:'r',deliverables:list,verification:[],unfinished:[]}}).delivery;
 assert.deepEqual(view.deliverables.slice(-3).map(d=>d.id),['D37','D38','D39']);assert.equal(view.deliverables.length,20);
});
test('the skills describe every result-review state, and only current as valid',()=>{
 const skill=p=>fs.readFileSync(new URL(`../.claude/skills/${p}`,import.meta.url),'utf8');
 for(const state of ['current','none','stale','invalid','in-progress','unknown','unavailable'])for(const file of ['chatgpt/references/runner.md','chatgpt/references/status.md','chatgpt-plan/SKILL.md'])assert.ok(skill(file).includes(`\`${state}\``),`${file}: ${state}`);
 for(const file of ['chatgpt/SKILL.md','chatgpt-status/SKILL.md','chatgpt/references/status.md','chatgpt/references/runner.md'])assert.match(skill(file),/只有 `current`/);
 const card=skill('chatgpt/references/workflow.md');for(const text of ['先完成评审（推荐）','放弃这次评审，继续规划','先处理扫描问题（推荐）','resultReviewNote'])assert.ok(card.includes(text),text);
 for(const file of ['chatgpt/references/runner.md','chatgpt/references/review.md'])assert.match(skill(file),/fullRecord/);
});
