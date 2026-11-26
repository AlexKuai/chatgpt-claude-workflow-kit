// Preloaded into the kit's processes by busy-files.test.mjs: makes chosen file operations fail the way Windows
// does while another program has the file open. Rules come from BUSY (JSON); every injected failure is logged.
// Rule: {op, file, match?, worker?, skip?, ms} - `match` tests the content about to be moved into place.
import fs from 'node:fs';
const rules=JSON.parse(process.env.BUSY||'[]').map(r=>({...r,file:new RegExp(r.file),match:r.match&&new RegExp(r.match),seen:0}));
const isWorker=process.argv.includes('--worker'),readFile=fs.readFileSync,append=fs.appendFileSync;
function busy(op,file,source){
  const name=String(file).replaceAll('\\','/');
  for(const r of rules){
    if(r.op!==op||!r.file.test(name)||(r.worker&&!isWorker))continue;
    if(r.until===undefined){
      if(r.match&&!r.match.test(readFile(source,'utf8')))continue;
      if(r.seen++<(r.skip||0))continue;
      r.until=r.ms<0?Infinity:Date.now()+r.ms;
    }
    if(Date.now()>=r.until)continue;
    append(process.env.BUSY_LOG,`${op} ${name}\n`);
    throw Object.assign(new Error(`${r.code||'EPERM'}: operation not permitted, ${op} '${file}'`),{code:r.code||'EPERM'});
  }
}
const patch=(op,check)=>{const original=fs[op];fs[op]=(...args)=>{check(...args);return original(...args);};};
patch('renameSync',(from,to)=>busy('rename',to,from));
patch('readFileSync',file=>{if(typeof file==='string')busy('read',file);});
patch('unlinkSync',file=>busy('unlink',file));
patch('openSync',(file,flags)=>{if(flags==='wx')busy('create',file);});
