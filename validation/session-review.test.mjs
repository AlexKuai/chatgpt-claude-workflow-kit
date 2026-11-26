import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {execute} from '../.claude/scripts/chatgpt-workflow.mjs';
const uuidA='12345678-1234-4234-8234-123456789abc',uuidB='22345678-1234-4234-8234-123456789abc';
const questions=[
 {id:'audience',header:'读者',question:'文档面向谁？',multiSelect:false,options:[{label:'新员工',description:'逐步解释'},{label:'维护者',description:'简洁参考'}]},
 {id:'notes',header:'补充',question:'还有哪些限制？',multiSelect:false,options:[]}
];
function fixture(t){
 const root=fs.mkdtempSync(path.join(process.env.CHATGPT_TEST_TMP||os.tmpdir(),'session-review-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const capture=path.join(root,'.chatgpt-workflow/capture.jsonl');
 const options={command:[process.execPath,fileURLToPath(new URL('./fake-codex.mjs',import.meta.url))],env:{CHATGPT_KIT_TRANSPORT:'exec',FAKE_CAPTURE:capture}};
 const run=(r,sessionId='session-a',env={})=>execute(root,{sessionId,...r},{...options,env:{...options.env,...env}});
 const calls=()=>fs.existsSync(capture)?fs.readFileSync(capture,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
 const git=(...args)=>{const r=spawnSync('git',args,{cwd:root,encoding:'utf8'});assert.equal(r.status,0,r.stderr);};
 const repo=()=>{git('init','-q');fs.writeFileSync(path.join(root,'.gitignore'),'capture.jsonl\n');fs.writeFileSync(path.join(root,'guide.md'),'# 初始文档\n');git('add','.');git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','base');};
 return {root,run,calls,options,repo};
}
async function start(p){return p.run({action:'new',task:'guide',text:'编写入职指南'});}
async function review(p,kind='plan'){
 const r=await p.run({action:'review-start',kind});
 return p.run({action:'review-save',kind,ticket:r.ticket,text:'R1: 增加操作示例。'});
}
async function implemented(p){p.repo();await start(p);await review(p);await p.run({action:'approve'});return p.run({action:'implement'});}

test('missing new/use required arguments do not create state or change an existing binding',async t=>{
 const p=fixture(t);
 for(const request of [{action:'new'},{action:'new',text:'需求'}, {action:'new',task:'incomplete'},
  {action:'new',task:'incomplete',text:'  '},{action:'use'}]){
  await assert.rejects(p.run(request));
  assert.equal(fs.existsSync(path.join(p.root,'.chatgpt-workflow')),false);
  assert.equal(p.calls().length,0);
 }
 await start(p);const before=await p.run({action:'status'}),calls=p.calls().length;
 await assert.rejects(p.run({action:'use'}));
 await assert.rejects(p.run({action:'new',task:'incomplete'}));
 const after=await p.run({action:'status'});
 assert.equal(after.task,before.task);assert.equal(after.threadId,before.threadId);
 assert.equal(p.calls().length,calls);
 assert.equal(fs.existsSync(path.join(before.paths.runtime,'tasks','incomplete')),false);
});

test('partial browser review hands all evidence to fix and requires fresh review after fixing',async t=>{
 const p=fixture(t);await implemented(p);
 const ticket=await p.run({action:'review-start',kind:'result'});
 const evidence=path.join(ticket.paths.task,'evidence');fs.mkdirSync(evidence);
 fs.writeFileSync(path.join(evidence,'test-note.txt'),'Fixture evidence, not a browser run.');
 const report='结论：检查不完整\n## 验证记录\n浏览器验证：需要；工具：未实际运行（离线测试）\n测试地址：http://localhost:3000\n登录：受阻，服务未启动\nR1 [产品缺陷] 文档内错误链接，已静态确认\nR2 [环境问题] 服务不可访问，不是产品缺陷\nR3 [新增建议] 增加 SSO，未批准\n证据：evidence/test-note.txt\n未验证范围：登录交互';
 const saved=await p.run({action:'review-save',kind:'result',ticket:ticket.ticket,text:report});
 assert.equal(saved.reviewSession,null);
 await p.run({action:'fix',text:'只处理 R1'});
 const prompt=p.calls().at(-1).text;
 assert.ok(prompt.includes(report));assert.ok(prompt.includes('只处理 R1'));
 assert.match(prompt,/Do not weaken test assertions/);
 assert.match(prompt,/Environment blockers are not product defects/);
 assert.match(prompt,/New suggestions are not approved requirements/);
 await assert.rejects(p.run({action:'fix'}),/stale|review|version/i);
 const retest=await p.run({action:'review-start',kind:'result'});
 assert.notEqual(retest.ticket,ticket.ticket);
});

test('Claude sessions select independent tasks and resume their exact Codex UUIDs',async t=>{
 const p=fixture(t);await start(p);
 await p.run({action:'new',task:'other',text:'另一个任务'},'session-b',{FAKE_THREAD:uuidB});
 assert.equal((await p.run({action:'status'})).task,'guide');
 await p.run({action:'resume'});
 assert.equal(p.calls().at(-1).args[p.calls().at(-1).args.indexOf('resume')+1],uuidA);
 assert.equal((await p.run({action:'status'},'session-b')).threadId,uuidB);
 await p.run({action:'use',task:'guide'},'session-b');
 assert.equal((await p.run({action:'status'})).task,'guide');
});
test('unbound or missing session never silently adopts the last project task',async t=>{
 const p=fixture(t);await start(p);const count=p.calls().length;
 const state=await p.run({action:'resume'},'unbound');
 assert.equal(state.selectionRequired,true);assert.equal(state.tasks[0].task,'guide');assert.equal(p.calls().length,count);
 const before=fs.readFileSync(path.join(p.root,'.chatgpt-workflow','tasks','guide','state.json'),'utf8');
 await assert.rejects(p.run({action:'implement'},'unbound'),/bind|select|chatgpt-use/i);
 await assert.rejects(p.run({action:'new',task:'no-session',text:'x',sessionId:null}),/session/i);
 assert.equal((await p.run({action:'status',sessionId:null})).selectionRequired,true);
 assert.equal(fs.readFileSync(path.join(p.root,'.chatgpt-workflow','tasks','guide','state.json'),'utf8'),before);
 await assert.rejects(p.run({action:'plan',task:'other',text:'misroute'}),/binding|chatgpt-use/i);
});
test('old state can be explicitly bound without losing UUID or planning answers',async t=>{
 const p=fixture(t),s=await start(p);const stateFile=path.join(s.paths.task,'state.json');
 const state=JSON.parse(fs.readFileSync(stateFile));state.questionHistory=[{id:'old',questions:[],answers:[{id:'old',answer:'保留原答案'}]}];fs.writeFileSync(stateFile,JSON.stringify(state));
 const unbound=await p.run({action:'status'},'new-session');assert.equal(unbound.selectionRequired,true);
 await p.run({action:'use',task:'guide'},'new-session');
 const resumed=await p.run({action:'resume'},'new-session');assert.equal(resumed.threadId,uuidA);assert.equal(resumed.questionHistory[0].answers[0].answer,'保留原答案');
});
test('review partial answers survive restart and block dependent work without invoking Codex',async t=>{
 const p=fixture(t);await start(p);const ticket=await p.run({action:'review-start',kind:'plan'});
 const q=await p.run({action:'review-questions',kind:'plan',ticket:ticket.ticket,questions,text:'需要确认读者和限制。'});
 const roundId=q.reviewSession.pendingRoundId;
 await p.run({action:'review-record-answers',kind:'plan',ticket:ticket.ticket,roundId,answers:[{id:'audience',answer:'新员工；保留术语解释'}]});
 const count=p.calls().length,resumed=await p.run({action:'resume'});
 assert.equal(resumed.resumeOwner,'claude');assert.equal(resumed.reviewSession.rounds[0].partialAnswers[0].answer,'新员工；保留术语解释');assert.equal(p.calls().length,count);
 for(const action of ['approve','implement','revise-plan','fix'])await assert.rejects(p.run({action}),/review|decision|question/i);
 await assert.rejects(p.run({action:'review-save',kind:'plan',ticket:ticket.ticket,text:'假装完成'}),/answer|question|decision/i);
 await assert.rejects(p.run({action:'review-record-answers',kind:'plan',ticket:ticket.ticket,roundId,answers:[{id:'notes',answer:' '}]}),/text/i);
 assert.equal((await p.run({action:'review-start',kind:'plan'})).ticket,ticket.ticket);
});
test('completed review answers and extra rounds are preserved verbatim in the Codex plan revision',async t=>{
 const p=fixture(t);await start(p);const ticket=await p.run({action:'review-start',kind:'plan'});
 let q=await p.run({action:'review-questions',kind:'plan',ticket:ticket.ticket,questions});
 await p.run({action:'review-record-answers',kind:'plan',ticket:ticket.ticket,roundId:q.reviewSession.pendingRoundId,answers:[{id:'audience',answer:'新员工'},{id:'notes',answer:'保留原文：中文 "引号"\n第二行'}]});
 q=await p.run({action:'review-questions',kind:'plan',ticket:ticket.ticket,questions:[{...questions[1],id:'extra',question:'示例使用什么名称？'}]});
 await p.run({action:'review-record-answers',kind:'plan',ticket:ticket.ticket,roundId:q.reviewSession.pendingRoundId,answers:[{id:'extra',answer:'示例甲'}]});
 const saved=await p.run({action:'review-save',kind:'plan',ticket:ticket.ticket,text:'R1: 添加示例。'});
 assert.equal(saved.reviewSession,null);assert.equal(saved.reviewHistory[0].rounds.length,2);
 assert.ok(fs.readFileSync(saved.paths.reviewQuestions,'utf8').includes('示例甲'));
 await p.run({action:'revise-plan'});
 assert.ok(p.calls().at(-1).text.includes('保留原文：中文 "引号"\n第二行'));assert.ok(p.calls().at(-1).text.includes('示例甲'));
});
test('a failed review report write preserves exact draft and answers for retry after resume',async t=>{
 const p=fixture(t);await start(p);const ticket=await p.run({action:'review-start',kind:'plan'});
 const q=await p.run({action:'review-questions',kind:'plan',ticket:ticket.ticket,questions:[questions[0]]});
 await p.run({action:'review-record-answers',kind:'plan',ticket:ticket.ticket,roundId:q.reviewSession.pendingRoundId,answers:[{id:'audience',answer:'新员工'}]});
 const report=path.join(ticket.paths.task,`${ticket.ticket}.plan-review.md`);fs.mkdirSync(report);
 await assert.rejects(p.run({action:'review-save',kind:'plan',ticket:ticket.ticket,text:'R1: 保存失败仍保留。'}));
 const count=p.calls().length,resumed=await p.run({action:'resume'});
 assert.equal(resumed.reviewSession.draft.text,'R1: 保存失败仍保留。');assert.equal(resumed.reviewSession.rounds[0].partialAnswers[0].answer,'新员工');assert.equal(p.calls().length,count);
 fs.rmdirSync(report);
 const saved=await p.run({action:'review-save',kind:'plan',ticket:ticket.ticket});assert.ok(fs.readFileSync(saved.reviews.plan.file,'utf8').includes('新员工'));
 const retried=await p.run({action:'review-save',kind:'plan',ticket:ticket.ticket});assert.equal(retried.reviews.plan.file,saved.reviews.plan.file);
});
test('changed result invalidates review answers and keeps them historical without reusing decisions',async t=>{
 const p=fixture(t);await implemented(p);const ticket=await p.run({action:'review-start',kind:'result'});
 const q=await p.run({action:'review-questions',kind:'result',ticket:ticket.ticket,questions:[questions[0]]});
 await p.run({action:'review-record-answers',kind:'result',ticket:ticket.ticket,roundId:q.reviewSession.pendingRoundId,answers:[{id:'audience',answer:'新员工'}]});
 fs.appendFileSync(path.join(p.root,'guide.md'),'\n改成另一份文档');
 const resumed=await p.run({action:'resume'});assert.equal(resumed.reviewSession.stale,true);assert.equal(resumed.resumeOwner,'claude');
 await assert.rejects(p.run({action:'review-save',kind:'result',ticket:ticket.ticket,text:'old'}),/stale/i);
 const fresh=await p.run({action:'review-start',kind:'result'});assert.notEqual(fresh.ticket,ticket.ticket);assert.equal(fresh.reviewSession.rounds.length,0);
 assert.equal(fresh.reviewHistory.find(r=>r.ticket===ticket.ticket).rounds[0].partialAnswers[0].answer,'新员工');
});
test('document implementation result review and fix use artifact-neutral prompts and old code alias',async t=>{
 const p=fixture(t);await implemented(p);fs.appendFileSync(path.join(p.root,'guide.md'),'\n缺少代理配置示例');
 const ticket=await p.run({action:'review-start',kind:'result'});
 const q=await p.run({action:'review-questions',kind:'result',ticket:ticket.ticket,questions:[questions[1]]});
 await assert.rejects(p.run({action:'fix'}),/review/i);
 await p.run({action:'review-record-answers',kind:'result',ticket:ticket.ticket,roundId:q.reviewSession.pendingRoundId,answers:[{id:'notes',answer:'使用示例代理 proxy.example.invalid'}]});
 const saved=await p.run({action:'review-save',kind:'code',ticket:ticket.ticket,text:'R1: 文档需要增加代理配置示例。'});
 assert.ok(saved.reviews.code);await p.run({action:'fix'});
 assert.ok(p.calls().at(-1).text.includes('文档需要增加代理配置示例'));assert.ok(p.calls().at(-1).text.includes('使用示例代理 proxy.example.invalid'));assert.match(p.calls().at(-1).text,/deliverables|artifacts/i);
 assert.match(p.calls().at(-1).args.join(' '),/--sandbox workspace-write/);
});
test('review focus and partial answers remain available when readable export fails',async t=>{
 const p=fixture(t);await start(p);const ticket=await p.run({action:'review-start',kind:'plan',text:'特别检查代理环境。'});
 const q=await p.run({action:'review-questions',kind:'plan',ticket:ticket.ticket,questions});
 assert.equal(q.reviewSession.focus,'特别检查代理环境。');
 fs.unlinkSync(q.paths.reviewQuestions);fs.mkdirSync(q.paths.reviewQuestions);
 await assert.rejects(p.run({action:'review-record-answers',kind:'plan',ticket:ticket.ticket,roundId:q.reviewSession.pendingRoundId,answers:[{id:'audience',answer:'新员工'}]}));
 const resumed=await p.run({action:'resume'});
 assert.equal(resumed.reviewSession.rounds[0].partialAnswers[0].answer,'新员工');assert.equal(resumed.reviewSession.focus,'特别检查代理环境。');
});
test('new planning archives unfinished review decisions and rejects the old report ticket',async t=>{
 const p=fixture(t);await start(p);const ticket=await p.run({action:'review-start',kind:'plan'});
 const q=await p.run({action:'review-questions',kind:'plan',ticket:ticket.ticket,questions:[questions[0]]});
 await p.run({action:'review-record-answers',kind:'plan',ticket:ticket.ticket,roundId:q.reviewSession.pendingRoundId,answers:[{id:'audience',answer:'新员工'}]});
 const changed=await p.run({action:'plan',text:'新的范围：改为维护者手册。'});
 assert.equal(changed.reviewSession,null);assert.equal(changed.reviewHistory[0].rounds[0].partialAnswers[0].answer,'新员工');
 await assert.rejects(p.run({action:'review-save',kind:'plan',ticket:ticket.ticket,text:'旧结论'}),/stale/i);
 await assert.rejects(p.run({action:'approve'}),/review/i);
});
test('status without a session or task is a zero-write listing',async t=>{
 const p=fixture(t);const before=fs.readdirSync(p.root);
 const s=await p.run({action:'status',sessionId:null});assert.equal(s.selectionRequired,true);assert.deepEqual(s.tasks,[]);
 assert.deepEqual(fs.readdirSync(p.root),before);
});
test('bound task and unfinished Claude review survive independent runner processes',async t=>{
 const p=fixture(t),scripts=path.join(p.root,'.claude','scripts');fs.mkdirSync(scripts,{recursive:true});
 const runner=path.join(scripts,'chatgpt-workflow.mjs');fs.copyFileSync(fileURLToPath(new URL('../.claude/scripts/chatgpt-workflow.mjs',import.meta.url)),runner);
 for(const name of ['app-server-client.mjs','control-store.mjs','codex-bridge.mjs','runtime-questions.mjs','output-view.mjs'])fs.copyFileSync(fileURLToPath(new URL('../.claude/scripts/'+name,import.meta.url)),path.join(scripts,name));
 fs.copyFileSync(fileURLToPath(new URL('../.claude/scripts/goal-contract.mjs',import.meta.url)),path.join(scripts,'goal-contract.mjs'));
 fs.copyFileSync(fileURLToPath(new URL('../.claude/scripts/file-snapshot.mjs',import.meta.url)),path.join(scripts,'file-snapshot.mjs'));
 fs.writeFileSync(path.join(p.root,'.claude','chatgpt-workflow.json'),JSON.stringify({codexCommand:p.options.command}));
 const cli=(r,sessionId='cli-a',env={})=>{const result=spawnSync(process.execPath,[runner,'--stdin'],{cwd:path.dirname(p.root),input:JSON.stringify({sessionId,...r}),encoding:'utf8',env:{...process.env,CHATGPT_KIT_HOME:path.join(p.root,'.chatgpt-workflow','kit-home'),...p.options.env,...env}});assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);};
 cli({action:'new',task:'a',text:'任务 A'});cli({action:'new',task:'b',text:'任务 B'},'cli-b',{FAKE_THREAD:uuidB});
 const ticket=cli({action:'review-start',kind:'plan'});assert.equal(ticket.task,'a');
 const q=cli({action:'review-questions',kind:'plan',ticket:ticket.ticket,questions});
 cli({action:'review-record-answers',kind:'plan',ticket:ticket.ticket,roundId:q.reviewSession.pendingRoundId,answers:[{id:'audience',answer:'新员工'}]});
 const count=p.calls().length,resumed=cli({action:'resume'});
 assert.equal(resumed.resumeOwner,'claude');assert.equal(resumed.task,'a');assert.equal(resumed.reviewSession.rounds[0].partialAnswers[0].answer,'新员工');assert.equal(p.calls().length,count);
 assert.equal(cli({action:'status'},'cli-b').threadId,uuidB);
});
test('plan review becomes stale when repository evidence changes during questions or after final save',async t=>{
 const p=fixture(t);p.repo();await start(p);const ticket=await p.run({action:'review-start',kind:'plan'});
 const q=await p.run({action:'review-questions',kind:'plan',ticket:ticket.ticket,questions:[questions[0]]});
 await p.run({action:'review-record-answers',kind:'plan',ticket:ticket.ticket,roundId:q.reviewSession.pendingRoundId,answers:[{id:'audience',answer:'新员工'}]});
 fs.appendFileSync(path.join(p.root,'guide.md'),'\n依赖步骤已改变');
 assert.equal((await p.run({action:'resume'})).reviewSession.stale,true);
 await assert.rejects(p.run({action:'review-save',kind:'plan',ticket:ticket.ticket,text:'旧评审'}),/stale/i);
 const fresh=await p.run({action:'review-start',kind:'plan'});assert.notEqual(fresh.ticket,ticket.ticket);
 assert.equal(fresh.reviewSession.rounds.length,0);
 await p.run({action:'review-save',kind:'plan',ticket:fresh.ticket,text:'重新检查后的报告'});
 fs.appendFileSync(path.join(p.root,'guide.md'),'\n再次改变依赖步骤');
 await assert.rejects(p.run({action:'approve'}),/stale|evidence/i);
});
test('failure of readable review export reports a warning after final report is durably saved',async t=>{
 const p=fixture(t);await start(p);const ticket=await p.run({action:'review-start',kind:'plan'});
 fs.unlinkSync(ticket.paths.reviewQuestions);fs.mkdirSync(ticket.paths.reviewQuestions);
 const saved=await p.run({action:'review-save',kind:'plan',ticket:ticket.ticket,text:'最终报告已保存'});
 assert.ok(saved.warnings.some(w=>/export/i.test(w)));assert.equal(saved.reviewSession,null);
 assert.ok(fs.readFileSync(saved.reviews.plan.file,'utf8').includes('最终报告已保存'));
 fs.rmdirSync(ticket.paths.reviewQuestions);
 const retry=await p.run({action:'review-save',kind:'plan',ticket:ticket.ticket});assert.ok(fs.existsSync(retry.paths.reviewQuestions));
 assert.equal(retry.reviews.plan.file,saved.reviews.plan.file);
});
test('legacy reviews remain readable but require fresh review before approval or fixes',async t=>{
 const p=fixture(t);await implemented(p);const saved=await review(p,'code');
 const file=path.join(saved.paths.task,'state.json'),state=JSON.parse(fs.readFileSync(file));
 for(const r of Object.values(state.reviews)){delete r.ticket;delete r.textHash;delete r.repositoryHash;delete r.evidenceFormat;}
 delete state.reviewSession;delete state.reviewHistory;delete state.ticket;
 fs.writeFileSync(file,JSON.stringify(state));
 await p.run({action:'use',task:'guide'},'migrated-session');
 await assert.rejects(p.run({action:'approve'},'migrated-session'),/旧评审/);
 await assert.rejects(p.run({action:'fix'},'migrated-session'),/旧评审/);
 assert.equal((await p.run({action:'status'},'migrated-session')).threadId,uuidA);
});
