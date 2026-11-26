# Runner protocol

Run the project's `.claude/scripts/chatgpt-workflow.mjs` with Node 20 or newer. No npm dependencies. Do not call the Codex plugin for this workflow; the runner calls the existing authenticated Codex CLI and persists an independent thread UUID.

## Session identity and selection

Every task request includes `sessionId`, supplied by `${CLAUDE_SESSION_ID}` in the invoking entry Skill. Never hardcode, invent, recover it from unrelated chat text, or use a project ID in its place. Examples below omit it only for brevity; add it to EVERY request, including internal approval/questions/retries. If interpolation is unavailable, task actions stop. `status` without sessionId lists tasks only, without selecting one.

`new` 根据完整需求和建议名称自动分配任务 ID，并绑定当前 Claude 会话。`use` 仍要求明确的已有 task。其他任务动作使用当前绑定；显式传入不匹配的 task 会被拒绝。无绑定的 status/resume 返回 selectionRequired 和任务列表，等待用户明确选择或新建；不得从 active.json 猜测。自动命名不会改变已有任务或其 UUID。

## Safe invocation

本 Kit 在 Manual 或 Auto 中运行所有需要持久化的流程。若已知当前在 Plan，先说明计划/问答/评审等记录需要写入，请用户手动切到 Manual 或 Auto；在切换前不创建请求文件、不调用写状态动作。纯帮助、status 和 doctor 可使用下面的只读调用方式。不通过调整权限或改写命令绕过拒绝。

入口 Skill 注册 `permission-gate.mjs` hook：请求文件写入、评审笔记写入及下面的固定格式 runner 调用不再逐次弹框；implement/fix/approve 只在用户输入 `/chatgpt-implement` 或 `/chatgpt-fix` 的当轮免弹框。**只有完整匹配的单条命令才适用**：runner 路径照抄入口给出的字符串并加双引号，不加变量、管道、重定向、`cd`、分号或换行。给本包命令加管道、前缀或第二条命令时，hook 会拒绝并要求单独运行；按提示改成单条命令重试即可，不要换写法绕过。其他不匹配的命令按普通权限流程处理。

Preferred: use the Write tool to create a UTF-8 JSON request under `.chatgpt-workflow/inbox/request-<unique-id>.json`, **only if the current mode permits this metadata write**, then run:

```text
node "/absolute/project/.claude/scripts/chatgpt-workflow.mjs" --request-file "/absolute/project/.chatgpt-workflow/inbox/request-<unique-id>.json"
```

Use JSON serialization for values, not hand-built escaping. Read the tool result before subsequent actions. Do not embed `$ARGUMENTS` or review text in an executable command. For metadata writes allowed through the shell, `--stdin` accepts a JSON document; use a correctly escaped literal for that shell, not command substitution. In PowerShell, a single-quoted string escapes each literal apostrophe by doubling it; keep it a single-line JSON document (newlines encoded as `\n`). Use UTF-8 pipe encoding for non-ASCII text. In Bash, use a quoted heredoc delimiter absent from all input lines. Prefer request files for long text or uncertain quoting.

每个推理动作、`wait` 和 `approveCommand` 都传工具参数 `timeout: 600000`。runner 最多前台等待 540 秒，Codex 在独立 worker 中继续运行。

Short argument forms (no request file):

```text
node "<runner>" status <sessionId>
node "<runner>" status <sessionId> --full
node "<runner>" wait <sessionId>
node "<runner>" cancel <sessionId>
node "<runner>" decline-codex <审批ID> <当前Claude会话ID>
```

`approve-codex` 只使用返回的 `approveCommand`，由权限框确认后执行。

### 输出与细节

runner 打印精简结果，完整内容仍在 `state.json` 和各结果文件里：

- 提示类字段（`runState`、`permissionNotice`、`warnings`、`archiveWarnings`）排在最前，必须先看。
- `delivery.changesSummary` 是变化总数、分类计数和最多 20 条路径；全部变化见 `delivery.detailFile`。
- 交付项、验证、未完成项和说明合计过长时会截短，并返回 `delivery.shortened`（各组总数和 `fullRecord`）；未完成和未通过的项优先保留。**出现 `shortened` 时，评审成果前必须读 `fullRecord`**，不能只凭截短内容下结论。
- `reviewHistory`、`questionHistory` 只给条数和文件；`runHistory` 给条数和最近 3 次。交付目标只在 `executionSummary` 中出现。
- 规划结果给 `resultFile`，正文读 `paths.plan`；过长的回顾或报告会截断并给 `resultFile`。已保存的评审草稿只给字数，重试 `review-save` 时本来就省略 text。
- 待答问题、评审问答与笔记、审批、运行问答不截断。

