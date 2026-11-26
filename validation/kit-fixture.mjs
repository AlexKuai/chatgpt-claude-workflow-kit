// Installs the kit scripts into a throwaway project and drives them as real processes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
export const SESSION='bridge-session';
export function kit(t,{config={},mode='default'}={}){
  const parent=fs.realpathSync(fs.mkdtempSync(path.join(process.env.CHATGPT_TEST_TMP||os.tmpdir(),'kit-')));
  const root=path.join(parent,'project'),home=path.join(parent,'home'),scripts=path.join(root,'.claude','scripts'),capture=path.join(parent,'capture.jsonl');
  fs.mkdirSync(scripts,{recursive:true});fs.mkdirSync(home);
  fs.cpSync(path.join(here,'../.claude/scripts'),scripts,{recursive:true});
  fs.writeFileSync(path.join(root,'.claude/chatgpt-workflow.json'),JSON.stringify({codexCommand:[process.execPath,path.join(here,'fake-app-server.mjs')],...config}));
  fs.writeFileSync(path.join(root,'app.txt'),'base');
  const runner=path.join(scripts,'chatgpt-workflow.mjs'),gateScript=path.join(scripts,'permission-gate.mjs');
  const env=scenario=>({...process.env,CHATGPT_KIT_HOME:home,CHATGPT_KIT_TRANSPORT:'',FAKE_CAPTURE:capture,...(scenario?{FAKE_SCENARIO:JSON.stringify(scenario)}:{})});
  const clean=e=>{const c={...e};if(!c.CHATGPT_KIT_TRANSPORT)delete c.CHATGPT_KIT_TRANSPORT;return c;};
  const exec=(args,{input,scenario}={})=>new Promise(resolve=>{
    const child=spawn(process.execPath,args,{cwd:root,env:clean(env(scenario)),windowsHide:true});
    let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);
    child.on('close',status=>resolve({status,out,err}));child.stdin.end(input||'');
  });
  const raw=(request,scenario)=>exec([runner,'--stdin'],{input:JSON.stringify({sessionId:SESSION,...request}),scenario});
  const call=async(request,scenario)=>{const r=await raw(request,scenario);if(r.status!==0)throw Error(r.err||`runner exited (${r.status}) without output`);return JSON.parse(r.out);};
  const argv=async(args)=>{const r=await exec([runner,...args]);if(r.status!==0)throw Error(r.err);return JSON.parse(r.out);};
  const projectHash=crypto.createHash('sha256').update(process.platform==='win32'?root.toLowerCase():root).digest('hex').slice(0,24);
  const control=path.join(home,projectHash);
  const setMode=value=>{const d=path.join(control,'modes');fs.mkdirSync(d,{recursive:true});fs.writeFileSync(path.join(d,`${crypto.createHash('sha256').update(SESSION).digest('hex')}.json`),JSON.stringify({mode:value,at:Date.now()}));};
  if(mode)setMode(mode);
  const hook=async(tool_input,over={})=>{
    const r=await exec([gateScript],{input:JSON.stringify({session_id:SESSION,permission_mode:'default',tool_name:'Bash',tool_use_id:'toolu_1',tool_input,...over})});
    return r.out.trim()?JSON.parse(r.out).hookSpecificOutput:null;
  };
  // What happens when the user answers Yes in the native dialog: the hook's rewritten command runs.
  const userApproves=async(command,over)=>{
    const h=await hook({command},over);if(h?.permissionDecision!=='ask')throw Error('hook did not ask: '+JSON.stringify(h));
    return argv([...h.updatedInput.command.matchAll(/"([^"]*)"|(\S+)/g)].map(m=>m[1]??m[2]).slice(2));
  };
  const captured=()=>fs.existsSync(capture)?fs.readFileSync(capture,'utf8').trim().split('\n').map(JSON.parse):[];
  const responses=()=>captured().filter(c=>c.kind==='approval-response').map(c=>c.response);
  const plan=async scenario=>call({action:'new',task:'demo',text:'实现功能'},scenario);
  const approved=async()=>{
    await plan();const s=await call({action:'review-start',kind:'plan'});
    await call({action:'review-save',kind:'plan',ticket:s.ticket,text:'通过'});await call({action:'approve'});
  };
  t.after(async()=>{
    const runs=path.join(control,'runs');
    // Only workers without a result: Windows soon gives a finished worker's PID to another test's process.
    const ended=id=>['outcome.json','delivered'].some(n=>fs.existsSync(path.join(runs,id,n)));
    if(fs.existsSync(runs))for(const id of fs.readdirSync(runs)){if(!ended(id))try{process.kill(JSON.parse(fs.readFileSync(path.join(runs,id,'worker.json'))).pid);}catch{/* finished */}}
    for(let i=0;;i++)try{fs.rmSync(parent,{recursive:true,force:true});break;}catch(e){if(i>20)throw e;await new Promise(r=>setTimeout(r,100));}
  });
  return {root,parent,home,control,runner,raw,call,argv,exec,hook,userApproves,captured,responses,plan,approved,setMode};
}
export const command=(over={})=>({request:'item/commandExecution/requestApproval',params:{kind:'command',command:'npm install zod',cwd:'D:/proj',reason:'需要网络',environmentId:'local',...over}});
