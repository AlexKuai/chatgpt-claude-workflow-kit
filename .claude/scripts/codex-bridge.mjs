// Runs one Codex turn over app-server and routes its approval requests to Claude Code.
// Rule: anything unknown, unverifiable or not fully displayable is declined, never approved.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {AppServerClient} from './app-server-client.mjs';
import {atomicJson,readJson,controlDir,runDir,listRuns,runFinished,pendingItems,findPending,pidAlive,validId,recordDigest,
  verifyGate,kitFingerprint,changedKitFiles,approvalRouting,describe,displayText,within,COMMAND_LIMIT,scriptsDir,
  withPending,interactionLock,ownership,requireOwner} from './control-store.mjs';
import {initRuntimeInput,runtimeInputView,settleRuntimeInput,archiveRuntimeInputs} from './runtime-questions.mjs';

const VERSION='2026-11-26';
const APPROVAL_TIMEOUT=30*60*1000;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const stages={implement:'实现阶段',fix:'修改阶段'};
const rpcError=(code,message)=>Object.assign(new Error(message),{rpcCode:code});

// Only Codex's explicit answer about this very conversation counts; any other failure stays an ordinary failure.
export function threadError(error,threadId){
  const text=error.message;
  if(text.includes(`no rollout found for thread id ${threadId}`))return Object.assign(new Error(`Codex 中找不到本任务的会话（UUID ${threadId}），可能已在 Codex 或 ChatGPT 应用中删除。没有启动执行，任务状态已还原：计划、批准、评审和已保存的回答都在。请运行 /chatgpt-resume，选择重建 Codex 会话，或在 Codex 中找回后重试原会话。原始错误：${text}`),{threadLost:true});
  if(/already has an active writer/.test(text))return new Error(`本任务的 Codex 会话正被占用，没有启动执行。请关闭 Codex 或 ChatGPT 应用中打开的这个会话后重试。原始错误：${text}`);
  return error;
}
// Called once Codex really uses the conversation: an unchanged one was not lost, a rebuilt one replaces the old.
export function useThread(state,threadId){
  if(state.threadId&&state.threadId!==threadId)state.threadHistory=[...(state.threadHistory||[]),{threadId:state.threadId,replacedAt:new Date().toISOString(),reason:'deleted-outside-workflow'}];
  state.threadId=threadId;delete state.threadLost;
}

