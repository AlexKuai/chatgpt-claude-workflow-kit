import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const actions=['new','plan','revise-plan','implement','fix','resume','status','use','doctor','unlock'];
test('all daily actions have distinct discoverable entry Skills and valid shared references',()=>{
 for(const action of actions){
  const dir=path.join(root,'.claude','skills',`chatgpt-${action}`);
  const text=fs.readFileSync(path.join(dir,'SKILL.md'),'utf8');
  assert.ok(text.startsWith(`---\nname: chatgpt-${action}\n`));
  assert.ok(text.includes(`Fixed runner action: \`${action}\``));
  for(const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g))assert.ok(fs.existsSync(path.resolve(dir,match[1])));
  assert.ok(!/^(model|context):/m.test(text.split('---')[1]));
 }
});
test('plan and result reviews have discoverable current-model inline entry Skills',()=>{
 for(const kind of ['plan','result']){
  const text=fs.readFileSync(path.join(root,'.claude','skills',`claude-review-${kind}`,'SKILL.md'),'utf8');
  assert.ok(text.startsWith(`---\nname: claude-review-${kind}\n`));
  assert.ok(text.includes(`Fixed review kind: \`${kind}\``));assert.ok(!/^(model|context):/m.test(text.split('---')[1]));
 }
});
test('public help entry has no dispatch table and the shared question workflow remains accessible',()=>{
 const dir=path.join(root,'.claude','skills','chatgpt');
 const text=fs.readFileSync(path.join(dir,'SKILL.md'),'utf8');
 assert.ok(text.includes('HELP AND STATUS ONLY'));assert.ok(!text.includes('## Dispatch'));
 for(const f of ['commands.md','runner.md','planning.md','codex-run.md','review-choice.md','execution.md','resume.md','review.md','status.md','internals.md'])assert.ok(fs.existsSync(path.join(dir,'references',f)));
});
const skillMeta=name=>fs.readFileSync(path.join(root,'.claude','skills',name,'SKILL.md'),'utf8').split('---')[1];
const entries=fs.readdirSync(path.join(root,'.claude','skills'));
test('every entry that calls the runner registers the same permission gate; nothing else is hooked',()=>{
  for(const name of entries.filter(n=>n!=='claude-review')){
    const meta=skillMeta(name);
    assert.match(meta,/\nhooks:\n  PreToolUse:\n    - matcher: "Bash\|PowerShell\|Write"\n      hooks:\n        - type: command\n          command: node\n          args: \["\$\{CLAUDE_PROJECT_DIR\}\/\.claude\/scripts\/permission-gate\.mjs"\]\n/,name);
    assert.equal(meta.match(/type: command/g).length,1,name);
  }
  assert.ok(!skillMeta('claude-review').includes('hooks:'));
  assert.ok(!fs.existsSync(path.join(root,'.claude/settings.json')));
});
test('entries that write, switch tasks or clear locks can only be started by the user',()=>{
  const manual=new Set(['chatgpt-new','chatgpt-plan','chatgpt-revise-plan','chatgpt-implement','chatgpt-fix','chatgpt-use','chatgpt-unlock']);
  for(const name of entries)assert.equal(/^disable-model-invocation: true$/m.test(skillMeta(name)),manual.has(name),name);
});
test('only the writing entries and the browser review pre-approve tools, narrowly',()=>{
  for(const name of entries){
    const tools=skillMeta(name).match(/^allowed-tools: (.+)$/m)?.[1];
    if(['chatgpt-implement','chatgpt-fix'].includes(name)){
      assert.equal(tools,'Bash(node "${CLAUDE_SKILL_DIR}/../../scripts/chatgpt-workflow.mjs" --request-file *) PowerShell(node "${CLAUDE_SKILL_DIR}/../../scripts/chatgpt-workflow.mjs" --request-file *)',name);
    }else if(name==='claude-review-result'){
      assert.match(tools,/mcp__playwright__browser_snapshot/);assert.ok(!/evaluate|run_code|file_upload|Bash|Write/.test(tools));
    }else assert.equal(tools,undefined,name);
  }
});
test('each entry links only the protocol it needs, keeping the Claude-side reading small',()=>{
  // Every byte here is read by Claude on each command; the budgets keep that cost from creeping back.
  const linked=name=>{
    const dir=path.join(root,'.claude','skills',name),text=fs.readFileSync(path.join(dir,'SKILL.md'),'utf8');
    return [...new Set([...text.matchAll(/\]\(([^)]+\.md)\)/g)].map(m=>path.resolve(dir,m[1])))];
  };
  const bytes=name=>linked(name).reduce((n,f)=>n+fs.statSync(f).size,0);
  for(const name of entries){
    assert.ok(!linked(name).some(f=>path.basename(f)==='workflow.md'),name);
    const limit=['chatgpt','chatgpt-status','chatgpt-doctor','chatgpt-use','chatgpt-unlock','claude-review'].includes(name)?20000:36000;
    assert.ok(bytes(name)<=limit,`${name}: ${bytes(name)} bytes of linked protocol (limit ${limit})`);
  }
  for(const name of ['chatgpt-plan','chatgpt-implement'])assert.ok(linked(name).some(f=>f.endsWith('review-choice.md')),name);
  for(const name of entries.filter(n=>/^chatgpt-(new|plan|revise-plan|implement|fix|resume)$/.test(n)))
    assert.ok(linked(name).some(f=>f.endsWith('codex-run.md')),name);
});
