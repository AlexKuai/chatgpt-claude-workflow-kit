// Minimal JSONL JSON-RPC client for `codex app-server` over stdio. Node >= 20, no packages.
import {spawn,spawnSync} from 'node:child_process';

// child.kill() leaves grandchildren alive on Windows (npm shims, MCP servers, user commands).
export function killTree(pid){
  if(!Number.isInteger(pid)||pid<=0)return;
  if(process.platform==='win32'){spawnSync('taskkill',['/PID',String(pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});return;}
  try{process.kill(-pid,'SIGKILL');}catch{try{process.kill(pid,'SIGKILL');}catch{/* already gone */}}
}
// An exited process gives its PID back to the system; killing by that number could hit someone else.
export function killChild(child){if(child.exitCode===null&&child.signalCode===null)killTree(child.pid);}
// 'close' waits for every copy of the output pipes, so a process Codex leaves behind (a plugin update, a dev
// server) would hold a finished run open for its whole lifetime. Codex's own exit decides; the rest of its output
// is read for up to 2 s. Counted in ticks, so a busy or suspended computer still gets to read it. Nothing is killed.
const DRAIN_TICKS=20;
export function onEnded(child,done){
  let timer,ended=false;
  const end=(code,leftover)=>{if(ended)return;ended=true;clearInterval(timer);done(code,leftover);};
  child.once('close',code=>end(code,false));
  child.once('exit',code=>{
    let ticks=0;
    timer=setInterval(()=>{
      if(++ticks<DRAIN_TICKS)return;
      for(const stream of [child.stdin,child.stdout,child.stderr])stream?.destroy();
      end(code,true);
    },100);
  });
}

export class AppServerClient{
  constructor({command,cwd,env,onNotification=()=>{},onRequest,onRaw=()=>{},onStderr=()=>{}}){
    this.nextId=1;this.pending=new Map();this.buffer='';this.exited=false;this.leftover=false;
    this.onNotification=onNotification;this.onRequest=onRequest;this.onRaw=onRaw;
    // detached on POSIX gives the process group that killTree needs.
    this.child=spawn(command[0],[...command.slice(1),'app-server'],{cwd,env,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe'],detached:process.platform!=='win32'});
    this.pid=this.child.pid;
    this.exitPromise=new Promise(resolve=>{this.resolveExit=resolve;});
    this.child.stdout.setEncoding('utf8');this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data',chunk=>this.read(chunk));
    this.child.stderr.on('data',onStderr);
    this.child.stdin.on('error',()=>{/* reported through exit */});
    this.child.on('error',e=>this.finish(e));
    onEnded(this.child,(code,leftover)=>{this.leftover=leftover;this.finish(new Error(`codex app-server exited (${code}).`));});
  }
  finish(error){
    if(this.exited)return;this.exited=true;this.exitError=error;
    for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}
    this.pending.clear();this.resolveExit(error);
  }
  read(chunk){
    this.buffer+=chunk;let split;
    while((split=this.buffer.indexOf('\n'))>=0){
      const line=this.buffer.slice(0,split);this.buffer=this.buffer.slice(split+1);
      if(!line.trim())continue;
      this.onRaw('in',line);
      let message;try{message=JSON.parse(line);}catch{this.kill();this.finish(new Error('codex app-server sent invalid JSON.'));return;}
      this.dispatch(message);
    }
  }
  dispatch(m){
    if(m.method!==undefined&&m.id!==undefined){
      // A handler failure must answer with an error, never with an approval.
      Promise.resolve().then(()=>this.onRequest(m)).then(result=>this.send({id:m.id,result}),
        e=>this.send({id:m.id,error:{code:e.rpcCode||-32603,message:e.message}}));
    }else if(m.id!==undefined){
      const p=this.pending.get(m.id);if(!p)return;
      this.pending.delete(m.id);clearTimeout(p.timer);
      if(m.error)p.reject(new Error(`${p.method}: ${m.error.message||'failed'}`));else p.resolve(m.result??{});
    }else if(m.method!==undefined)this.onNotification(m);
  }
  send(message){
    if(this.exited)return;
    const line=JSON.stringify(message);this.onRaw('out',line);this.child.stdin.write(line+'\n');
  }
  request(method,params,timeoutMs=300000){
    if(this.exited)return Promise.reject(this.exitError);
    return new Promise((resolve,reject)=>{
      const id=this.nextId++;
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`${method}: no response within ${timeoutMs} ms.`));},timeoutMs);
      this.pending.set(id,{resolve,reject,method,timer});
      this.send({id,method,params});
    });
  }
  async initialize(version){
    await this.request('initialize',{clientInfo:{name:'chatgpt-claude-browser-kit',title:'ChatGPT Claude Browser Kit',version},
      capabilities:{experimentalApi:false,requestAttestation:false,optOutNotificationMethods:['item/agentMessage/delta','item/reasoning/summaryTextDelta','item/reasoning/summaryPartAdded','item/reasoning/textDelta','item/commandExecution/outputDelta']}},60000);
    this.send({method:'initialized',params:{}});
  }
  kill(){killChild({pid:this.pid,exitCode:this.child.exitCode,signalCode:this.child.signalCode});}
  async close(graceMs=2000){
    if(this.exited)return;
    this.child.stdin.end();
    const timer=setTimeout(()=>this.kill(),graceMs);
    await this.exitPromise;clearTimeout(timer);
  }
}
