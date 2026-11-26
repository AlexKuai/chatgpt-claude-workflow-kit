# Internals: configuration, state files and compatibility

Read this only when configuring the kit, diagnosing an error, or upgrading old tasks. Normal commands do not need it.

## 文件快照

所有项目均使用 files-v1 文件快照，不依赖 Git。快照按内容哈希记录新增、修改、删除和类型变化；Git 状态、提交和差异只作辅助，不参与评审版本判断。固定排除 .git、.chatgpt-workflow、.astra-workflow 和 .claude/settings.local.json（Claude Code 保存权限选择时会改写它；执行期间的改动仍由防篡改检查报告）；默认排除 node_modules、.venv、__pycache__、.cache、.vs、.next、.nuxt、.turbo、coverage、test-results、playwright-report、.playwright-mcp、.pytest_cache、.mypy_cache、TestResults；bin/obj 仅在同级有 *.csproj、*.fsproj、*.vbproj 时排除，target 仅在同级有 Cargo.toml、pom.xml 时排除。扫描不采用 .gitignore，dist/build 默认纳入。排除目录不算已检查。UTF-8 文本每文件最多 1 MiB，每次快照最多新增 32 MiB 原文备份，按内容哈希去重；二进制、大文件及预算外内容只记录指纹和未备份原因。不能据此承诺完整回滚。

项目配置 `.claude/chatgpt-workflow.json`：

- `snapshot.excludeDirectories`：普通排除目录数组，替换默认项（包括 bin/obj/target 的条件排除）；单目录名匹配各层级同名目录，含 / 则匹配根目录相对路径。
- `snapshot.excludeFiles`：排除文件数组，适合评审或浏览器测试期间会被写入的本地数据（如 `dev.db`、`logs/server.log`）；单文件名匹配各层级同名文件，含 / 则匹配根目录相对路径。不配置时扫描规则与旧版完全相同。

两者都不支持通配符、绝对路径、`..`。固定排除项不能取消。规则哈希参与版本判断：改变规则会使相关评审失效；交付物涉及排除目录或文件时先调整范围。内容哈希不含 Git 信息、时间戳、备份路径。

files-v1 的 entries 记录 path/type/size/hash、适用平台的 executable，以及 contentFile 或 backupReason。文本备份只在任务 objects/ 中按 SHA256 保存；比较产生 added/modified/deleted/type-changed。实施前基线与每次执行前后快照作用不变。旧 Git 基线保留，升级当前快照另存为 upgradeSnapshot，不是实施前内容。新审批含 evidenceFormat，旧评审刷新后再继续依赖操作。

## 传输与审批控制

默认传输为 `codex app-server`（JSON-RPC over stdio）：规划类只读沙箱，implement/fix 为 workspace-write，`approvalPolicy=on-request`，`approvalsReviewer` 按 Claude 模式取 user 或 auto_review；启动后核对 Codex 实际生效的沙箱与审批方，不符即停止。可重试的连接错误只记进度，成败以 turn/completed 为准。未知类型或无法完整展示的请求一律拒绝，规划阶段的文件修改一律拒绝，从不使用会写入持久规则的批准。审计写入 `<run>.approvals.jsonl`，原始协议写入 `<run>.rpc.jsonl`。

待审批记录、决定与 HMAC 密钥保存在 `~/.chatgpt-claude-kit/<项目哈希>/`（可用 CHATGPT_KIT_HOME 改位置），因为项目目录与临时目录对 Codex 可写。该位置若落入 Codex 可写范围则拒绝所有审批。执行期间若本包脚本、Skill 或 `.claude` 权限配置被改动，后续批准失效并在 `kitFilesChanged` 中报告；例外是 `settings.local.json` 中只新增了本包 approve-codex 命令的允许规则：规则必须精确指向本项目已安装的 runner 路径，形如 `Bash(node "<runner>" approve-codex:*)` 或完整的审批命令（权限框“始终允许”产生，hook 仍会弹框，不影响审批）；带其他通配符、其他路径或附加文字的规则仍算改动。此机制防误批和模型跳步，**不防**能以你的账户读取用户目录的恶意进程。

回退：项目配置 `{"transport":"exec"}` 使用 `codex exec`，没有审批回传，越权请求直接失败。`{"permissions":{"auto":"auto_review"}}` 可改为 `"ask"`（Auto 下也弹权限框）或 `"never"`（Auto 下直接失败）。

exec 回退使用 `shell:false`, prompts over stdin, explicit sandbox, `approval_policy="never"`, and an explicit UUID for existing-session resume. Both exec and exec resume receive --skip-git-repo-check; this changes only repository checking, not sandbox permissions or approvals. It passes no model override, reasoning-effort override, profile selection, or ignore-user-config flag. Codex selects its model using its native configuration and resume rules. `never` means a non-interactive child fails when extra approval is needed; it does not disable the sandbox or bypass Claude's host permission check. Do not add dangerous bypass flags or automatically relax sandboxing on failure.

## Codex 路径

If Codex is not discoverable (including Windows npm shims), create **only this project's** optional `.claude/chatgpt-workflow.json`:

```json
{"codexCommand":["C:/absolute/path/to/codex.exe"]}
```

Or use `["node", "/absolute/path/to/node_modules/@openai/codex/bin/codex.js"]`. Use an executable/argument array, never a shell command string or `.cmd`/`.bat`. Do not copy machine-specific paths to another computer without adjusting them. Never put credentials in this file. The old project-local `astra-workflow.json` is accepted as an executable-path fallback if `chatgpt-workflow.json` is absent; it does not read or force any old model setting.

## State files and compatibility

The runner saves `.chatgpt-workflow/sessions/<hash>.json` bindings (session ID + project root + task), compatibility active.json, task state and all prior artifacts. `questions.json`/`questions.md` preserve Codex planning rounds; `review-questions.json`/`review-questions.md` preserve Claude review sessions and rounds, including superseded-source history. `state.json` is authoritative; these are readable/exportable copies. On export failure, state may already contain the answer; inspect status before assuming it was lost.

Schema-1 task state remains readable/resumable; old reports retain their original hashes/versions for historical inspection, but implementation/fixes require a newly reviewed structured goal. Existing tasks require explicit `/chatgpt-use` the first time a Claude session is bound. It continues an existing legacy `.astra-workflow/active.json` in place, preserving artifact paths and UUIDs. If both roots have active state, it stops instead of guessing. `status.paths.runtime` identifies the active state directory. Local .gitignore files ignore runtime data without changing the root .gitignore. Logs can contain private information; keep runtime data local. Concurrent execution remains project-locked; different session bindings do not isolate working trees. 完整 `.claude/scripts` 必须一起复制，其中包含 runner 导入的 goal-contract.mjs。所有新计划/成果评审保存 evidenceFormat=files-v1、文件指纹和 snapshotFile；旧报告保留，但依赖评审的操作要求重新评审。
