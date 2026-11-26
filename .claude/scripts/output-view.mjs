// What the runner prints for Claude. Saved state and files keep everything; this only avoids flooding the
// tool output, which made callers pipe the command through filters and miss notices.
import fs from 'node:fs';
import path from 'node:path';
const PLANNING=['new','plan','revise-plan','answer'];
const RESULT_LIMIT=6000,REQUIREMENTS_LIMIT=2000,SAMPLE=20,DELIVERY_LIMIT=8000,ITEMS=20,TEXT=300,EVIDENCE=3;
const FIRST=['runState','permissionNotice','reviewNotice','warnings','archiveWarning','archiveWarnings','note'];
const cut=(text,limit,where)=>typeof text==='string'&&text.length>limit?`${text.slice(0,limit)}…（其余 ${text.length-limit} 个字符未显示，见 ${where}）`:text;
const depth=p=>p.split('/').length;
function changes(list){
  const byChange={};for(const c of list)byChange[c.change]=(byChange[c.change]||0)+1;
  return {total:list.length,byChange,sample:[...list].sort((a,b)=>depth(a.path)-depth(b.path)).slice(0,SAMPLE).map(c=>({path:c.path,change:c.change}))};
}
function brief(value){
  if(typeof value==='string')return value.length>TEXT?`${value.slice(0,TEXT)}…（共 ${value.length} 字符）`:value;
  if(Array.isArray(value))return value.slice(0,EVIDENCE).map(brief);
  return value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,brief(v)])):value;
}
// Problems are kept ahead of finished items when not everything fits; the original order is preserved.
function briefList(list){
  const settled=i=>['completed','passed'].includes(list[i]?.status),order=list.map((_,i)=>i);
  const kept=new Set([...order.filter(i=>!settled(i)),...order.filter(settled)].slice(0,ITEMS));
  return list.filter((_,i)=>kept.has(i)).map(brief);
}
function shorten(record,fullRecord){
  const lists=['deliverables','verification','unfinished'].filter(k=>Array.isArray(record[k]));
  const size=[...lists,'changeExplanation'].reduce((sum,k)=>sum+(JSON.stringify(record[k])?.length||0),0);
  if(!fullRecord||size<=DELIVERY_LIMIT)return {};
  return {...Object.fromEntries(lists.map(k=>[k,briefList(record[k])])),changeExplanation:brief(record.changeExplanation),
    shortened:{totals:Object.fromEntries(lists.map(k=>[k,record[k].length])),fullRecord}};
}
function deliveryView({changes:list,...rest},taskDir,stateFile){
  const detail=taskDir&&rest.runId?path.join(taskDir,`${rest.runId}.delivery.json`):null,detailFile=detail&&fs.existsSync(detail)?detail:null;
  return {...rest,...shorten(rest,detailFile||stateFile),...(Array.isArray(list)?{changesSummary:changes(list)}:{}),...(detailFile?{detailFile}:{})};
}
export function compactView(result){
  if(!result||typeof result!=='object'||Array.isArray(result))return result;
  const out={...result},taskDir=result.paths?.task,stateFile=taskDir?path.join(taskDir,'state.json'):null;
  if(stateFile)out.stateFile=stateFile;
  if(out.delivery)out.delivery=deliveryView(out.delivery,taskDir,stateFile);
  if(out.executionSummary){const {delivery,...summary}=out.executionSummary;out.executionSummary=summary;}
  // executionSummary carries the same contract.
  if(out.plan?.contract&&out.executionSummary?.deliverables){const {contract,...plan}=out.plan;out.plan=plan;}
  if(Array.isArray(out.reviewHistory))out.reviewHistory={count:out.reviewHistory.length,file:result.paths?.reviewQuestions};
  if(Array.isArray(out.questionHistory))out.questionHistory={count:out.questionHistory.length,file:result.paths?.questions};
  if(Array.isArray(out.runHistory))out.runHistory={count:out.runHistory.length,
    recent:out.runHistory.slice(-3).map(({id,action,status,startedAt,finishedAt,error})=>({id,action,status,startedAt,finishedAt,...(error?{error}:{})}))};
  if(out.reviewSession?.draft){const {text,...draft}=out.reviewSession.draft;out.reviewSession={...out.reviewSession,draft:{saved:true,characters:text?.length??0,...draft}};}
  if(stateFile)out.requirements=cut(out.requirements,REQUIREMENTS_LIMIT,stateFile);
  const resultFile=result.lastRun?.result;
  if(typeof out.result==='string'&&resultFile){
    if(PLANNING.includes(result.lastRun.action)){delete out.result;out.resultFile=resultFile;}
    else if(out.result.length>RESULT_LIMIT){out.result=cut(out.result,RESULT_LIMIT,resultFile);out.resultFile=resultFile;}
  }
  const ordered={};
  for(const key of [...FIRST,...Object.keys(out)])if(out[key]!==undefined)ordered[key]=out[key];
  return ordered;
}
