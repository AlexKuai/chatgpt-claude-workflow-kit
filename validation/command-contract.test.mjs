import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const hints={chatgpt:'','chatgpt-new':'<需求描述>','chatgpt-use':'<任务ID>',
 'chatgpt-plan':'[补充需求或讨论内容]','chatgpt-revise-plan':'[修改重点]',
 'chatgpt-fix':'[问题编号或修改重点]','claude-review-plan':'[关注点]',
 'claude-review-result':'[关注点或验证要求]','chatgpt-implement':'','chatgpt-resume':'',
 'chatgpt-status':'','chatgpt-doctor':'','chatgpt-unlock':'','claude-review':''};
test('14 Chinese command menus agree with help and README on required and optional arguments',()=>{
 const skills=path.join(root,'.claude','skills');
 assert.deepEqual(fs.readdirSync(skills).sort(),Object.keys(hints).sort());
 for(const [name,hint] of Object.entries(hints)){
  const text=fs.readFileSync(path.join(skills,name,'SKILL.md'),'utf8');
  const meta=text.split('---')[1];
  const description=meta.match(/^description: (.+)$/m)?.[1];
  assert.match(description,/\p{Script=Han}/u,name);
  assert.ok(!/[<>\[\]]/.test(description),`${name}: placeholders belong in argument-hint`);
  assert.equal(meta.match(/^argument-hint: "(.*)"$/m)?.[1]||'',hint,name);
 }
 for(const relative of ['README.zh-CN.md','.claude/skills/chatgpt/references/commands.md']){
  const text=fs.readFileSync(path.join(root,relative),'utf8');
  const usages=[...text.matchAll(/^\| `\/(\S+)([^`]*)` \|/gm)].map(m=>[m[1],m[2].trim()]);
  assert.equal(usages.length,14,relative);
  assert.deepEqual(Object.fromEntries(usages),hints,relative);
  assert.ok(text.includes('尖括号表示必填，方括号表示可选，实际输入时不包含括号'),relative);
 }
});
test('public documentation supports ordinary folders, bounded backups and explicit initial recovery',()=>{
 const read=file=>fs.readFileSync(path.join(root,file),'utf8');
 for(const file of ['README.zh-CN.md','.claude/skills/chatgpt/references/runner.md','.claude/skills/chatgpt/references/review.md']){
  const s=read(file);assert.ok(!/requires installation at a Git repository root|适用于 Git 项目|目标 Git 项目根目录/.test(s),file);assert.match(s,/快照/);
 }
 assert.match(read('README.zh-CN.md'),/1 MiB/);assert.match(read('README.zh-CN.md'),/32 MiB/);
 assert.match(read('.claude/skills/chatgpt/references/workflow.md'),/首次规划明确失败/);
 assert.match(read('.claude/skills/chatgpt/references/status.md'),/Git 不可用是正常状态/);
 assert.match(read('.claude/skills/chatgpt/references/runner.md'),/--skip-git-repo-check/);
});
