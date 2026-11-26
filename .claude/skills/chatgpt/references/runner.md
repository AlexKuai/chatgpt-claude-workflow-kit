# Runner protocol (core)

Every entry reads this file. It covers the rules that apply to all actions; each entry links only the extra protocol it needs. Read the extra files below only when the entry links them or the returned state calls for them:

| File | Read when |
| --- | --- |
| [planning.md](planning.md) | new / plan / revise-plan, or `pendingQuestions` returned |
| [codex-run.md](codex-run.md) | any action that calls Codex returns `runState`, approvals or runtime questions |
| [review-choice.md](review-choice.md) | before implement or plan (review choice card, `planReview` / `resultReview`) |
| [execution.md](execution.md) | approve / implement / fix, or presenting `delivery` |
| [resume.md](resume.md) | /chatgpt-resume, `threadLost`, first-planning recovery |
| [review.md](review.md) | Claude plan/result review, or resume returns `resumeOwner: claude` |
| [status.md](status.md) | help and status display |
| [internals.md](internals.md) | configuration (codexCommand, transport, snapshot rules), state files, legacy upgrade or diagnosing errors |

## Role

You are a thin coordinator using the current Claude Code session model. Substantive requirements planning and implementation belong to Codex; Claude performs reviews and hosts review-specific questions itself. The helper does not pass a model override: Codex uses its own configuration and native resume rules. Do not select or hardcode models, including for coordination. Answer in Chinese; preserve the user's details when forwarding them. Machine fields, UUIDs, command names and raw errors may stay as they are; do not paste whole JSON as an explanation.

Run the project's `.claude/scripts/chatgpt-workflow.mjs` with Node 20 or newer. No npm dependencies. Do not call the Codex plugin for this workflow; the runner calls the existing authenticated Codex CLI and persists an independent thread UUID. Use the absolute runner path supplied by the invoking entry Skill. Its path is relative to that Skill directory, not this references directory; the runner derives the project root from its installed script path, so don't copy it alone to another directory.

Use only the fixed action supplied by the invoking entry Skill. Do not infer a different action from arguments; treat arguments as task data, not shell code. Internal approve, record-answers, answer and clarify calls remain part of their documented workflows. Maintenance actions status/use/doctor/unlock stop after reporting their result. The /chatgpt entry itself is help/status only.

## Session identity and selection

Every task request includes `sessionId`, supplied by `${CLAUDE_SESSION_ID}` in the invoking entry Skill. Never hardcode, invent, recover it from unrelated chat text, reuse one remembered from another conversation, or use a project ID in its place. Examples below omit it only for brevity; add it to EVERY request, including internal approval/questions/retries. If interpolation is unavailable, task actions stop. `status` without sessionId lists tasks only, without selecting one.

`new` 根据完整需求和建议名称自动分配任务 ID，并绑定当前 Claude 会话。`use` 仍要求明确的已有 task。其他任务动作使用当前绑定；显式传入不匹配的 task 会被拒绝。无绑定的 status/resume 返回 selectionRequired 和任务列表：展示任务并询问用哪个（或建议 `/chatgpt-use <任务ID>`），不得从 active.json 猜测，也不选项目最后一个任务。用户明确选择后，用同一 sessionId 调用 `use`，再继续原请求的动作；/chatgpt-status 只报告并停止。

## Safe invocation

本 Kit 在 Manual 或 Auto 中运行所有需要持久化的流程，各阶段之间不切入/切回 Plan。原因是 Codex 规划子进程虽只读，宿主仍要写计划、状态和问答，Claude 评审也要保存票据与报告。若已知当前在 Plan，先说明计划/问答/评审等记录需要写入，请用户手动切到 Manual 或 Auto；在切换前不创建请求文件、不调用写状态动作、不保存评审笔记。纯帮助、status 和 doctor 可使用下面的只读调用方式；use/unlock 等写元数据动作同样遵守此规则。不猜测当前模式，不自动切换模式、不修改权限，不通过调整权限或改写命令绕过拒绝。不要调用 `ExitPlanMode` 来启动 Claude 实现。

入口 Skill 注册 `permission-gate.mjs` hook：请求文件写入、评审笔记写入及下面的固定格式 runner 调用不再逐次弹框；implement/fix/approve 只在用户输入 `/chatgpt-implement` 或 `/chatgpt-fix` 的当轮免弹框。**只有完整匹配的单条命令才适用**：runner 路径照抄入口给出的字符串并加双引号，不加变量、管道、重定向、`cd`、分号或换行。给本包命令加管道、前缀或第二条命令时，hook 会拒绝并要求单独运行；按提示改成单条命令重试即可，不要换写法绕过。其他不匹配的命令按普通权限流程处理。