export async function runAppServer({root,dir,state,request,command,env,persist,runId,log,stderrFile,schema,writing,bridge,settings={}}){
  const routing=bridge?approvalRouting(bridge.permissionMode,settings):{approvalPolicy:'on-request',approvalsReviewer:'user',route:'decline'};
  const stage=stages[request.action]||'规划阶段（只读沙箱）';
  const audit=[],items=new Map(),open=new Map(),handlers=new Set();
  const auditEntry=e=>{audit.push({at:new Date().toISOString(),...e});};
  const event=e=>fs.appendFileSync(log,JSON.stringify(e)+'\n');
  const raw=path.join(dir,`${runId}.rpc.jsonl`);
  const kitBefore=kitFingerprint(root);
  let client,turnId=null,threadId=null,answer='',seq=0,controlSafe=true,cancelled=false,finishTurn,lastProgress=0;
  let turnRequested=false,turnCompleted=false,interruptedAt=0,interruptSent=false,closing=false;
  const cancellationError=()=>new Error(turnRequested?'本次执行已按用户要求取消；可能已有部分修改。':'本次执行已在启动回合前取消，未启动执行回合。');
  // For event handlers, where an exception would end this worker and leave Codex running unattended. The state stays
  // in memory: the run's own next save stores it or fails the run in order.
  const persistLater=()=>{try{persist();}catch{/* see above */}};
  function checkCancellation(){
    if(!bridge||turnCompleted)return;
    if(!cancelled&&fs.existsSync(path.join(bridge.dir,'cancel.json'))){
      cancelled=true;interruptedAt=Date.now();
      state.lastRun.cancellation={phase:turnRequested?'after-start':'before-start',at:new Date().toISOString()};persistLater();
      progress(turnRequested?'正在取消；可能已有部分修改':'正在取消启动',true);
    }
    if(!cancelled||!client)return;
    if(!turnRequested&&!closing){closing=true;client.close().catch(()=>client.kill());}
    if(turnRequested&&turnId&&!interruptSent){interruptSent=true;client.request('turn/interrupt',{threadId,turnId},15000).catch(()=>{});}
    if(Date.now()-interruptedAt>(bridge.cancelGraceMs??10000))client.kill();
  }
  function beforeRequest(){checkCancellation();if(cancelled)throw cancellationError();}
  const turnDone=new Promise(resolve=>{finishTurn=resolve;});
  const progress=(text,force)=>{
    if(!bridge||(!force&&Date.now()-lastProgress<1000))return;
    lastProgress=Date.now();
    try{atomicJson(path.join(bridge.dir,'progress.json'),{at:new Date().toISOString(),text:displayText(text,300)});}catch{/* progress is best effort */}
  };
  const declineAll=()=>{
    if(!bridge)return '当前调用没有审批通道';
    if(cancelled)return '本次执行已取消';
    if(!controlSafe)return '审批控制目录位于 Codex 可写范围内，无法安全审批';
    if(routing.route==='decline')return bridge.permissionMode?`Claude Code 模式 ${bridge.permissionMode} 不交互审批`:'未取得 Claude Code 权限模式（权限 hook 未生效）';
    return null;
  };
  async function waitDecision(record,rpcId){
    record.expiresAt=Date.now()+(bridge.approvalTimeoutMs??APPROVAL_TIMEOUT);
    record.digest=recordDigest(record);
    const pendingFile=path.join(bridge.dir,'pending',`${record.id}.json`),decisionFile=path.join(bridge.dir,'decisions',`${record.id}.json`);
    const run={dir:bridge.dir,id:bridge.runId};
    if(record.kind==='user-input')initRuntimeInput(run,record);
    open.set(rpcId,record.id);atomicJson(pendingFile,record);
    let decision=null,why=null;
    while(!decision&&!why){
      interactionLock(run,()=>{
        decision=readJson(decisionFile);
        if(!decision){
          if(cancelled)why='已取消';
          else if(!open.has(rpcId))why='Codex 已撤回该请求';
          else if(client.exited)why='Codex 进程已结束';
          else if(Date.now()>=record.expiresAt)why='等待确认超时';
        }
        if(decision||why){
          settleRuntimeInput(run,record,decision,why);
          atomicJson(path.join(bridge.dir,'handled',`${record.id}.json`),{record,decision,why,at:new Date().toISOString()});
          fs.rmSync(pendingFile,{force:true});
        }
      });
      if(!decision&&!why)await sleep(150);
    }
    open.delete(rpcId);
    return {decision,why};
  }
  async function approve(rpcId,method,title,details){
    const base={type:'approval',method,title,details};
    const refuse=why=>{auditEntry({...base,result:'declined',by:'kit',why});progress(`已拒绝：${title}（${why}）`,true);return {accept:false};};
    const blocked=declineAll();if(blocked)return refuse(blocked);
    if(!details.command&&!details.network&&!details.files?.length&&!details.permissions&&!details.server)return refuse('请求没有可展示的内容');
    const shown=v=>displayText(v,Infinity).length;
    if(shown(details.command)>COMMAND_LIMIT||shown(details.permissions)>1500||shown(details.message)>1000||shown(details.cwd)>400||shown(details.network)>400||(details.files||[]).some(f=>shown(f.path)>380)||details.moreFiles)
      return refuse('请求内容过长，无法在权限框完整展示；请拆分为更小的操作');
    const record={id:crypto.randomUUID(),seq:seq++,kind:'approval',runId:bridge.runId,method,title,task:state.task,action:request.action,stage,details,createdAt:new Date().toISOString()};
    progress(`等待确认：${title}`,true);
    const {decision,why}=await waitDecision(record,rpcId);
    if(!decision)return refuse(why);
    if(decision.action!=='accept'){
      auditEntry({...base,result:'declined',by:'user',feedback:decision.feedback||null});
      if(decision.feedback&&turnId)client.request('turn/steer',{threadId,expectedTurnId:turnId,input:[{type:'text',text:`The user declined your last permission request and said: ${decision.feedback}`,text_elements:[]}]},30000).catch(e=>auditEntry({type:'steer-failed',error:e.message}));
      return {accept:false};
    }
    const scope=decision.scope==='run'?'run':'once';
    if(decision.digest!==record.digest||!verifyGate(root,decision.gate,{approvalId:record.id,digest:record.digest,scope,owner:decision.owner}))return refuse('批准记录未通过核验');
    const changed=changedKitFiles(kitBefore,kitFingerprint(root));
    if(changed.length)return refuse(`工作流脚本或权限配置在执行期间被修改：${changed.map(f=>path.relative(root,f)).join('、')}。${changed.some(f=>path.basename(f)==='settings.local.json')?'settings.local.json 可能是权限框选了“始终允许”，也可能是 Codex 改的；':''}请核对后重新执行`);
    auditEntry({...base,result:'approved',by:'user',scope});
    return {accept:true,scope};
  }
  async function onRequest(m){
    const p=m.params||{};
    switch(m.method){
      case 'item/commandExecution/requestApproval':{
        const n=p.networkApprovalContext;
        const r=await approve(m.id,m.method,p.kind==='writeStdin'?'向运行中的终端写入':n?'访问网络':'在沙箱外执行命令',
          {command:p.command||undefined,cwd:p.cwd||undefined,reason:p.reason||undefined,network:n?`${n.protocol||''} ${n.host||''}`.trim():undefined});
        return {decision:r.accept?(r.scope==='run'?'acceptForSession':'accept'):'decline'};
      }
      case 'item/fileChange/requestApproval':{
        const changes=items.get(p.itemId)?.changes||[];
        if(!writing){auditEntry({type:'approval',method:m.method,title:'修改文件',details:{files:changes.map(c=>({kind:c.kind?.type,path:c.path}))},result:'declined',by:'kit',why:'规划阶段不允许修改文件'});return {decision:'decline'};}
        const files=changes.slice(0,20).map(c=>({kind:({add:'新增',delete:'删除',update:'修改'})[c.kind?.type]||'变更',path:c.path}));
        const r=await approve(m.id,m.method,'修改沙箱外文件',{files,moreFiles:Math.max(0,changes.length-20),reason:p.reason||undefined,message:p.grantRoot?`同时申请本会话写入目录：${p.grantRoot}`:undefined});
        return {decision:r.accept?(r.scope==='run'?'acceptForSession':'accept'):'decline'};
      }
      case 'item/permissions/requestApproval':{
        const r=await approve(m.id,m.method,'扩大权限',{permissions:JSON.stringify(p.permissions??{}),cwd:p.cwd||undefined,reason:p.reason||undefined});
        return r.accept?{permissions:p.permissions,scope:r.scope==='run'?'session':'turn'}:{permissions:{},scope:'turn'};
      }
      case 'mcpServer/elicitation/request':{
        const empty=p.mode==='form'&&!Object.keys(p.requestedSchema?.properties||{}).length;
        if(!empty){auditEntry({type:'approval',method:m.method,title:'MCP 表单',details:{server:p.serverName,message:p.message},result:'declined',by:'kit',why:`不支持的 MCP 请求（${p.mode}）`});return {action:'decline',content:null};}
        const meta=p._meta?JSON.stringify(p._meta):'';
        const r=await approve(m.id,m.method,'调用 MCP 工具',{server:p.serverName,message:[p.message,meta].filter(Boolean).join('\n')});
        return r.accept?{action:'accept',content:{}}:{action:'decline',content:null};
      }
      case 'item/tool/requestUserInput':{
        const questions=p.questions||[],give=why=>{auditEntry({type:'user-input',questions:questions.map(q=>q.question),result:'unanswered',why});return {answers:{}};};
        if(!bridge||cancelled)return give('没有交互通道');
        if(questions.some(q=>q.isSecret))return give('不通过工作流收集敏感信息');
        const record={id:crypto.randomUUID(),seq:seq++,kind:'user-input',runId:bridge.runId,method:m.method,title:'回答问题',task:state.task,action:request.action,stage,
          details:{questions:questions.map(q=>({id:q.id,header:q.header,question:q.question,options:q.options||[],multiSelect:false}))},createdAt:new Date().toISOString()};
        progress('等待回答 Codex 的问题',true);
        const {decision,why}=await waitDecision(record,m.id);
        if(decision?.action!=='answer')return give(why||'用户未回答');
        auditEntry({type:'user-input',questions:questions.map(q=>q.question),result:'answered',answers:decision.answers});
        return {answers:Object.fromEntries(decision.answers.map(a=>[a.id,{answers:[a.answer]}]))};
      }
      default:
        auditEntry({type:'unsupported-request',method:m.method});
        throw rpcError(-32601,`Unsupported server request: ${m.method}`);
    }
  }
  function onNotification(m){
    const p=m.params||{};
    if(p.threadId&&threadId&&p.threadId!==threadId)return; // subagent or reviewer threads
    if(m.method==='item/started'&&p.item){
      items.set(p.item.id,p.item);
      if(p.item.type==='commandExecution')progress(`执行命令：${p.item.command}`);
      else if(p.item.type==='fileChange')progress(`修改文件：${(p.item.changes||[]).map(c=>c.path).join('、')}`);
    }else if(m.method==='item/completed'&&p.item){
      if(p.item.type==='agentMessage'){
        if(p.item.phase==='commentary')progress(p.item.text);
        else answer=p.item.text||answer;
        event({type:'item.completed',item:{type:'agent_message',text:p.item.text,phase:p.item.phase}});
      }
    }else if(m.method==='serverRequest/resolved'){
      const id=open.get(p.requestId);
      if(id&&bridge)atomicJson(path.join(bridge.dir,'withdrawn',`${id}.json`),{at:new Date().toISOString()});
      open.delete(p.requestId);
    }
    else if(m.method==='item/autoApprovalReview/completed'){
      const r=p.review||{};
      auditEntry({type:'approval',method:m.method,title:p.action?.type||'自动审查',details:{command:p.action?.command,cwd:p.action?.cwd},result:r.status==='approved'?'approved':'declined',by:'auto-review',risk:r.riskLevel,why:r.rationale});
      progress(`自动审查 ${r.status}：${p.action?.command||p.action?.type||''}`,true);
    }else if(m.method==='error'){
      auditEntry({type:'error',willRetry:!!p.willRetry,message:p.error?.message});
      progress(p.willRetry?`连接中断，Codex 正在重试：${p.error?.message}`:`Codex 错误：${p.error?.message}`,true);
    }else if(m.method==='turn/started'&&p.turn?.id){turnId=p.turn.id;if(turnRequested&&threadId&&state.threadId!==threadId){useThread(state,threadId);persistLater();event({type:'thread.started',thread_id:threadId});}checkCancellation();}
    else if(m.method==='turn/completed'&&(!turnId||p.turn?.id===turnId)){turnCompleted=true;finishTurn(p.turn);}
  }
  const summary=()=>{
    const list=audit.filter(a=>a.type==='approval'),count=f=>list.filter(f).length;
    return {mode:bridge?.permissionMode??null,route:routing.route,approvedByUser:count(a=>a.result==='approved'&&a.by==='user'),approvedByAutoReview:count(a=>a.result==='approved'&&a.by==='auto-review'),
      declined:list.filter(a=>a.result==='declined').map(a=>({title:a.title,command:a.details?.command,files:a.details?.files,by:a.by,why:a.why||a.feedback||null})),
      kitFilesChanged:changedKitFiles(kitBefore,kitFingerprint(root)).map(f=>path.relative(root,f))};
  };
  bridge?.setTask?.(state.task,dir);
  let ticker;
  try{
    if(bridge)ticker=setInterval(checkCancellation,100);
    beforeRequest();
    client=new AppServerClient({command,cwd:root,env,onNotification,onRequest:m=>{
      const pending=onRequest(m);handlers.add(pending);pending.then(()=>handlers.delete(pending),()=>handlers.delete(pending));return pending;
    },
      onRaw:(direction,line)=>fs.appendFileSync(raw,JSON.stringify({direction,line})+'\n'),
      onStderr:chunk=>fs.appendFileSync(stderrFile,chunk)});
    state.lastRun.childPid=client.pid;persist();
    const died=client.exitPromise.then(e=>{throw e;});died.catch(()=>{});
    await Promise.race([client.initialize(VERSION),died]);
    beforeRequest();
    const params={cwd:root,sandbox:writing?'workspace-write':'read-only',approvalPolicy:routing.approvalPolicy,approvalsReviewer:routing.approvalsReviewer};
    const saved=request.rebuildThread?null:state.threadId;
    const started=saved?await client.request('thread/resume',{threadId:saved,excludeTurns:true,...params}).catch(e=>{throw threadError(e,saved);}):await client.request('thread/start',params);
    threadId=started.thread?.id;
    if(saved&&threadId!==saved)throw new Error('Codex resumed a different thread UUID.');
    if(!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(threadId||''))throw new Error('Codex emitted an invalid thread UUID.');
    // Effective settings can be overridden by managed policy; check what Codex reports, not what was asked.
    if(started.sandbox?.type!==(writing?'workspaceWrite':'readOnly'))throw new Error(`Codex 实际沙箱为 ${started.sandbox?.type}，与本阶段要求不符；已停止。`);
    const reviewer=started.approvalsReviewer==='guardian_subagent'?'auto_review':started.approvalsReviewer;
    if(reviewer!==routing.approvalsReviewer)throw new Error(`Codex 实际审批方为 ${started.approvalsReviewer}，与当前 Claude Code 模式不符；已停止。`);
    if(writing&&bridge){
      const roots=[root,...(started.sandbox.writableRoots||[]),...(started.runtimeWorkspaceRoots||[]),...(started.sandbox.excludeTmpdirEnvVar?[]:[os.tmpdir()])];
      controlSafe=!roots.some(r=>within(r,controlDir(root)));
    }
    beforeRequest();
    turnRequested=true;state.lastRun.turnRequested=true;persist();
    const turn=await Promise.race([
      client.request('turn/start',{threadId,input:[{type:'text',text:request.prompt,text_elements:[]}],...(schema?{outputSchema:schema}:{})}),
      turnDone.then(turn=>({turn})) // A terminal notification is authoritative even if the RPC reply is late.
    ]);
    turnId=turn.turn?.id||turnId;
    // A thread without a turn is not resumable, so its UUID is saved only now.
    useThread(state,threadId);state.lastRun.model=started.model||null;state.lastRun.permissionMode=bridge?.permissionMode??null;state.lastRun.approvalRoute=routing.route;persist();
    event({type:'thread.started',thread_id:threadId});
    checkCancellation();
    const result=await Promise.race([turnDone,died]);
    if(result.status!=='completed'){
      event({type:'turn.failed',error:{message:result.error?.message||result.status}});
      throw new Error(cancelled?'本次执行已按用户要求取消；可能已有部分修改。':`Codex failed (${result.status}): ${result.error?.message||'turn did not complete'}`);
    }
    event({type:'turn.completed'});
    if(!writing&&!answer.trim())throw new Error('Codex failed or incomplete: empty answer.');
    return answer;
  }catch(e){throw cancelled?cancellationError():e;}
  finally{
    clearInterval(ticker);
    if(turnCompleted)progress('Codex 已完成，正在收尾',true);
    if(client){await client.close();if(client.leftover)state.lastRun.leftoverProcesses=true;}
    await Promise.allSettled([...handlers]);
    state.lastRun.approvals=summary();
    if(audit.length)state.lastRun.approvalLog=path.join(dir,`${runId}.approvals.jsonl`);
    if(audit.length)fs.writeFileSync(state.lastRun.approvalLog,audit.map(a=>JSON.stringify(a)).join('\n')+'\n',{mode:0o600});
  }
}

