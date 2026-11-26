// Filesystem evidence is authoritative. Git is optional, never part of the content version.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const fixed=['.git','.chatgpt-workflow','.astra-workflow'];
// Claude Code rewrites this file whenever the user saves a permission choice; it is never a deliverable.
// Changes made while Codex runs are still caught by the kit fingerprint.
const fixedFiles=['.claude/settings.local.json'];
const defaults=['node_modules','.venv','__pycache__','.cache','.vs','.next','.nuxt','.turbo','coverage','test-results','playwright-report','.playwright-mcp','.pytest_cache','.mypy_cache','TestResults'];
// Ambiguous names are build output only next to the project file that produces them.
const projectOutputs=[{directories:['bin','obj'],beside:['*.csproj','*.fsproj','*.vbproj']},{directories:['target'],beside:['Cargo.toml','pom.xml']}];
const perFile=1024*1024,perSnapshot=32*1024*1024;
const compare=(a,b)=>a<b?-1:a>b?1:0;
class Unstable extends Error {}
export function snapshotRules(root){
  const current=path.join(root,'.claude/chatgpt-workflow.json'),legacy=path.join(root,'.claude/astra-workflow.json');
  const file=fs.existsSync(current)?current:legacy;
  const config=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')):{};
  const exclude=config.snapshot?.excludeDirectories??defaults;
  if(!Array.isArray(exclude)||exclude.some(p=>typeof p!=='string'||!p||p.includes('\\')||p.startsWith('/')||p.includes(':')||p.split('/').some(s=>!s||s==='.'||s==='..')||/[?*\[\]]/.test(p)))
    throw Error('snapshot.excludeDirectories 必须为相对目录路径或单目录名称数组；使用 /，不支持通配符或 ..。');
  return {format:'files-v1',fixedExcludedNames:fixed,fixedExcludedFiles:fixedFiles,excludeDirectories:[...new Set(exclude)].sort(compare),projectOutputs:exclude===defaults?projectOutputs:[],textBackupMaxBytes:perFile,newBackupMaxBytes:perSnapshot};
}
const isBeside=(name,pattern)=>pattern.startsWith('*')?name.toLowerCase().endsWith(pattern.slice(1)):name===pattern;
function excluded(relative,directory,rules,siblings){
  const parts=relative.split('/');
  if(parts.some(p=>fixed.includes(p.toLowerCase())))return true;
  if(!directory)return fixedFiles.includes(process.platform==='win32'?relative.toLowerCase():relative);
  return rules.excludeDirectories.some(p=>p.includes('/')?relative===p:parts.at(-1)===p)
    ||rules.projectOutputs.some(o=>o.directories.includes(parts.at(-1))&&siblings.some(s=>o.beside.some(b=>isBeside(s,b))));
}
export function gitInfo(root,{gitCommand='git',summary=false}={}){
  const run=args=>{const r=spawnSync(gitCommand,args,{cwd:root,encoding:'utf8',env:{...process.env,GIT_OPTIONAL_LOCKS:'0'},windowsHide:true,timeout:3000,maxBuffer:4*1024*1024});return r.status===0?r.stdout:null;};
  const top=run(['rev-parse','--show-toplevel']);
  if(top===null)return {available:false,note:'Git 不可用或当前目录不在仓库中；不影响文件快照与工作流。'};
  if(summary)return {available:true,root:top.trim(),note:'Git 可用，仅为辅助信息；文件快照独立运行。'};
  return {available:true,root:top.trim(),head:run(['rev-parse','--verify','HEAD'])?.trim()||null,
    status:run(['status','--porcelain','--','.']),staged:run(['diff','--cached','--no-ext-diff','--no-textconv','--','.']),unstaged:run(['diff','--no-ext-diff','--no-textconv','--','.']),note:'Git 信息仅供辅助；不参与文件版本判断。'};
}
function inventory(root,rules,io){
  const result=[];
  const walk=(relative='')=>{
    const folder=path.join(root,relative);
    let names;try{names=io.readdirSync(folder);}catch(e){if(e.code==='ENOENT')throw new Unstable(`目录在扫描期间变化：${relative}`);throw Error(`无法读取目录 ${relative||'.'}：${e.message}`);}
    for(const name of names.sort(compare)){
      const rel=relative?`${relative}/${name}`:name,absolute=path.join(root,rel);
      let st;try{st=io.lstatSync(absolute);}catch(e){if(e.code==='ENOENT')throw new Unstable(`扫描期间文件变化：${rel}`);throw e;}
      if(excluded(rel,st.isDirectory(),rules,names))continue;
      const type=st.isSymbolicLink()?'symlink':st.isDirectory()?'directory':st.isFile()?'file':'unsupported';
      if(type==='unsupported')throw Error(`无法可靠检查特殊文件：${rel}`);
      result.push({path:rel,type,stamp:[st.dev,st.ino,st.size,st.mtimeMs,st.ctimeMs,st.mode].join(':'),size:st.size,mode:st.mode});
      if(type==='directory')walk(rel);
    }
  };
  walk();return result.sort((a,b)=>compare(a.path,b.path));
}
function safeObjects(root,taskDir){
  const target=path.resolve(taskDir,'objects'),relative=path.relative(root,target);
  if(relative.startsWith('..')||path.isAbsolute(relative))throw Error('备份目录必须位于当前项目工作流目录内。');
  let current=root;
  for(const part of relative.split(path.sep)){
    current=path.join(current,part);
    if(fs.existsSync(current)){
      if(fs.lstatSync(current).isSymbolicLink()||!fs.statSync(current).isDirectory())throw Error(`不安全的备份目录：${current}`);
    }else fs.mkdirSync(current);
  }
  return target;
}
export function captureSnapshot(root,{taskDir,io=fs,gitCommand='git'}={}){
  for(let attempt=0;attempt<2;attempt++){
    try{
      const rules=snapshotRules(root),rulesHash=digest(JSON.stringify(rules)),before=inventory(root,rules,io),entries=[],pending=new Map();
      const objects=taskDir?safeObjects(root,taskDir):null;let backupBytes=0;
      for(const item of before){
        const absolute=path.join(root,item.path),entry={path:item.path,type:item.type,size:item.type==='directory'?0:item.size,hash:null};
        if(process.platform!=='win32')entry.executable=item.mode&0o111;
        if(item.type==='symlink'){
          let target;try{target=io.readlinkSync(absolute);}catch(e){
            if(['ENOENT','EINVAL','UNKNOWN'].includes(e.code))throw new Unstable(`链接在扫描期间变化：${item.path}`);
            throw Error(`无法读取符号链接 ${item.path}：${e.message}`);
          }
          entry.hash=digest(target);entry.target=target;entry.size=Buffer.byteLength(target);
        }
        if(item.type==='file'){
          let fd;const h=crypto.createHash('sha256'),buffer=Buffer.allocUnsafe(64*1024),chunks=[];let count=0;
          try{
            fd=io.openSync(absolute,'r');
            const opened=io.fstatSync(fd);
            if(!opened.isFile()||opened.ino!==Number(item.stamp.split(':')[1]))throw new Unstable(`文件类型变化：${item.path}`);
            let n;while((n=io.readSync(fd,buffer,0,buffer.length,null))>0){h.update(buffer.subarray(0,n));count+=n;if(item.size<=perFile&&count<=perFile)chunks.push(Buffer.from(buffer.subarray(0,n)));}
          }catch(e){if(e instanceof Unstable)throw e;if(e.code==='ENOENT')throw new Unstable(`文件在扫描期间消失：${item.path}`);throw Error(`无法读取文件 ${item.path}：${e.message}`);}finally{if(fd!==undefined)io.closeSync(fd);}
          if(count!==item.size)throw new Unstable(`文件大小变化：${item.path}`);
          entry.hash=h.digest('hex');
          if(objects){
            const object=path.join(objects,entry.hash);
            if(item.size>perFile)entry.backupReason='file-size-limit';
            else{
              const content=Buffer.concat(chunks);let text=true;
              try{new TextDecoder('utf-8',{fatal:true}).decode(content);if(content.some(b=>b===0||(b<32&&![9,10,12,13].includes(b))))text=false;}catch{text=false;}
              if(!text)entry.backupReason='binary';
              else if(fs.existsSync(object)){
                if(!fs.lstatSync(object).isFile()||fs.lstatSync(object).isSymbolicLink()||digest(fs.readFileSync(object))!==entry.hash)throw Error(`备份内容损坏：${object}`);
                entry.contentFile=object;
              }else if(pending.has(entry.hash))entry.contentFile=object;
              else if(backupBytes+content.length>perSnapshot)entry.backupReason='snapshot-budget';
              else{pending.set(entry.hash,content);backupBytes+=content.length;entry.contentFile=object;}
            }
          }else entry.backupReason='fingerprint-only';
        }
        entries.push(entry);
      }
      if(JSON.stringify(before)!==JSON.stringify(inventory(root,rules,io))||JSON.stringify(rules)!==JSON.stringify(snapshotRules(root)))throw new Unstable('扫描期间文件或扫描规则变化。');
      for(const [hash,content] of pending){const file=path.join(objects,hash);fs.writeFileSync(file,content,{flag:'wx',mode:0o600});}
      const identity=entries.map(({path,type,size,hash,executable,target})=>({path,type,size,hash,...(executable===undefined?{}:{executable}),...(target===undefined?{}:{target})}));
      return {format:'files-v1',createdAt:new Date().toISOString(),rules,rulesHash,entries,backupBytes,
        hash:digest(JSON.stringify({rulesHash,entries:identity})),...(taskDir?{git:gitInfo(root,{gitCommand})}:{}),
        limitations:['排除目录不在检查范围内。','哈希仅证明内容变化；不证明功能、事实或视觉验收。','未保存原文的文件不能仅凭快照还原或比较历史内容。']};
    }catch(e){if(!(e instanceof Unstable))throw e;if(attempt===1)throw Error(`文件持续变化，重新采集一次后仍不稳定：${e.message}`);}
  }
}
export function diffSnapshots(before,after){
  if(before.format!=='files-v1'||after.format!=='files-v1')throw Error('旧快照不可直接作为新文件快照比较。');
  const a=new Map(before.entries.map(e=>[e.path,e])),b=new Map(after.entries.map(e=>[e.path,e]));
  return [...new Set([...a.keys(),...b.keys()])].sort(compare).flatMap(p=>{
    const x=a.get(p),y=b.get(p);const change=!x?'added':!y?'deleted':x.type!==y.type?'type-changed':x.hash!==y.hash||x.executable!==y.executable?'modified':null;
    return change?[{path:p,change,before:x||null,after:y||null}]:[];
  });
}