Preferred: use the Write tool to create a UTF-8 JSON request under `.chatgpt-workflow/inbox/request-<unique-id>.json`, **only if the current mode permits this metadata write**, then run:

```text
node "/absolute/project/.claude/scripts/chatgpt-workflow.mjs" --request-file "/absolute/project/.chatgpt-workflow/inbox/request-<unique-id>.json"
```

Use JSON serialization for values, not hand-built escaping. Read the tool result before subsequent actions. Do not embed `$ARGUMENTS` or review text in an executable command. For metadata writes allowed through the shell, `--stdin` accepts a JSON document; use a correctly escaped literal for that shell, not command substitution. In PowerShell, a single-quoted string escapes each literal apostrophe by doubling it; keep it a single-line JSON document (newlines encoded as `\n`). Use UTF-8 pipe encoding for non-ASCII text. In Bash, use a quoted heredoc delimiter absent from all input lines. Prefer request files for long text or uncertain quoting.

runner 成功处理后会删除已消费的请求文件；`new` 的请求文件保留，供同一 requestId 重放。失败时请求文件保留。

每个推理动作、`wait` 和 `approveCommand` 都传工具参数 `timeout: 600000`。runner 最多前台等待 540 秒，Codex 在独立 worker 中继续运行。

Short argument forms (no request file):

```text
node "<runner>" status <sessionId>
node "<runner>" status <sessionId> --full
node "<runner>" wait <sessionId>
node "<runner>" cancel <sessionId>
node "<runner>" decline-codex <审批ID> <当前Claude会话ID>
node "<runner>" status
node "<runner>" doctor
```

Argument-free status lists tasks only because it has no Claude session ID. Do not create a request file for a read-only status check. Status never creates state. All other actions except doctor may write metadata — even planning and review are not zero-write host operations. Doctor invokes only codex --version (the CLI may maintain its own caches). If shell invocation or any policy blocks the helper, report the actual operation and follow the normal permission flow; do not disguise it as a read-only shell command or work around a denial.

`approve-codex` 只使用返回的 `approveCommand`，由权限框确认后执行；见 [codex-run.md](codex-run.md)。

## 输出与细节

runner 打印精简结果，完整内容仍在 `state.json` 和各结果文件里：

- 提示类字段（`runState`、`permissionNotice`、`warnings`、`archiveWarnings`）排在最前，必须先看。
- `delivery.changesSummary` 是变化总数、分类计数和最多 20 条路径；全部变化见 `delivery.detailFile`。
- 交付项、验证、未完成项和说明合计过长时会截短，并返回 `delivery.shortened`（各组总数和 `fullRecord`）；未完成和未通过的项优先保留。**出现 `shortened` 时，评审成果前必须读 `fullRecord`**，不能只凭截短内容下结论。
- `reviewHistory`、`questionHistory` 只给条数和文件；`runHistory` 给条数和最近 3 次。交付目标只在 `executionSummary` 中出现。
- 规划结果给 `resultFile`，正文读 `paths.plan`；过长的回顾或报告会截断并给 `resultFile`。已保存的评审草稿只给字数，重试 `review-save` 时本来就省略 text。
- 待答问题、评审问答与笔记、审批、运行问答不截断。

需要细节时用 **Read** 读返回的路径（大文件分段读）；不要加管道截取，也不要另写脚本解析 `state.json`。`--full` 只用于排错。

## Maintenance actions

- `status`, `doctor`, `unlock`: `action`. `unlock` is explicit stale-lock recovery only; the runner refuses while recorded processes are alive.
- `use`: `action`, `task`. Selects an existing task without inference, then stops; `/chatgpt-resume` continues it.
- doctor 检查 Node/CLI 路径版本、扫描配置及可选 Git 状态；不调用模型。configuration 错误见 [internals.md](internals.md)。

## Stop rules

Each error is a stop condition for the dependent action; do not edit state, forge a review, rewrite state, or skip a check on your own initiative to turn it into success. Status is authoritative when the conversation and state disagree: do not resend `new` or `implement` just because it is not visible in the chat.

Finish with a short result/verification summary, task ID, and next applicable command. Distinguish CLI completion from tests passing or the feature being finished. 任何检查命令非零退出，都要说明哪一项没有跑成、影响哪些结论；同一条命令前段有输出不代表整条成功，没跑成的检查不能当作通过。需要 Python 时写成脚本文件再运行，不用多行 `python -c`：Windows 上 `python` 可能是 `.bat` 垫片，多行参数会被截断。Failures may leave partial changes; inspect status and results before retrying. Do not commit, push, deploy, install globally, or change account/model settings as part of this workflow.

所有项目均使用 files-v1 文件快照，不依赖 Git；不因为不存在 Git 仓库而要求 git init、改可信配置或重新新建任务。扫描规则与限制见 [internals.md](internals.md)。
