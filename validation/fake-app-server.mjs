// Offline JSON-RPC stand-in for `codex app-server`. Scenario comes from FAKE_SCENARIO (JSON).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {fixtureContract,fixtureResult} from './fixture-goals.mjs';
const scenario=JSON.parse(process.env.FAKE_SCENARIO||'{}');
const capture=m=>{if(process.env.FAKE_CAPTURE){fs.mkdirSync(path.dirname(process.env.FAKE_CAPTURE),{recursive:true});fs.appendFileSync(process.env.FAKE_CAPTURE,JSON.stringify(m)+'\n');}};
const send=m=>process.stdout.write(JSON.stringify(m)+'\n');
const note=(method,params)=>send({method,params});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let thread=process.env.FAKE_THREAD||'12345678-1234-4234-8234-123456789abc',nextId=0,interrupted=false;
const turnId='turn-1',waiting=new Map();
const ask=(method,params)=>new Promise(resolve=>{const id=nextId++;waiting.set(id,resolve);send({method,id,params:{threadId:thread,turnId,itemId:'item-1',startedAtMs:1,...params}});
  if(scenario.withdrawAfter)setTimeout(()=>{if(waiting.has(id)){note('serverRequest/resolved',{threadId:thread,requestId:id});waiting.delete(id);resolve({withdrawn:true});}},scenario.withdrawAfter);
});
const policies={'read-only':{type:'readOnly',networkAccess:false},'workspace-write':{type:'workspaceWrite',writableRoots:[],networkAccess:true,excludeTmpdirEnvVar:true,excludeSlashTmp:true}};
async function turn(params){
  note('turn/started',{threadId:thread,turn:{id:turnId,status:'inProgress',items:[],error:null}});
  for(const step of scenario.steps||[]){
    if(step.delay){for(let t=0;t<step.delay&&!interrupted;t+=20)await sleep(20);}
    if(step.error)note('error',{threadId:thread,turnId,willRetry:!!step.willRetry,error:{message:step.error,codexErrorInfo:null,additionalDetails:null}});
    if(step.note)note(step.note,{threadId:thread,turnId,...step.params});
    if(step.grandchild){const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(step.grandchild,String(c.pid));}
    // Like a plugin update Codex leaves behind: outlives Codex and keeps its output pipes open.
    if(step.leftover){const c=spawn(process.execPath,['-e','setTimeout(()=>{},40000)'],{cwd:os.tmpdir(),stdio:['ignore','inherit','inherit'],detached:true,windowsHide:true});c.unref();fs.writeFileSync(step.leftover,String(c.pid));}
    if(step.ignoreInterrupt)await new Promise(()=>setInterval(()=>{},1000));
    if(step.write)fs.writeFileSync(step.write,step.content||'written');
    if(step.exit!==undefined)process.exit(step.exit);
    if(step.request){const response=await ask(step.request,step.params||{});capture({kind:'approval-response',method:step.request,response});note('serverRequest/resolved',{threadId:thread,requestId:nextId-1});}
    if(interrupted)break;
  }
  if(interrupted){note('turn/completed',{threadId:thread,turn:{id:turnId,status:'interrupted',items:[],error:null}});return;}
  if(scenario.turnStatus){note('turn/completed',{threadId:thread,turn:{id:turnId,status:scenario.turnStatus,items:[],error:{message:scenario.turnError||'fixture turn failed'}}});return;}
  const schema=params.outputSchema;
  const answer=scenario.answer??(schema?.properties?.outcome?JSON.stringify(fixtureResult):schema?.properties?.findings?JSON.stringify({verdict:'approve',summary:'可以实施',findings:[],openQuestions:[],report:'# 评审\n可以实施。'}):schema?JSON.stringify({status:'ready',plan:'# Plan\nDo it.',questions:[],contract:fixtureContract}):'# Recap');
  note('item/completed',{threadId:thread,turnId,item:{type:'agentMessage',id:'m0',text:'working',phase:'commentary'}});
  note('item/completed',{threadId:thread,turnId,item:{type:'agentMessage',id:'m1',text:answer,phase:'final_answer'}});
  note('turn/completed',{threadId:thread,turn:{id:turnId,status:'completed',items:[],error:null}});
}
let buffer='';
process.stdin.setEncoding('utf8');
process.stdin.on('end',()=>process.exit(0));
process.stdin.on('data',chunk=>{
  buffer+=chunk;let i;
  while((i=buffer.indexOf('\n'))>=0){
    const line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(!line.trim())continue;
    const m=JSON.parse(line);
    if(m.method===undefined){waiting.get(m.id)?.(m.error?{error:m.error}:m.result);waiting.delete(m.id);continue;}
    capture({kind:'request',method:m.method,params:m.params,argv:process.argv.slice(2)});
    if(m.id===undefined)continue;
    const ok=result=>send({id:m.id,result});
    if(m.method==='initialize')setTimeout(()=>ok({userAgent:'fake',platformFamily:'x',platformOs:'x'}),scenario.initializeDelay||0);
    else if(m.method==='thread/start'||m.method==='thread/resume'){
      if(scenario.threadError){send({id:m.id,error:{code:-32600,message:scenario.threadError}});continue;}
      if(m.method==='thread/resume'&&scenario.lostThread){send({id:m.id,error:{code:-32600,message:`no rollout found for thread id ${m.params.threadId}`}});continue;}
      const id=m.method==='thread/resume'&&!process.env.FAKE_THREAD?m.params.threadId:scenario.newThread||thread;thread=id;
      setTimeout(()=>ok({thread:{id},model:'fake-model',approvalPolicy:m.params.approvalPolicy,approvalsReviewer:scenario.forceReviewer||m.params.approvalsReviewer,sandbox:scenario.forceSandbox||policies[m.params.sandbox]}),scenario.threadDelay||0);
    }else if(m.method==='turn/start'){setTimeout(()=>ok({turn:{id:turnId,status:'inProgress',items:[],error:null}}),scenario.turnResponseDelay||0);turn(m.params);}
    else if(m.method==='turn/interrupt'){ok({});interrupted=true;}
    else if(m.method==='turn/steer')ok({turnId});
    else send({id:m.id,error:{code:-32601,message:'unknown '+m.method}});
  }
});
