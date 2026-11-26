// Runtime Q&A has a separate durable journal: never rewrite the worker's task state.json.
import fs from 'node:fs';
import path from 'node:path';
import {atomicJson,readJson,withPending,requireOwner,interactionLock} from './control-store.mjs';
const journalFile=(run,id)=>path.join(run.dir,'interactions',`${id}.json`);
export function initRuntimeInput(run,record){
  atomicJson(journalFile(run,record.id),{id:record.id,runId:record.runId,questions:record.details.questions,createdAt:record.createdAt,
    status:'pending',partialAnswers:[],history:[]});
}
export function runtimeInputView(run,record){
  const saved=readJson(journalFile(run,record.id));
  const partialAnswers=saved?.partialAnswers||[];
  return {id:record.id,questions:record.details.questions,partialAnswers,
    unansweredQuestionIds:record.details.questions.filter(q=>!partialAnswers.some(a=>a.id===q.id)).map(q=>q.id)};
}
function mergeAnswers(saved,answers){
  if(!Array.isArray(answers)||!answers.length)throw Error('至少提交一项真实回答；空白、取消或跳过不算回答。');
  const seen=new Set();
  for(const a of answers){
    if(!a||!saved.questions.some(q=>q.id===a.id)||seen.has(a.id)||typeof a.answer!=='string'||!a.answer.trim())throw Error('回答必须对应现有问题，不能重复、缺失或为空。');
    seen.add(a.id);
  }
  for(const a of answers){
    const previous=saved.partialAnswers.find(x=>x.id===a.id);
    if(previous?.answer===a.answer)continue;
    saved.history.push({id:a.id,answer:a.answer,previous:previous?.answer??null,at:new Date().toISOString()});
    if(previous)previous.answer=a.answer;else saved.partialAnswers.push({id:a.id,answer:a.answer});
  }
  saved.partialAnswers.sort((a,b)=>saved.questions.findIndex(q=>q.id===a.id)-saved.questions.findIndex(q=>q.id===b.id));
}
export function recordRuntimeAnswers(root,{id,answers,sessionId,submit=false}){
  return withPending(root,id,({run,record})=>{
    requireOwner(run,sessionId);
    if(record.kind!=='user-input')throw Error('该请求不是问答。');
    let saved=readJson(journalFile(run,id));
    if(!saved){initRuntimeInput(run,record);saved=readJson(journalFile(run,id));} // pending request from a pre-upgrade run
    if(submit&&answers!==undefined&&(!Array.isArray(answers)||answers.length!==saved.questions.length))throw Error('必须逐题提交真实回答，不能缺失或重复。');
    if(answers!==undefined)mergeAnswers(saved,answers);
    if(submit&&saved.questions.some(q=>!saved.partialAnswers.some(a=>a.id===q.id)))throw Error('仍有未回答问题，请先保存其真实回答。');
    if(!submit&&answers===undefined)throw Error('至少提交一项真实回答。');
    atomicJson(journalFile(run,id),saved);
    if(submit){
      atomicJson(path.join(run.dir,'decisions',`${id}.json`),{action:'answer',answers:saved.partialAnswers,sessionId,at:new Date().toISOString()});
      // Do not introduce a second fallible write after the decision commits. The worker records completion.
    }
    return {run,record,userInput:runtimeInputView(run,record)};
  });
}
// Called by the worker while holding the interaction lock, including cancellation and withdrawal.
export function settleRuntimeInput(run,record,decision,why){
  if(record.kind!=='user-input')return;
  let saved=readJson(journalFile(run,record.id));
  if(!saved){initRuntimeInput(run,record);saved=readJson(journalFile(run,record.id));}
  if(decision?.action==='answer')saved.partialAnswers=decision.answers;
  saved.status=decision?.action==='answer'?'answered':'unanswered';
  saved.reason=why||null;saved.finishedAt=new Date().toISOString();
  atomicJson(journalFile(run,record.id),saved);
}
// Only after successful archive may the external records be removed by waitRun.
export function archiveRuntimeInputs(run,{locked=false,interrupted=false}={}){
  const archive=()=>{
    const folder=path.join(run.dir,'interactions');if(!fs.existsSync(folder))return null;
    const entries=fs.readdirSync(folder).filter(f=>f.endsWith('.json')).sort().map(f=>readJson(path.join(folder,f))).filter(Boolean);
    if(!entries.length)return null;
    if(interrupted)for(const entry of entries)if(entry.status==='pending'){
      entry.status='unanswered';entry.reason='worker 异常退出；执行结果未知，不代表已提交答案。';entry.finishedAt=new Date().toISOString();
    }
    const task=readJson(path.join(run.dir,'task.json'));
    if(!task?.taskDir)throw Error('运行问答尚无可用任务归档路径；外部记录已保留。');
    if(!fs.statSync(task.taskDir).isDirectory())throw Error('运行问答归档目录不可用。');
    const file=path.join(task.taskDir,`${run.id}.runtime-questions.json`);
    atomicJson(file,{format:1,runId:run.id,task:task.task,entries});
    return file;
  };
  return locked?archive():interactionLock(run,archive);
}
export function runtimeHistory(taskDir){
  return fs.readdirSync(taskDir).filter(f=>/^[a-z0-9-]+\.runtime-questions\.json$/i.test(f)).sort().map(f=>readJson(path.join(taskDir,f))).filter(Boolean);
}
