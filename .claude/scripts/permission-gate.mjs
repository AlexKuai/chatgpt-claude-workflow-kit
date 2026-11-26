#!/usr/bin/env node
// PreToolUse hook for this kit. It records the live permission mode, skips prompts for the kit's own
// bookkeeping, and turns a Codex approval into a native permission prompt showing the real request.
// Anything it does not fully recognise gets no opinion, so normal permission handling applies.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {scriptsDir,samePath,recordMode,readJson,findPending,recordDigest,gateCode,describe,validId,pidAlive,runFinished,ownership} from './control-store.mjs';

const UUID='[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
const UUID_COMMAND='node -e "console.log(require(\'node:crypto\').randomUUID())"';
const decide=(permissionDecision,permissionDecisionReason,extra={})=>({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision,permissionDecisionReason,...extra}});
const SELF_GATED=new Set(['implement','fix','approve']); // need the user's own slash command for this turn
const INTERNAL=new Set(['new','plan','revise-plan','answer','clarify','record-answers','resume','status','use','doctor','wait','cancel',
  'approval-decline','user-input-answer','user-input-record-answers','review-start','review-questions','review-record-answers','review-save']);

// The whole command must be one runner call: no chaining, redirection, substitution or line breaks.
function parse(command){
  const match=/^\s*node[ \t]+"([^"$`\r\n]+)"((?:[ \t]+(?:"[^"$`\r\n]*"|[A-Za-z0-9_.:\-]+))*)\s*$/.exec(command);
  if(!match||!path.isAbsolute(match[1]))return null;
  const args=[...match[2].matchAll(/"([^"]*)"|(\S+)/g)].map(m=>m[1]??m[2]);
  return {script:match[1],args};
}
// The same call with a pipe, prefix or second command: parse() rejects it, but it is clearly meant for the kit.
const KIT_CALL=/node\s+"([^"$`\r\n]+)"\s+(?:--request-file|wait|status|cancel|decline-codex)(?=\s|$)/g;
const runner=path.join(scriptsDir,'chatgpt-workflow.mjs');
const isWrappedKitCall=command=>[...command.matchAll(KIT_CALL)].some(m=>path.isAbsolute(m[1])&&samePath(m[1],runner));
function realDirectory(dir){try{return !fs.lstatSync(dir).isSymbolicLink()&&fs.statSync(dir).isDirectory();}catch(e){return e.code==='ENOENT';}}
function stateFolders(root){return ['.chatgpt-workflow','.astra-workflow'].map(n=>path.join(root,n));}

export function evaluate(input,root){
  const {tool_name:tool,tool_input:args={},session_id:session,permission_mode:mode}=input;
  if(!validId(session))return null;
  // Subagents may run in another mode; only the main conversation decides how Codex approvals are routed.
  if(['Bash','PowerShell','Write'].includes(tool)&&!input.agent_id)try{recordMode(root,session,mode||'unknown');}catch{/* an old record expires after a few minutes; without one approvals are declined */}
  if(tool==='Write'){
    if(mode==='plan'||typeof args.file_path!=='string'||!path.isAbsolute(args.file_path))return null;
    const file=path.resolve(args.file_path);
    for(const base of stateFolders(root)){
      const inbox=path.join(base,'inbox');
      if(samePath(path.dirname(file),inbox)&&/^request-[A-Za-z0-9_-]+\.json$/.test(path.basename(file))&&realDirectory(base)&&realDirectory(inbox))return decide('allow','工作流请求文件');
      const parts=path.relative(base,file).split(path.sep);
      if(parts.length===4&&parts[0]==='tasks'&&/^[a-z0-9][a-z0-9_-]{0,63}$/.test(parts[1])&&parts[2]==='review-notes'&&new RegExp(`^${UUID}\\.md$`).test(parts[3])
        &&realDirectory(base)&&realDirectory(path.join(base,'tasks',parts[1]))&&realDirectory(path.join(base,'tasks',parts[1],'review-notes')))return decide('allow','评审笔记');
    }
    return null;
  }
  if(!['Bash','PowerShell'].includes(tool)||typeof args.command!=='string')return null;
  if(args.command.trim()===UUID_COMMAND)return mode==='plan'?null:decide('allow','生成请求 ID');
  const call=parse(args.command);
  // An approval must be exactly the returned command; wrapped variants would dodge the prompt below.
  if(!call&&/approve-codex["']?\s+["']?[0-9a-f]{8}-/i.test(args.command))return decide('deny','请原样单独运行 approveCommand，不要拼接或改写。');
  if(!call&&mode!=='plan'&&isWrappedKitCall(args.command))return decide('deny','工作流命令请单独运行：去掉管道、重定向、变量、cd 和拼接的其他命令。输出已精简；需要细节时用 Read 读取返回的文件路径，完整状态用 status <会话ID> --full。');
  if(!call||!samePath(call.script,runner))return null;
  const [verb,...rest]=call.args;
  if(verb==='approve-codex'){
    if(rest.includes('--gate'))return decide('deny','gate 由权限 hook 生成，不能自行提供。');
    const [id,digest,...tail]=rest,scope=tail.length===0?'once':tail.length===2&&tail[0]==='--scope'&&tail[1]==='run'?'run':null;
    if(!scope||!validId(id)||!validId(digest))return decide('deny','approve-codex 参数无效。');
    if(mode==='plan')return decide('deny','Plan 模式不批准 Codex 越权请求，请切换到 Manual 或 Auto。');
    if(!validId(input.tool_use_id))return decide('deny','缺少 tool_use_id，无法建立确认记录。');
    const found=findPending(root,id);
    if(!found||runFinished(found.run.dir)||!pidAlive(found.run.meta.pid))return decide('deny','没有该待审批请求；可能已处理、超时或执行已结束。');
    const {record,run}=found,owner=ownership(run);
    if(owner.sessionId!==session)return decide('deny','该请求属于另一 Claude 会话；请先在本会话用 /chatgpt-use 与 /chatgpt-resume 接管。');
    if(record.kind!=='approval'||record.digest!==digest||recordDigest(record)!==digest)return decide('deny','审批内容与记录不一致，已拒绝。');
    const note=scope==='run'?'\n范围：本次运行内的同类请求都不再询问':'\n范围：仅此一次';
    const gate=gateCode(root,{toolUseId:input.tool_use_id,approvalId:id,digest,scope,owner});
    return decide('ask',describe(record)+note,{updatedInput:{...args,command:`${args.command.trim()} --gate ${gate}`}});
  }
  if(mode==='plan')return null;
  if(verb==='decline-codex')return rest.length===2&&validId(rest[0])&&rest[1]===session?decide('allow','拒绝 Codex 请求'):null;
  if(verb==='status'&&rest.length===2&&rest[1]==='--full')return rest[0]===session?decide('allow','工作流状态'):null;
  if(['wait','cancel','status'].includes(verb)&&rest.length===1)return rest[0]===session?decide('allow','工作流状态'):null;
  if(['status','doctor'].includes(verb)&&!rest.length)return decide('allow','工作流状态');
  if(verb==='--request-file'&&rest.length===1&&path.isAbsolute(rest[0])){
    const file=path.resolve(rest[0]);
    if(!stateFolders(root).some(b=>samePath(path.dirname(file),path.join(b,'inbox'))&&realDirectory(b)&&realDirectory(path.join(b,'inbox'))))return null;
    let request;try{request=JSON.parse(fs.readFileSync(file,'utf8').replace(/^﻿/,''));}catch{return null;}
    if(request?.sessionId!==session||SELF_GATED.has(request.action)||!INTERNAL.has(request.action))return null;
    return decide('allow','工作流内部操作');
  }
  return null;
}
async function main(){
  let text='';for await(const chunk of process.stdin)text+=chunk;
  const root=fs.realpathSync(path.resolve(scriptsDir,'../..'));
  const result=evaluate(JSON.parse(text.replace(/^﻿/,'')),root);
  if(result)console.log(JSON.stringify(result));
}
// A failing hook stays silent: ordinary prompts apply, and approve-codex without a gate code is refused.
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(`permission-gate: ${e.message}`);process.exitCode=1;});