// ---------------- foreground side: start, wait, decide ----------------
export function startRun(root,request,{permissionMode}){
  prune(root);
  const id=crypto.randomUUID(),dir=runDir(root,id);
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  atomicJson(path.join(dir,'request.json'),{request,permissionMode});
  const out=fs.openSync(path.join(dir,'worker.log'),'a');
  const child=spawn(process.execPath,[path.join(scriptsDir,'chatgpt-workflow.mjs'),'--worker',id],{cwd:root,detached:true,stdio:['ignore',out,out],windowsHide:true});
  fs.closeSync(out);child.unref();
  const meta={pid:child.pid,sessionId:request.sessionId,action:request.action,permissionMode,startedAt:Date.now()};
  atomicJson(path.join(dir,'worker.json'),meta);
  return {id,dir,meta};
}
function prune(root){
  for(const r of listRuns(root))if(fs.existsSync(path.join(r.dir,'delivered'))&&!fs.existsSync(path.join(r.dir,'interactions'))&&!readJson(path.join(r.dir,'outcome.json'))?.archiveWarning&&Date.now()-r.meta.startedAt>14*86400000)fs.rmSync(r.dir,{recursive:true,force:true});
}
export async function runWorker(root,id,execute){
  const dir=runDir(root,id),file=path.join(dir,'request.json');
  const saved=readJson(file);if(!saved)throw new Error('Worker request is missing.');
  fs.rmSync(file); // requirements text is kept only in the project's task directory
  let outcome;
  try{
    if(cancelRequested(dir))throw Error('本次执行已在启动回合前取消，未启动执行回合。');
    const bridge={dir,runId:id,permissionMode:saved.permissionMode,setTask:(task,taskDir)=>atomicJson(path.join(dir,'task.json'),{task,taskDir})};
    outcome={ok:true,result:await execute(root,saved.request,{bridge})};
  }catch(e){outcome={ok:false,error:e.message};}
  try{archiveRuntimeInputs({dir,id});}catch(e){outcome.archiveWarning=`运行问答归档失败，外部记录已保留：${e.message}`;}
  atomicJson(path.join(dir,'outcome.json'),outcome);
}
const runOwner=r=>ownership(r).sessionId;
const runTask=r=>readJson(path.join(r.dir,'task.json'))?.task||null;
const runAlive=r=>!runFinished(r.dir)&&pidAlive(r.meta.pid);
// A run belongs to the session that started it, or to a session explicitly bound to its task.
export function sessionRun(root,sessionId,boundTask,{adopt=false}={}){
  const runs=listRuns(root).filter(r=>runOwner(r)===sessionId||(boundTask&&runTask(r)===boundTask)).sort((a,b)=>b.meta.startedAt-a.meta.startedAt);
  const run=runs.find(r=>runAlive(r))||runs.find(r=>!fs.existsSync(path.join(r.dir,'delivered')))||null;
  if(run&&adopt)interactionLock(run,()=>{
    const owner=ownership(run);
    if(owner.sessionId!==sessionId)atomicJson(path.join(run.dir,'owner.json'),{sessionId,revision:(owner.revision||0)+1,at:new Date().toISOString()});
  });
  return run;
}
export const isActive=runAlive;
export function ownsRun(run,sessionId){return runOwner(run)===sessionId;}
export function runSummary(run){
  const pending=undecided(run.dir);
  return {runId:run.id,action:run.meta.action,task:runTask(run),owner:ownership(run),permissionMode:run.meta.permissionMode,alive:runAlive(run),progress:readJson(path.join(run.dir,'progress.json')),
    pending:pending.map(p=>({id:p.id,kind:p.kind,title:p.title,createdAt:p.createdAt,...(p.kind==='user-input'?{userInput:runtimeInputView(run,p)}:{})}))};
}
const cancelRequested=dir=>fs.existsSync(path.join(dir,'cancel.json'));
const undecided=dir=>cancelRequested(dir)?[]:pendingItems(dir).filter(p=>!['decisions','withdrawn'].some(n=>fs.existsSync(path.join(dir,n,`${p.id}.json`))));
function finishRun(run){
  return interactionLock(run,()=>{
    const outcome=readJson(path.join(run.dir,'outcome.json'));
    let archiveWarning;
    try{archiveRuntimeInputs(run,{locked:true});}catch(e){archiveWarning='运行问答归档失败，外部记录已保留：'+e.message;}
    if(!archiveWarning)for(const name of ['handled','decisions','pending','progress.json','interactions','withdrawn'])fs.rmSync(path.join(run.dir,name),{recursive:true,force:true});
    atomicJson(path.join(run.dir,'outcome.json'),{ok:outcome.ok,delivered:true,...(outcome.ok?{}:{error:outcome.error}),...(archiveWarning?{archiveWarning}:{})});
    fs.writeFileSync(path.join(run.dir,'delivered'),'');
    return {...outcome,archiveWarning};
  });
}
function stoppedRunProcesses(run){
  if(pidAlive(run.meta.pid))return false;
  const task=readJson(path.join(run.dir,'task.json'));
  const state=task?.taskDir?readJson(path.join(task.taskDir,'state.json')):null;
  return !pidAlive(state?.lastRun?.childPid);
}
export function retryRunArchives(root,task){
  const warnings=[];
  for(const run of listRuns(root))if(runTask(run)===task&&fs.existsSync(path.join(run.dir,'interactions'))){
    const saved=readJson(path.join(run.dir,'outcome.json'));
    if(saved?.delivered){const outcome=finishRun(run);if(outcome.archiveWarning)warnings.push(outcome.archiveWarning);}
    else if(!saved&&!pidAlive(run.meta.pid)){
      if(!stoppedRunProcesses(run)){warnings.push('运行进程状态不明，问答暂存已保留；请先检查 Codex 子进程。');continue;}
      try{interactionLock(run,()=>{
        archiveRuntimeInputs(run,{locked:true,interrupted:true});
        for(const name of ['interactions','handled','pending','decisions','withdrawn'])fs.rmSync(path.join(run.dir,name),{recursive:true,force:true});
      });}catch(e){warnings.push('异常运行的问答归档失败，外部记录已保留：'+e.message);}
    }
  }
  return warnings;
}
export function runArchiveWarnings(root,task){
  return listRuns(root).filter(r=>runTask(r)===task).flatMap(r=>{
    const outcome=readJson(path.join(r.dir,'outcome.json'));
    if(outcome?.archiveWarning)return [outcome.archiveWarning];
    return !outcome&&!pidAlive(r.meta.pid)&&fs.existsSync(path.join(r.dir,'interactions'))?['worker 异常退出，仍有外部问答暂存待归档；执行结果未知。']:[];
  });
}
export async function waitRun(run,maxMs=540000){
  const end=Date.now()+maxMs,runner=path.join(scriptsDir,'chatgpt-workflow.mjs').replaceAll('\\','/');
  for(;;){
    if(runFinished(run.dir)){
      const outcome=finishRun(run);
      if(!outcome.ok)throw new Error(outcome.error+(outcome.archiveWarning?'\n'+outcome.archiveWarning:''));
      return {runState:'completed',...(outcome.result||{note:'结果已由另一次调用返回；请用 status 查看当前状态。'}),...(outcome.archiveWarning?{archiveWarning:outcome.archiveWarning}:{})};
    }
    if(!pidAlive(run.meta.pid)){
      await sleep(500);
      if(runFinished(run.dir))continue;
      fs.writeFileSync(path.join(run.dir,'delivered'),'');
      throw new Error('执行进程已意外结束且没有结果，可能已有部分修改。不会自动重跑；请检查 /chatgpt-status 与实际文件，必要时 /chatgpt-unlock。');
    }
    const [next,...others]=undecided(run.dir);
    if(next?.kind==='approval')return {runState:'awaiting-approval',runId:run.id,othersWaiting:others.length,
      approval:{id:next.id,digest:next.digest,text:describe(next)},
      approveCommand:`node "${runner}" approve-codex ${next.id} ${next.digest}`,declineCommand:`node "${runner}" decline-codex ${next.id} ${runOwner(run)}`,
      note:'直接运行 approveCommand，由 Claude Code 权限框让用户决定；不要先用文字或问题卡片询问。用户拒绝时运行 declineCommand。'};
    if(next?.kind==='user-input')return {runState:'awaiting-user-input',runId:run.id,othersWaiting:others.length,userInput:runtimeInputView(run,next),
      note:'用 AskUserQuestion 呈现，再以 user-input-answer 提交真实回答。'};
    if(Date.now()>=end)return {runState:'running',...runSummary(run),note:'仍在执行。展示进度后用 wait 继续等待，不要重新发起。'};
    await sleep(200);
  }
}
export function submitDecision(root,id,build){
  return withPending(root,id,found=>{
    const decision=build(found.record,found.run);
    atomicJson(path.join(found.run.dir,'decisions',id+'.json'),{...decision,at:new Date().toISOString()});
    return found.run;
  });
}
export function acceptDecision(root,{id,digest,scope,gate}){
  return submitDecision(root,id,(record,run)=>{
    if(record.kind!=='approval')throw new Error('该请求不是权限审批。');
    if(digest!==record.digest||recordDigest(record)!==digest)throw new Error('审批内容与展示内容不一致，已拒绝处理。');
    const owner=ownership(run);
    if(!verifyGate(root,gate,{approvalId:id,digest,scope,owner}))throw new Error('缺少有效的权限确认：权限 hook 未生效或会话已被接管。请运行 /chatgpt-resume 重新加载后再确认；不能绕过。');
    return {action:'accept',scope,gate,digest,owner};
  });
}
export function cancelRun(run,sessionId){return interactionLock(run,()=>{requireOwner(run,sessionId);if(!runFinished(run.dir))atomicJson(path.join(run.dir,'cancel.json'),{at:new Date().toISOString()});});}
export {validId};
