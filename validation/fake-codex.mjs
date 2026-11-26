import fs from 'node:fs';
import path from 'node:path';
import {fixtureContract,fixtureResult} from './fixture-goals.mjs';
const args = process.argv.slice(2);
let text = '';
for await (const chunk of process.stdin) text += chunk;
if (process.env.FAKE_CAPTURE) {fs.mkdirSync(path.dirname(process.env.FAKE_CAPTURE),{recursive:true});fs.appendFileSync(process.env.FAKE_CAPTURE, JSON.stringify({args,text}) + '\n');}
if (process.env.FAKE_EARLY_FAIL) { console.error('fixture unavailable'); process.exit(1); }
const uuid = process.env.FAKE_THREAD || '12345678-1234-4234-8234-123456789abc';
console.log(JSON.stringify({type:'thread.started',thread_id:uuid}));
if (process.env.FAKE_DELAY) await new Promise(resolve => setTimeout(resolve, Number(process.env.FAKE_DELAY)));
if (process.env.FAKE_FAIL) { console.log(JSON.stringify({type:'turn.failed',error:{message:'fixture failed'}})); process.exit(1); }
if (process.env.FAKE_WRITE_APP) fs.writeFileSync('app.txt',process.env.FAKE_WRITE_APP);
if (process.env.FAKE_WRITE_DOC) fs.writeFileSync('guide.md',process.env.FAKE_WRITE_DOC);
if (process.env.FAKE_WRITE_LOCAL_SETTINGS) {fs.mkdirSync('.claude',{recursive:true});fs.writeFileSync('.claude/settings.local.json',process.env.FAKE_WRITE_LOCAL_SETTINGS);}
if (process.env.FAKE_WRITE_CONFIG) {fs.mkdirSync('.claude',{recursive:true});fs.writeFileSync('.claude/chatgpt-workflow.json',process.env.FAKE_WRITE_CONFIG);}
if (process.env.FAKE_FAIL_AFTER_WRITE) { console.log(JSON.stringify({type:'turn.failed',error:{message:'fixture failed after write'}})); process.exit(1); }
const plain = process.env.FAKE_ANSWER || '# Plan\nImplement the requested behavior and verify acceptance criteria.';
const schemaFile=args.includes('--output-schema')?args[args.indexOf('--output-schema')+1]:null;
const execution=schemaFile&&JSON.parse(fs.readFileSync(schemaFile,'utf8')).properties.outcome;
const answer=process.env.FAKE_RAW_RESPONSE ?? (execution?JSON.stringify(fixtureResult):schemaFile?(process.env.FAKE_PLANNING||JSON.stringify({status:'ready',plan:plain,questions:[],contract:fixtureContract})):plain);
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:answer}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:10}}));
