// Approval control files. They live outside the project AND outside TEMP: both are writable from
// Codex's workspace-write sandbox, so a decision stored there could be written by Codex itself.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

export const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
export const scriptsDir=path.dirname(fileURLToPath(import.meta.url));
export const projectRoot=()=>fs.realpathSync(path.resolve(scriptsDir,'../..'));
const key=p=>process.platform==='win32'?p.toLowerCase():p;
export const within=(parent,child)=>{const r=path.relative(key(path.resolve(parent)),key(path.resolve(child)));return r===''||(!r.startsWith('..')&&!path.isAbsolute(r));};
export const samePath=(a,b)=>key(path.resolve(a))===key(path.resolve(b));
// Windows reports a file another process is replacing or reading as busy; that is nearly always brief.
export const isBusy=e=>['EPERM','EBUSY','EACCES'].includes(e.code);
export function whenFree(action,attempts=40){
  for(let attempt=0;;attempt++)try{return action();}catch(e){
    if(attempt>=attempts||!isBusy(e))throw e;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25);
  }
}
export function atomicJson(file,value){
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const temp=`${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp,JSON.stringify(value,null,2),{flag:'wx',mode:0o600});
  try{whenFree(()=>fs.renameSync(temp,file));}finally{fs.rmSync(temp,{force:true});}
}
export function readJson(file){try{return JSON.parse(whenFree(()=>fs.readFileSync(file,'utf8')));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
export function controlDir(root){
  const home=process.env.CHATGPT_KIT_HOME||path.join(os.homedir(),'.chatgpt-claude-kit');
  return path.join(home,sha(key(root)).slice(0,24));
}
export function gateKey(root){
  const file=path.join(controlDir(root),'gate.key');
  if(!fs.existsSync(file)){
    fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
    try{fs.writeFileSync(file,crypto.randomBytes(32).toString('hex'),{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}
  }
  return fs.readFileSync(file,'utf8');
}
export const validId=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
export function gateCode(root,{toolUseId,approvalId,digest,scope,owner}){
  const mac=crypto.createHmac('sha256',gateKey(root)).update(JSON.stringify([toolUseId,approvalId,digest,scope,owner])).digest('hex');
  return `${toolUseId}.${mac}`;
}
export function verifyGate(root,gate,fields){
  const match=/^([A-Za-z0-9_-]{1,128})\.([0-9a-f]{64})$/.exec(gate||'');
  if(!match)return false;
  const expected=gateCode(root,{...fields,toolUseId:match[1]});
  return expected.length===gate.length&&crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(gate));
}

// ---- permission mode, recorded by the hook on every call it sees ----
const MODE_MAX_AGE=5*60*1000;
const modeFile=(root,sessionId)=>path.join(controlDir(root),'modes',`${sha(sessionId)}.json`);
export function recordMode(root,sessionId,mode){
  let saved=null;try{saved=readJson(modeFile(root,sessionId));}catch{/* damaged record: replace it */}
  if(saved?.mode===mode&&Math.abs(Date.now()-saved.at)<60*1000)return; // this runs on every hooked call
  atomicJson(modeFile(root,sessionId),{mode,at:Date.now()});
}
export function currentMode(root,sessionId){
  const saved=readJson(modeFile(root,sessionId));
  return saved&&Date.now()-saved.at<=MODE_MAX_AGE&&typeof saved.mode==='string'?saved.mode:null;
}
export function approvalRouting(mode,settings={}){
  const auto=settings.auto??'auto_review';
  if(!['auto_review','ask','never'].includes(auto))throw Error('permissions.auto 必须为 auto_review、ask 或 never。');
  if(['auto','bypassPermissions'].includes(mode)){
    if(auto==='auto_review')return {approvalPolicy:'on-request',approvalsReviewer:'auto_review',route:'auto-review'};
    if(auto==='never')return {approvalPolicy:'never',approvalsReviewer:'user',route:'decline'};
    return {approvalPolicy:'on-request',approvalsReviewer:'user',route:'user'};
  }
  if(['default','acceptEdits'].includes(mode))return {approvalPolicy:'on-request',approvalsReviewer:'user',route:'user'};
  return {approvalPolicy:'on-request',approvalsReviewer:'user',route:'decline'};
}

// ---- runs ----
export const runsDir=root=>path.join(controlDir(root),'runs');
export function runDir(root,runId){if(!validId(runId))throw Error('Invalid run ID.');return path.join(runsDir(root),runId);}
export const pidAlive=pid=>{if(!Number.isInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}};
export function listRuns(root){
  const dir=runsDir(root);if(!fs.existsSync(dir))return [];
  return fs.readdirSync(dir).filter(validId).map(id=>({id,dir:path.join(dir,id),meta:readJson(path.join(dir,id,'worker.json'))})).filter(r=>r.meta);
}
export const runFinished=dir=>fs.existsSync(path.join(dir,'outcome.json'));
// Short synchronous transactions only. Never hold this lock across a model call or await.
export function shortLock(file,action){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const end=Date.now()+5000;
  let fd;
  for(;;){
    try{fd=fs.openSync(file,'wx',0o600);break;}
    catch(e){
      // Windows answers EPERM/EBUSY, not EEXIST, while the previous holder's file is being deleted.
      const busy=e.code==='EEXIST'||process.platform==='win32'&&['EPERM','EBUSY','EACCES'].includes(e.code);
      if(!busy)throw e;
      if(Date.now()>=end)throw Error(`短时状态锁未释放：${file}。请检查相关进程，不要重复执行任务。`);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25);}
  }
  try{fs.writeFileSync(fd,JSON.stringify({pid:process.pid}));return action();}
  finally{fs.closeSync(fd);whenFree(()=>fs.unlinkSync(file));}
}
export const interactionLock=(run,action)=>shortLock(path.join(run.dir,'interaction.lock'),action);
export function ownership(run){return readJson(path.join(run.dir,'owner.json'))||{sessionId:run.meta.sessionId,revision:0};}
export function requireOwner(run,sessionId){if(!validId(sessionId)||ownership(run).sessionId!==sessionId)throw Error('请求属于另一个 Claude 会话；请先绑定任务并 resume 接管。');}
// Every decision is written inside these locks, after the check below: that alone keeps a decision final.
// No hard link is involved, because some sandboxes and file systems refuse to create one.
export function withPending(root,id,action){
  const first=findPending(root,id);
  if(!first)throw Error('没有该待处理请求；可能已处理、超时或 Codex 撤回。');
  return interactionLock(first.run,()=>shortLock(path.join(first.run.dir,'request-locks',`${id}.lock`),()=>{
    const record=readJson(path.join(first.run.dir,'pending',`${id}.json`));
    if(!record||runFinished(first.run.dir)||!pidAlive(first.run.meta.pid)||fs.existsSync(path.join(first.run.dir,'cancel.json'))||fs.existsSync(path.join(first.run.dir,'withdrawn',`${id}.json`))||record.expiresAt&&Date.now()>=record.expiresAt)
      throw Error('没有该待处理请求；可能已处理、超时或 Codex 撤回。');
    if(fs.existsSync(path.join(first.run.dir,'decisions',`${id}.json`)))throw Error('该请求已有决定，不能更改。');
    return action({run:first.run,record});
  }));
}
export function pendingItems(dir){
  const folder=path.join(dir,'pending');if(!fs.existsSync(folder))return [];
  let names;try{names=fs.readdirSync(folder);}catch(e){if(e.code==='ENOENT')return [];throw e;}
  return names.filter(n=>n.endsWith('.json')).map(n=>readJson(path.join(folder,n))).filter(Boolean).sort((a,b)=>a.seq-b.seq);
}
export function findPending(root,id){
  if(!validId(id))return null;
  for(const run of listRuns(root)){const record=readJson(path.join(run.dir,'pending',`${id}.json`));if(record)return {run,record};}
  return null;
}
// The digest covers exactly what the user is shown, so an approval cannot drift to another action.
export const recordDigest=r=>sha(JSON.stringify([r.id,r.runId,r.method,r.task,r.stage,r.title,r.details,r.createdAt])).slice(0,32);

// ---- integrity of the code and settings that implement the gate ----
const gateFiles=['permission-gate.mjs','control-store.mjs','codex-bridge.mjs','runtime-questions.mjs','app-server-client.mjs','chatgpt-workflow.mjs','output-view.mjs','goal-contract.mjs','file-snapshot.mjs'];
// "Always allow" on the approval dialog saves an allow rule for the kit's own approve-codex command. Such a rule
// changes nothing: the hook still asks and the runner still needs the hook's gate code. Every other change counts.
// Only the exact forms a saved choice can take for this installed runner: a prefix rule, or the full command shown.
// Any other wildcard or text could match unrelated commands, so it counts as a change.
const escapeRegex=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const kitRunner=path.join(scriptsDir,'chatgpt-workflow.mjs');
const runnerSpellings=[...new Set([kitRunner,kitRunner.replaceAll('\\','/')])].map(escapeRegex).join('|');
const HARMLESS_RULE=new RegExp(`^(?:Bash|PowerShell)\\(node "(?:${runnerSpellings})" approve-codex(?::\\*| \\*| [A-Za-z0-9_-]{1,128} [A-Za-z0-9_-]{1,128}(?: --scope run)?(?: --gate [A-Za-z0-9_.-]{1,300})?)\\)$`,process.platform==='win32'?'i':'');
const harmlessRule=r=>typeof r==='string'&&HARMLESS_RULE.test(r);
// Parsed content is compared, not bytes, so the file Claude Code rewrites or creates for such a rule matches the
// earlier state. A file holding nothing else counts as absent. Unparseable content is compared byte for byte.
export function localSettingsDigest(buffer){
  let value;try{value=JSON.parse(buffer.toString('utf8').replace(/^﻿/,''));}catch{return sha(buffer);}
  if(!value||typeof value!=='object'||Array.isArray(value))return sha(buffer);
  const normalized={...value},allow=value.permissions?.allow;
  if(value.permissions&&typeof value.permissions==='object'&&Array.isArray(allow)){
    const permissions={...value.permissions},rest=allow.filter(r=>!harmlessRule(r));
    if(rest.length)permissions.allow=rest;else delete permissions.allow;
    if(Object.keys(permissions).length)normalized.permissions=permissions;else delete normalized.permissions;
  }
  return Object.keys(normalized).length?sha(JSON.stringify(normalized)):null;
}
export function kitFingerprint(root){
  const out={},add=(f,digest=sha)=>{out[f]=fs.existsSync(f)?digest(whenFree(()=>fs.readFileSync(f))):null;}; // null = absent
  for(const name of gateFiles)add(path.join(scriptsDir,name));
  for(const name of ['chatgpt-workflow.json','settings.json'])add(path.join(root,'.claude',name));
  add(path.join(root,'.claude','settings.local.json'),localSettingsDigest);
  const skills=path.join(root,'.claude','skills');
  if(fs.existsSync(skills))for(const d of fs.readdirSync(skills).filter(n=>/^(chatgpt|claude-review)(-|$)/.test(n)).sort())add(path.join(skills,d,'SKILL.md'));
  return out;
}
export const changedKitFiles=(before,after)=>[...new Set([...Object.keys(before),...Object.keys(after)])].filter(f=>before[f]!==after[f]);

// Text from Codex is shown in a permission dialog: make control and direction-override characters visible.
const hidden=c=>c<9||(c>10&&c<32)||(c>126&&c<160)||(c>=0x200b&&c<=0x200f)||(c>=0x2028&&c<=0x202e)||(c>=0x2060&&c<=0x2069)||c===0xfeff||(c>=0xd800&&c<=0xdfff);
export function displayText(value,limit=3000){
  const clean=Array.from(String(value??''),ch=>hidden(ch.codePointAt(0))?`[U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4,'0')}]`:ch).join('').replaceAll('\n','\n      | ');
  return clean.length>limit?`${clean.slice(0,limit)}…（其余 ${clean.length-limit} 个字符未显示）`:clean;
}
// Anything that cannot be shown in full is declined rather than approved half-seen.
export const COMMAND_LIMIT=6000;
export function describe(record){
  const d=record.details,lines=[`Codex 请求：${record.title}`,`任务 ${record.task} · ${record.stage}`];
  if(d.command)lines.push(`命令  ${displayText(d.command,COMMAND_LIMIT)}`);
  if(d.network)lines.push(`网络  ${displayText(d.network)}`);
  if(d.cwd)lines.push(`目录  ${displayText(d.cwd,400)}`);
  for(const f of d.files||[])lines.push(`文件  ${displayText(`${f.kind} ${f.path}`,400)}`);
  if(d.moreFiles)lines.push(`文件  另有 ${d.moreFiles} 个未列出`);
  if(d.permissions)lines.push(`权限  ${displayText(d.permissions,1500)}`);
  if(d.server)lines.push(`MCP   ${displayText(d.server,200)}`);
  if(d.message)lines.push(`说明  ${displayText(d.message,1000)}`);
  if(d.reason)lines.push(`理由（Codex 提供）  ${displayText(d.reason,1000)}`);
  return lines.join('\n');
}
