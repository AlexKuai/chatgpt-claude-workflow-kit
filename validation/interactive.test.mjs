import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execute as executeRunner} from '../.claude/scripts/chatgpt-workflow.mjs';
import {fixtureContract} from './fixture-goals.mjs';
const execute=(root,request,options)=>executeRunner(root,{sessionId:'interactive-test-session',...request},options);
const question={id:'login',header:'登录方式',question:'采用什么登录方式？',multiSelect:false,options:[{label:'邮箱',description:'邮箱和密码'},{label:'手机',description:'短信验证码'}]};
const clarify={status:'needs_questions',plan:'',questions:[question]};
const ready={status:'ready',plan:'# 计划\n使用用户选择的登录方式。',questions:[],contract:fixtureContract};
function fixture(t){const root=fs.mkdtempSync(path.join(process.env.CHATGPT_TEST_TMP||os.tmpdir(),'chatgpt-qa-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const capture=path.join(root,'.chatgpt-workflow/calls.jsonl');const options={command:[process.execPath,fileURLToPath(new URL('./fake-codex.mjs',import.meta.url))],env:{CHATGPT_KIT_TRANSPORT:'exec',FAKE_CAPTURE:capture}};return {root,capture,options,run:(request,response=ready,env={})=>execute(root,request,{...options,env:{...options.env,FAKE_PLANNING:JSON.stringify(response),...env}})};}
test('Codex questions persist and block review/approval; resume displays pending cards without another call',async t=>{
 const p=fixture(t),s=await p.run({action:'new',task:'login',text:'增加登录'},clarify);
 assert.equal(s.phase,'awaiting-answers');assert.equal(s.pendingQuestions.questions[0].question,question.question);
 await assert.rejects(p.run({action:'approve'}),/questions|clarification/i);
 await assert.rejects(p.run({action:'review-start',kind:'plan'}),/questions|clarification/i);
 const resumed=await p.run({action:'resume'});assert.equal(resumed.pendingQuestions.id,s.pendingQuestions.id);
 assert.equal(fs.readFileSync(p.capture,'utf8').trim().split('\n').length,1);
});
test('answer preserves exact user text, resumes UUID and produces a reviewable plan',async t=>{
 const p=fixture(t),s=await p.run({action:'new',task:'login',text:'增加登录'},clarify);
 const answer='邮箱，但仅允许公司域名；不要手机号';
 const done=await p.run({action:'answer',roundId:s.pendingQuestions.id,answers:[{id:'login',answer}]});
 assert.equal(done.phase,'planned');assert.equal(done.pendingQuestions,null);
 assert.equal(done.questionHistory[0].answers[0].answer,answer);
 const calls=fs.readFileSync(p.capture,'utf8').trim().split('\n').map(JSON.parse);
 assert.ok(calls[1].args.includes('resume'));assert.ok(calls[1].text.includes(answer));
 assert.ok(fs.readFileSync(done.paths.questions,'utf8').includes(answer));
 await p.run({action:'review-start',kind:'plan'});
 await assert.rejects(p.run({action:'answer',roundId:s.pendingQuestions.id,answers:[{id:'login',answer}]}),/pending|stale/i);
});
test('missing answers remain pending and a failed delivery can retry saved answers without asking again',async t=>{
 const p=fixture(t),s=await p.run({action:'new',task:'login',text:'增加登录'},clarify);
 await assert.rejects(p.run({action:'answer',roundId:s.pendingQuestions.id,answers:[]}),/answer/i);
 const request={action:'answer',roundId:s.pendingQuestions.id,answers:[{id:'login',answer:'邮箱'}]};
 await assert.rejects(p.run(request,ready,{FAKE_FAIL:'1'}),/failed/);
 const status=await p.run({action:'resume'});assert.equal(status.pendingQuestions.answers[0].answer,'邮箱');
 const done=await p.run(request);assert.equal(done.questionHistory.length,1);assert.equal(done.pendingQuestions,null);
});
test('malformed structured planning output is not treated as a completed plan',async t=>{
 const p=fixture(t);
 await assert.rejects(p.run({action:'new',task:'login',text:'增加登录'},ready,{FAKE_RAW_RESPONSE:'not JSON'}),/planning response/i);
 await assert.rejects(p.run({action:'approve'}),/completed plan|incomplete/i);
});
test('duplicate question text cannot create ambiguous native card answer mappings',async t=>{
 const p=fixture(t),response={...clarify,questions:[question,{...question,id:'different'}]};
 await assert.rejects(p.run({action:'new',task:'login',text:'增加登录'},response),/unique question text/);
});
test('asking Codex to explain options preserves the pending question and does not invent an answer',async t=>{
 const p=fixture(t),s=await p.run({action:'new',task:'login',text:'增加登录'},clarify);
 const explained=await p.run({action:'clarify',text:'先解释邮箱和手机的成本差异'});
 assert.equal(explained.pendingQuestions.id,s.pendingQuestions.id);
 assert.equal(explained.pendingQuestions.answers,undefined);
 await assert.rejects(p.run({action:'approve'}),/questions|clarification/i);
});
test('partial answers survive interruption without calling Codex before all answers are available',async t=>{
 const p=fixture(t),response={...clarify,questions:[question,{...question,id:'register',question:'是否需要注册？'}]};
 const first=await p.run({action:'new',task:'login',text:'增加登录'},response);
 await p.run({action:'record-answers',roundId:first.pendingQuestions.id,answers:[{id:'login',answer:'邮箱'}]});
 const resumed=await p.run({action:'resume'});assert.equal(resumed.pendingQuestions.partialAnswers[0].answer,'邮箱');
 assert.equal(fs.readFileSync(p.capture,'utf8').trim().split('\n').length,1);
 await assert.rejects(p.run({action:'answer',roundId:first.pendingQuestions.id,answers:resumed.pendingQuestions.partialAnswers}),/every pending/);
 const staged=await p.run({action:'record-answers',roundId:first.pendingQuestions.id,answers:[{id:'register',answer:'需要'}]});
 const ready=await p.run({action:'answer',roundId:first.pendingQuestions.id,answers:staged.pendingQuestions.partialAnswers});
 assert.equal(ready.phase,'planned');assert.equal(ready.questionHistory[0].answers.length,2);
});