需要细节时用 **Read** 读返回的路径（大文件分段读）；不要加管道截取，也不要另写脚本解析 `state.json`。`--full` 只用于排错。

Argument-free convenience actions:

```text
node "/absolute/project/.claude/scripts/chatgpt-workflow.mjs" status
node "/absolute/project/.claude/scripts/chatgpt-workflow.mjs" doctor
```

Argument-free status lists tasks only because it has no Claude session ID. For current-session help/status, use `status <sessionId>`. Do not create a request file for a read-only status check. If shell invocation is blocked, report it normally; do not bypass permissions. Status never creates state. All other actions except doctor may write metadata. Doctor invokes only codex --version (the CLI may maintain its own caches). The runner derives the project root from its installed script path; don't copy it alone to another directory.

## JSON actions

- `new`：`action`、真实 `sessionId`、完整非空 `text`、本次创建 UUID `requestId`，以及可选 `suggestedTask`。新公开入口不传 task。Claude 根据需求生成简短英文建议名称；脚本规范化成小写字母、数字和连字符，最多 64 字符；缺失、规范化后为空或 Windows 保留名称则回退 `task-需求SHA256前8位`。同名在项目锁内从 -2 递增，必要时截短，不覆盖目录或已保留名称。底层兼容显式 task（原有 1–64 位小写字母、数字、下划线或连字符）；该旧调用可不传 requestId，显式重名仍报错而非改名。
- `plan`, `revise-plan`, `fix`: `action`, optional `text`.
- `clarify`: `action`, `text` (a user's question about requirements/options). Ask Codex for a read-only explanation on the same UUID without replacing the pending round, recording a choice, or marking the plan ready. This supports "explain the options first" inside a question card.
- `record-answers`: `action`, `roundId`, `answers: [{id, answer}]` (any nonempty explicit subset). Persist partial answers immediately after each batch or text reply without calling Codex. `pendingQuestions.partialAnswers` survives restarts; ask only remaining questions. Submit the full saved set through `answer` once complete. Cancellation and timeout without explicit answers do not call this action.
- `answer` (internal, normally automatic after the question cards): `action`, `roundId` (the current `pendingQuestions.id`), `answers: [{"id":"<question-id>","answer":"<exact user response and notes>"}]`. All pending questions must have nonempty explicit answers. A stale round or changed saved retry payload is rejected. Answers are persisted before Codex is called; a failed delivery is retried with the identical saved payload. No extra user command is needed for each answer.
- `approve`: `action`, optional `withoutReview:true`. 只在用户本次明确选择跳过评审时使用；仅当 `planReview` 为 `none` 或 `stale` 时接受，其他状态拒绝。不带该参数时检查与原来一致。
- `implement`, `resume`, `status`, `doctor`, `unlock`: `action`.
- `resume` 另有可选 `rebuildThread:true`：只在用户于会话恢复卡片中明确选择时使用；没有与当前 UUID 一致的 `threadLost` 记录时拒绝。

`status` 的 `executionSummary` 另含：

- `planReview`：`current` 已有评审，按原流程由 `approve` 核对；`none` 没有评审；`stale` 评审后文件有变化；`in-progress` 有未完成的评审；`unavailable` 现在不能批准，原因见 `planReviewNote`。跳过评审的计划只要启动过执行就是 `unavailable`，不会重复执行；唯一例外是明确失败（`execution-failed`）且确认没有文件变化。
- `resultReview`，原因见 `resultReviewNote`。**只有 `current` 表示成果评审有效**，不能因为有历史报告或阶段是 reviewed-code 就说有效：
  - `current`：计划版本、执行轮次、报告、文件快照和扫描规则全部一致；没有未完成评审时，与 `fix` 接受评审的条件相同。
  - `none`：本轮实现或修复还没有成果评审。
  - `stale`：评审后项目文件或扫描规则有变化。
  - `invalid`：报告被修改、缺失或为旧格式。
  - `in-progress`：成果评审未完成。
  - `unknown`：无法扫描文件，不能判断。
  - `unavailable`：没有可评审的成果，或已开始新规划。

跳过计划评审的执行带 `delivery.planReview:"skipped"`。成果评审不是 `current` 就 `plan` 时，runner 把自报结果、未完成项和内容完整的已有成果评审一并交给 Codex 核对，并返回 `reviewNotice`；报告不可信时不附正文。runner 本身不拦截。判断结果在开始规划时存入 `delivery.reviewAtPlanning`，之后再次规划沿用它。
- `use`: `action`, `task`.
- `wait`, `cancel`: `action`. 不占项目锁。等待本会话进行中的执行；取消先中断 turn，10 秒后终止进程树。没有执行时返回 `runState: none`。
- `approval-decline`: `action`, `sessionId`, `id`, 可选 `text`（用户原话）。所有交互提交校验当前负责人，不能省略会话 ID。
- `user-input-record-answers`: `action`, `sessionId`, `id`, `answers: [{id, answer}]`，保存本次真实回答子集；返回 `saved`、`userInput.partialAnswers` 和 `unansweredQuestionIds`。支持明确更正，保留历史。
- `user-input-answer`: `action`, `sessionId`, `id`，提交已暂存的完整答案；兼容一次传入完整 `answers`。缺题、空白、重复 ID 均拒绝；重复最终提交不再次回复 Codex。30 分钟未完成则保留历史并记录未回答，不视为同意。
- 运行问答先保存在外部控制目录的 `interactions/<请求ID>.json`，再归档到任务目录的 `<运行ID>.runtime-questions.json`；不并发改写 task state。归档失败不清理外部记录，后续续接先重试。Codex 后续调用会收到相关问答历史。
- use 使用独立的短时绑定锁，resume 使用短时交互锁转移负责人及代次；不释放长执行锁、不重启任务。审批 gate 绑定负责人及代次，接管前尚未提交的 gate 作废；已提交决定保留。
- 推理动作返回 `runState`：`completed`（含原有状态字段）、`awaiting-approval`、`awaiting-user-input`、`running`。处理规则见 workflow.md 的“Codex 权限请求”。`resume` 遇到进行中的执行时只继续等待，不启动新 turn。
- `review-start`: `action`, `kind` (`plan`, `result`, or legacy `code`), optional `text` focus. Returns opaque `ticket`, source `version`, `reviewSession` and relevant paths/snapshot. Reuses an unfinished same-version review; changed source creates a new ticket and archives old answers without reusing them. Internal state/report kind `code` remains unchanged for compatibility.
- `review-questions`: `action`, `kind`, `ticket`, `questions` (same question shape as planning: 1–3 unique IDs/texts, header <=12, multiSelect, 2–4 options or []), optional `text` notes. Saves a new round in reviewSession.rounds and returns pendingRoundId. Cannot replace an unanswered round. No Codex call.
- `review-record-answers`: `action`, `kind`, `ticket`, `roundId`, `answers: [{id,answer}]`. Save any nonempty explicit subset immediately. Corrections to the current round replace that staged answer; earlier rounds remain historical. Every answer must be nonempty and match a unique ID. No Codex call.
- `review-save`: `action`, `kind`, `ticket`, `text` full review, optional confirmed `model` (otherwise null). All review questions must be answered. Persists a draft first, then writes a report with verbatim Q&A appended and marks review complete. On interrupted save, omit text to retry reviewSession.draft unchanged. An identical completed save can be retried; changed text or source requires a new review. Model attribution is informational, not attestation.

No `review-save` should launch Codex. No `approve` should launch Codex. `/chatgpt-implement` performs approve and implement sequentially after checking the displayed plan and the user's implementation request. Each error is a stop condition for the dependent action; do not edit state to turn it into success. After a save error, status distinguishes an unfinished draft from a completed matching ticket. A `warnings` result about history export means authoritative state and final report succeeded but a derived JSON/Markdown copy failed; disclose it and retry the same save ticket after correcting the export problem, not the whole review. 所有新计划/成果评审保存 evidenceFormat=files-v1、文件指纹和 snapshotFile。旧报告保留，但依赖评审的操作要求重新评审，不能沿用旧验证规则。

规划动作使用 `--output-schema` 返回 `status`、`plan`、`questions`、`contract`。`needs_questions` 包含 1–3 个问题，目标未定时 contract 为 null；`ready` 必须包含完整目标与执行步骤，questions 为空。问题仍使用稳定 ID、原文、短标题、选项和 multiSelect。无效结果不能完成规划，pendingQuestions 阻止评审与批准；answer 仍为只读规划。

`contract` 字段：kind 为 investigate / modify / investigate-and-modify，deliverables 为唯一的 `{id,description}` 列表，allowedChanges / excludedChanges / acceptanceCriteria 为文本列表。调查报告不授权业务文件修改，因此 allowedChanges 为空；要求修改项目文档也属于 modify。目标清楚时不重复提问，有歧义时必须问答，不能根据命令名猜测授权。正文 plan 只包含未来执行细节，目标摘要由脚本生成到 plan.md 顶部。`state.plan.contract` 与 contractHash 保存结构化目标；计划版本同时包含目标和正文哈希，任一变更使批准失效。revise-plan 只有目标未变化才可能保留评审修订关系。

implement/fix 也使用 `--output-schema`：`outcome` 为 completed/partial/blocked，`deliverables` 每个计划 ID 恰好一次，包含 id/status/summary/evidence；`verification` 包含 description/status/evidence，状态为 passed/failed/blocked/not-applicable；另有 unfinished、changeExplanation 和完整中文 Markdown report。字段和交付项覆盖校验不能验证语义及证据真实性。自报 completed 与未完成事项、失败/受阻验证不兼容；部分或受阻必须说明原因。完成项与验证需提供证据或具体限制说明。

执行结果原文保存为 `<run>.result.raw.txt`，有效结果另存 `<run>.result.json`，report 继续保存为 `<run>.result.md`。无效或空输出不重跑，保留原文并令 delivery.assessment=invalid-result；正常完成的 CLI 状态仍是 completed。调用失败则是 execution-failed，可能已经有部分修改。`state.delivery` 保存最近执行的逐项结果、警告及路径；每次完成的执行还保存 `<run>.delivery.json`，resume 不覆盖交付记录。每次 implement/fix 保存 `<run>.before.snapshot.json` 和 `<run>.after.snapshot.json`，与第一次实现基线用途不同。无变化的修改任务发出核对提示，有变化也不等于完成；快照失败时变化状态为未知。

每次执行前，Skill 根据 status.executionSummary 和实际计划展示范围；这不是额外审批动作。旧计划缺少 contract 时禁止 approve/implement/fix，请用 /chatgpt-plan 补齐并重新评审。不要手动编辑 state 补目标或复用旧批准。完整 `.claude/scripts` 必须一起复制，其中包含 runner 导入的 goal-contract.mjs。

`questions.json` and `questions.md` preserve Codex planning rounds. `review-questions.json` and `review-questions.md` preserve Claude review sessions and rounds, including superseded-source history. `state.json` is authoritative; these are readable/exportable copies. On export failure, state may already contain the answer; inspect status before assuming it was lost. `/chatgpt-resume` returns `resumeOwner: claude` with reviewSession for unfinished reviews, including stale status and any saved draft; continue with the shared review workflow, never Codex. Otherwise pending planning questions return without a Codex call; saved full answers can retry delivery. First check for an existing run: resume attaches to it without a new turn or changed sandbox. Only with no existing run and neither pending flow does resume request a read-only Codex recap. The runner never modifies Claude transcript files.

## Files and compatibility

### 创建请求去重

entry 使用本地 UUID 生成器生成并保存 requestId，不向用户询问。每次新用户操作使用新 UUID；同一工具请求重试必须复用原 UUID 与原 text，不因名称冲突、启动失败或丢失工具输出换 UUID。完整需求不剥离首词，text 哈希基于原始文本（包括空白），不是 Claude 改写的摘要。suggestedTask 仅为首次分配建议，重试改变建议名称不会重命名原任务；改变需求、显式 task 或 sessionId 则拒绝。

项目锁内先保存 `.chatgpt-workflow/creations/<requestId哈希>.json` 名称保留与需求哈希，再创建任务；`state.creation` 保存同一创建信息及最多 160 字符的需求摘要。正常重复请求返回 creationReplay=true 和原状态，不调用 Codex，不创建新任务。若原会话尚未完成绑定则补齐绑定；若已经绑定其他任务则保留该绑定，返回原 task 与实际 sessionBinding 的差异，不能静默切回旧任务。创建标识已保存但任务状态缺失/不一致时停止并明确报错，不分配第二个任务来掩盖保存失败。

Codex 启动失败不等于任务未创建。返回/重放状态保留失败阶段、错误和可能已有的 threadId；无 UUID 时由显式 resume 按首次启动恢复规则检查并处理，有 UUID 时按原规则恢复。不得因为 lastRun 失败就把重复 new 当作执行重试。首次规划明确失败且没有 UUID 时，用户执行 `/chatgpt-resume` 可在原任务中重试首次规划；runner 先核对进程与事件日志，发现 UUID 则恢复它，结果不明或进程可能仍运行时停止。保留原需求、绑定和失败记录，不生成第二个任务。已有 UUID 的正常恢复仍不重跑实现或修复。名称仅为标识，后续 plan/revise-plan 不重命名任务。

The runner saves `.chatgpt-workflow/sessions/<hash>.json` bindings (session ID + project root + task), compatibility active.json, task state and all prior artifacts. Schema-1 task state remains readable/resumable; old reports retain their original hashes/versions for historical inspection, but implementation/fixes require a newly reviewed structured goal. Existing tasks require explicit `/chatgpt-use` the first time a Claude session is bound. It continues an existing legacy `.astra-workflow/active.json` in place, preserving artifact paths and UUIDs. If both roots have active state, it stops instead of guessing. `status.paths.runtime` identifies the active state directory. Local .gitignore files ignore runtime data without changing the root .gitignore. Logs can contain private information; keep runtime data local. Saved UUIDs require corresponding Codex history in the same local CLI environment; state files alone do not transplant history. Restoring a Claude chat selects its binding on the next kit call, without hooks or restoring Git files. Concurrent execution remains project-locked; different session bindings do not isolate working trees.

所有项目均使用 files-v1 文件快照，不依赖 Git。快照按内容哈希记录新增、修改、删除和类型变化；Git 状态、提交和差异只作辅助，不参与评审版本判断。固定排除 .git、.chatgpt-workflow、.astra-workflow 和 .claude/settings.local.json（Claude Code 保存权限选择时会改写它；执行期间的改动仍由防篡改检查报告）；默认排除 node_modules、.venv、__pycache__、.cache、.vs、.next、.nuxt、.turbo、coverage、test-results、playwright-report、.playwright-mcp、.pytest_cache、.mypy_cache、TestResults；bin/obj 仅在同级有 *.csproj、*.fsproj、*.vbproj 时排除，target 仅在同级有 Cargo.toml、pom.xml 时排除。扫描不采用 .gitignore，dist/build 默认纳入。排除目录不算已检查。UTF-8 文本每文件最多 1 MiB，每次快照最多新增 32 MiB 原文备份，按内容哈希去重；二进制、大文件及预算外内容只记录指纹和未备份原因。不能据此承诺完整回滚。

默认传输为 `codex app-server`（JSON-RPC over stdio）：规划类只读沙箱，implement/fix 为 workspace-write，`approvalPolicy=on-request`，`approvalsReviewer` 按 Claude 模式取 user 或 auto_review；启动后核对 Codex 实际生效的沙箱与审批方，不符即停止。可重试的连接错误只记进度，成败以 turn/completed 为准。未知类型或无法完整展示的请求一律拒绝，规划阶段的文件修改一律拒绝，从不使用会写入持久规则的批准。审计写入 `<run>.approvals.jsonl`，原始协议写入 `<run>.rpc.jsonl`。

待审批记录、决定与 HMAC 密钥保存在 `~/.chatgpt-claude-kit/<项目哈希>/`（可用 CHATGPT_KIT_HOME 改位置），因为项目目录与临时目录对 Codex 可写。该位置若落入 Codex 可写范围则拒绝所有审批。执行期间若本包脚本、Skill 或 `.claude` 权限配置被改动，后续批准失效并在 `kitFilesChanged` 中报告。此机制防误批和模型跳步，**不防**能以你的账户读取用户目录的恶意进程。

回退：项目配置 `{"transport":"exec"}` 使用 `codex exec`，没有审批回传，越权请求直接失败。`{"permissions":{"auto":"auto_review"}}` 可改为 `"ask"`（Auto 下也弹权限框）或 `"never"`（Auto 下直接失败）。

exec 回退使用 `shell:false`, prompts over stdin, explicit sandbox, `approval_policy="never"`, and an explicit UUID for existing-session resume. Both exec and exec resume receive --skip-git-repo-check; this changes only repository checking, not sandbox permissions or approvals. It passes no model override, reasoning-effort override, profile selection, or ignore-user-config flag. Codex selects its model using its native configuration and resume rules. A temporary model choice in a separate interactive Codex window need not become the configuration for a new CLI process. Neither Skill overrides the current Claude Code model. `never` means a non-interactive child fails when extra approval is needed; it does not disable the sandbox or bypass Claude's host permission check. Do not add dangerous bypass flags or automatically relax sandboxing on failure.

If Codex is not discoverable (including Windows npm shims), create **only this project's** optional `.claude/chatgpt-workflow.json`:

```json
{"codexCommand":["C:/absolute/path/to/codex.exe"]}
```

Or use `["node", "/absolute/path/to/node_modules/@openai/codex/bin/codex.js"]`. Use an executable/argument array, never a shell command string or `.cmd`/`.bat`. Do not copy machine-specific paths to another computer without adjusting them. Never put credentials in this file.

The old project-local `astra-workflow.json` is accepted as an executable-path fallback if `chatgpt-workflow.json` is absent. This does not read or force any old model setting; model selection belongs to Codex.

## 文件快照与首次启动恢复

所有项目均使用 files-v1 文件快照，不依赖 Git。快照按内容哈希记录新增、修改、删除和类型变化；Git 状态、提交和差异只作辅助，不参与评审版本判断。固定排除 .git、.chatgpt-workflow、.astra-workflow 和 .claude/settings.local.json（Claude Code 保存权限选择时会改写它；执行期间的改动仍由防篡改检查报告）；默认排除 node_modules、.venv、__pycache__、.cache、.vs、.next、.nuxt、.turbo、coverage、test-results、playwright-report、.playwright-mcp、.pytest_cache、.mypy_cache、TestResults；bin/obj 仅在同级有 *.csproj、*.fsproj、*.vbproj 时排除，target 仅在同级有 Cargo.toml、pom.xml 时排除。扫描不采用 .gitignore，dist/build 默认纳入。排除目录不算已检查。UTF-8 文本每文件最多 1 MiB，每次快照最多新增 32 MiB 原文备份，按内容哈希去重；二进制、大文件及预算外内容只记录指纹和未备份原因。不能据此承诺完整回滚。

项目配置 snapshot.excludeDirectories 为普通排除目录数组，替换默认项；单目录名匹配各层级同名目录，含 / 则匹配根目录相对路径。不支持通配符、绝对路径、..。固定排除目录不能取消。规则哈希参与版本判断。内容哈希不含 Git 信息、时间戳、备份路径。

会话丢失：`thread/resume`（exec 为启动会话前的错误输出）明确返回 `no rollout found for thread id <本任务 UUID>` 时，没有启动回合。runner 把本次动作改过的阶段、版本、批准、评审、执行轮次和 delivery 还原，保留失败记录与已保存的回答，并写入 `threadLost`（UUID、时间、动作、runId）。其他错误按普通失败处理。重建后的新 UUID 在回合启动时写入，旧 UUID 进入 `threadHistory`，`threadLost` 清除；在此之前失败可再次重建。原会话恢复成功也会清除 `threadLost`。runner 从不自动重建。

收尾：以 Codex 主进程退出为准，随后最多约 2 秒读完剩余输出。残留进程不结束，记录 `lastRun.leftoverProcesses:true`；实现和修复另在 `delivery.warnings` 说明，之后的文件改动由快照校验发现。主进程已退出后不再按其 PID 结束进程。

文件占用：任务文件被其他程序短暂占用时自动重试，保存最多约 10 秒，读取和锁约 1 秒。返回“无法保存 …”表示一直被占用：原样告诉用户是哪个文件，请用户关闭占用它的程序，再用 status 和实际文件核对。此时状态可能停在执行中，但 Codex 可能已经完成，输出在任务目录的 `<运行ID>.*` 文件；**不重新执行**，成果可用 `/claude-review-result` 评审。

首次失败恢复：首次规划明确失败且没有 UUID 时，用户执行 `/chatgpt-resume` 可在原任务中重试首次规划；runner 先核对进程与事件日志，发现 UUID 则恢复它，结果不明或进程可能仍运行时停止。保留原需求、绑定和失败记录，不生成第二个任务。已有 UUID 的正常恢复仍不重跑实现或修复。 原始需求优先来自 state.requirements，旧任务从原 request.txt 读取并核对创建需求哈希。成功恢复前的运行放入 runHistory；所有原始事件、错误和结果文件保留。日志损坏、发现已完成的运行、记录结果不明或进程可能仍活跃时停止。不要手工清空 UUID、改 state 或反复调用 new。

files-v1 的 entries 记录 path/type/size/hash、适用平台的 executable，以及 contentFile 或 backupReason。文本备份只在任务 objects/ 中按 SHA256 保存；比较产生 added/modified/deleted/type-changed。实施前基线与每次执行前后快照作用不变。旧 Git 基线保留，升级当前快照另存为 upgradeSnapshot，不是实施前内容。新审批含 evidenceFormat，旧评审刷新后再继续依赖操作。
