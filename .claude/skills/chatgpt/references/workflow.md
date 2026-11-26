
# ChatGPT project workflow

The invoking entry Skill supplies a fixed runner action and user arguments. The action is not taken from user text.

You are a thin coordinator using the current Claude Code session model. Substantive requirements planning and implementation belong to Codex; Claude performs reviews and hosts review-specific questions itself. The helper does not pass a model override: Codex uses its own configuration and native resume rules. Do not select or hardcode models, including for coordination. Claude reviews through `/claude-review-plan` or `/claude-review-result`. Answer in Chinese; preserve the user's details when forwarding them.

Read [runner protocol](runner.md) before the first invocation in this context. Use the absolute runner path supplied by the invoking entry Skill. Its path is relative to that Skill directory, not this references directory; derive the project root from the script path, not an unrelated shell working directory.

Include the entry's actual Claude `sessionId` in EVERY JSON request below, including internal actions. Do not reuse a session ID remembered from another conversation. The runner uses the current session's binding, not project active.json. On `selectionRequired`, display available tasks and ask which one to use (or suggest the explicit `/chatgpt-use <task-id>` command); never pick the last project task. If the user explicitly chooses, call `use` with that task and the same sessionId, then continue the originally requested action. /chatgpt-status only reports and stops. Missing/unexpanded session ID blocks task actions rather than guessing.

## Dispatch

| Fixed action and accepted arguments | Runner request / behavior |
| --- | --- |
| `new <requirements>` | `{"action":"new","text":"<完整需求>","suggestedTask":"<Claude建议名称>","requestId":"<本次新建UUID>"}`，同时传真实 sessionId。脚本生成实际任务 ID，新操作创建新任务，不覆盖已有任务；相同 requestId 重放只返回原状态。 |
| `plan [message]` | `{"action":"plan","text":"<message>"}`. Read `status` first; when `resultReview` is `none`, `stale`, `invalid`, `in-progress` or `unknown`, ask with “评审选择卡片” BEFORE calling `plan`. Continue discussion when no question round is pending; invalidate prior review/approval. 返回 `reviewNotice` 时原样展示。 If answering pending questions, use the answer protocol below instead. |
| `revise-plan [focus]` | `{"action":"revise-plan","text":"<focus>"}`. Send saved Claude plan findings to the same Codex thread; change the plan only. |
| `implement` | Treat this explicit request as approval of the displayed current plan. Read `status` first. `planReview` `none`/`stale`: 先按“评审选择卡片”询问。Otherwise check the plan/review and unresolved decisions, run `approve`, then `implement`. Do not ask for the same approval again. |
| `fix [R1/R2 or focus]` | `{"action":"fix","text":"<focus>"}`. Pass the saved result review and exact decisions to Codex; validate findings against actual deliverables before modifying. |
| `resume` | Restore unfinished Claude review first, or Codex questions/answer delivery; 首次规划明确失败且没有 UUID 时按 runner 规则重试原任务规划，处理返回的 planningStatus/问题；其他情况由原 UUID 只读回顾，不实现。 |
| `status` | Show task, UUID, phase, current plan/review/last run; no Codex inference. |
| `use <task-id>` | Select existing task; no inference. Then use `resume` if a recap is wanted. |
| `doctor` | 检查 Node/CLI 路径版本、扫描配置及可选 Git 状态；不调用模型。 |
| `unlock` | Explicit stale-lock recovery only; runner refuses while recorded processes are alive. |

Use only the fixed action supplied by the invoking entry Skill. Do not infer a different action from arguments. For new, preserve all arguments as requirements; ask only when requirements are empty and generate the suggested name/request UUID as the entry directs. For use, an explicit existing task ID is still required; never guess a binding. Internal approve, record-answers, answer and clarify calls remain part of their documented workflows. Maintenance actions status/use/doctor/unlock stop after reporting their result; use/unlock write metadata and still require the appropriate permissions. Only explicit resume or planning actions enter the planning question loop; active implement/fix turns may also request runtime questions using the separate protocol below. The /chatgpt entry itself is help/status only.

new 成功后显示实际任务 ID、需求摘要和绑定，而不是建议名称。创建失败时从保存的原请求重放相同 requestId/text 获取状态，不以新 UUID 重试。同 requestId 不重复调用 Codex；实际需求改变必须是新的用户新建操作。creationReplay 返回旧任务而当前 sessionBinding 指向别的任务时，只展示差异，不自动切换或继续旧任务的问答/实现。后续需求变化不重命名任务。旧任务标识与 UUID 保留。

## Phase and permission rules

本 Kit 在 Claude 的 Manual 或 Auto 模式下运行，各阶段之间不切入/切回 Plan；模式由用户选择，见下方“Codex 权限请求”。原因是 Codex 规划子进程虽只读，宿主仍要写计划、状态和问答，Claude 评审也要保存票据与报告。两种模式都不是无条件放行。

若已知当前处于 Plan，在创建请求文件、调用写状态的 runner 或保存评审笔记之前，说明本次所需记录写入，请用户手动切到 Manual 后继续，不先尝试写入。纯帮助、status 和 doctor 的只读路径不要求切换；use/unlock 等写元数据动作同样遵守此规则。不猜测当前模式，也不自动切换模式或修改权限。

### Codex 权限请求

Codex 需要越出沙箱（执行命令、访问网络、改沙箱外文件、扩大权限、调用需确认的 MCP 工具）时，runner 返回 `runState: awaiting-approval`。去向取决于 Codex 本轮启动时的 Claude 模式：

| Claude 模式 | Codex 权限请求 |
| --- | --- |
| Manual（default）、acceptEdits | 由用户在 Claude Code 原生权限框逐项确认 |
| Auto、bypassPermissions | 由 Codex `auto_review` 按风险自动批准或拒绝，不弹窗，不是无条件放行 |
| dontAsk、模式未知 | 自动拒绝并列入执行结果 |
| Plan | 不启动实现/修复 |

处理 `awaiting-approval`：

1. 直接用 Bash 或 PowerShell 原样运行返回的 `approveCommand`（timeout 600000）。权限 hook 会弹出原生权限框并显示 Codex 的真实请求，**由用户决定**。不要先用文字或 AskUserQuestion 询问，不要改写、拼接或添加参数，不要自己生成 gate。
2. 用户选 Yes：命令返回下一个状态，按同样规则继续处理。
3. 用户选 No：运行 `declineCommand`；附有反馈时改用 JSON `approval-decline`（`id` 与用户原话 `text`），反馈会转给 Codex。不要重复请求同一审批，不要替 Codex 执行被拒命令，不要换写法绕过。
4. 只有用户明确说“本次运行内同类都允许”时，才在 `approveCommand` 末尾加 `--scope run`，它会再次弹框；不写入任何持久规则。
5. 命令报告缺少有效权限确认时，说明权限 hook 未加载，请用户运行 `/chatgpt-resume`（`/clear`、`/resume` 会移除 hook），不得绕过。

运行中问答（`runState: awaiting-user-input`）与规划阶段的 `pendingQuestions` 是不同协议，不能混用 roundId 或 record-answers：

1. 读取 `userInput.partialAnswers` 和 `unansweredQuestionIds`，只呈现尚未回答的问题；有选项用 AskUserQuestion，无选项用文字。分批提问时也遵守下面的保存规则。
2. 每收到一项或一批真实回答，立即调用 `user-input-record-answers`，传当前真实 `sessionId`、`userInput.id` 和本次子集 `answers: [{id, answer}]`。保持原文和补充说明。用户明确更正时用同一动作保存更正，不推断其他答案。
3. 保存成功后才在聊天中显示逐题保存回执；取消、跳过、空白和超时均不算回答。保存失败时保留可见原文，说明失败并重试保存，不要求用户重答已经给出的内容，也不先提交最终答案。
4. 未回答问题为空时，调用 `user-input-answer`，传当前 `sessionId` 和请求 `id`，不必重传答案；runner 会提交已保存的完整集合。部分答案不能直接用这个动作提交。
5. 用户要退出 Claude 时，先保存已经真实提供的答案。退出不等于取消任务；仅在用户要求停止时调用 cancel。恢复后读取暂存状态，只补问缺失项。
6. `archiveWarning` 表示答案仍保存在外部运行控制目录，尚未成功归档到项目；明确说明。下一次续接会重试归档，失败时先解决实际写入问题，不能删除记录或重跑实现。
7. 请求超时、撤回或运行取消后，答案保留为历史记录，不能自动提交到另一个问题请求。新的决策仍需依据当前有效问题确认。

Codex 主进程结束后最多约 2 秒就收尾，不等它留下的其他进程；`lastRun.leftoverProcesses` 为 true 时告诉用户有残留进程，本工具没有结束它，不要自行结束。

`runState: running` 时展示 progress 并用 wait 继续等待；不重复发起任务。取消覆盖启动和执行阶段：启动前取消不发出执行回合；执行请求已发出则可能已有部分修改。不要承诺回滚；实际已经完成的任务仍按完成结果呈现。

跨会话恢复：`/chatgpt-use <任务ID>` 仅选择并绑定任务，之后停止；`/chatgpt-resume` 才接管已有运行、继续审批或问答。接管沿用原 run 和 Codex UUID；旧会话尚未提交的审批凭据及后续答案提交失效，必须由当前负责人继续。不要复用另一会话的 sessionId。会话已有自己的活动运行时，先完成或按用户要求取消，不能直接改绑其他任务。

模式在下一个 Codex turn 生效。运行中由 Auto 切到 Manual 时，本轮仍由自动审查处理；用户要立即接管就 `cancel` 后恢复。结束时展示 `delivery.approvals`：批准与拒绝数、被拒项及原因、`kitFilesChanged`。被拒项可能使交付受阻，不能报告为已完成。

### 评审选择卡片

评审是推荐步骤，不是强制步骤。完整流程（已评审）不出现卡片，原有检查全部照旧。只在下面两处、并且用户本次命令没有写明选择时，用 AskUserQuestion 问一次：

| 时机 | 条件（`status` 的 executionSummary） | 选项 |
| --- | --- | --- |
| 收到 `/chatgpt-implement`，调用 `approve` 之前 | `planReview` 为 `none` 或 `stale` | “先评审计划（推荐）” / “跳过评审，直接实现” |
| 收到 `/chatgpt-plan`，调用 `plan` 之前 | `resultReview` 为 `none`、`stale` 或 `invalid` | “先评审成果（推荐）” / “跳过评审，继续规划” |
| 同上 | `resultReview` 为 `in-progress` | “先完成评审（推荐）” / “放弃这次评审，继续规划” |
| 同上 | `resultReview` 为 `unknown` | “先处理扫描问题（推荐）” / “跳过评审，继续规划” |

- 问题中写明计划版本；`planReview` 为 `stale` 时附上 `planReviewNote` 中变化的文件；规划前的卡片附上 `resultReviewNote`，并说明：开始新规划后不能再单独评审这次成果。
- **选先评审**：调用 `claude-review-plan` 或 `claude-review-result` Skill 完成评审，然后停下。评审完成不等于授权实现或规划；请用户再次输入原命令，`/chatgpt-plan` 的原文要完整回显以便重发。
- **选跳过**：立即继续，不再二次确认。实现用 `{"action":"approve","withoutReview":true}`，再 `implement`；规划直接调用 `plan`。
- **取消、跳过问题、空白、超时都不算选择**：停下，不调用 `approve` 或 `plan`，状态不变。卡片不可用时改用文字提问并等待真实回答。
- 用户在本次命令里已写明“跳过评审”或“先评审”时直接照做，不重复询问；该说明是流程选择，不作为需求传给 Codex。不沿用以前命令中的选择。
- `withoutReview` 只能来自用户本次的卡片选择或命令原文，模型不得自行决定，也不得因评审被拒、报错或嫌慢而使用。脚本无法证明卡片出现过，但会在 `approved` 和 `delivery.planReview` 中留下记录。
- 实现前的 `planReview`：`in-progress` 先完成未完成的评审；`unavailable` 展示 `planReviewNote`，按其说明处理。两者都不提供跳过。
- 规划前的 `resultReview`：选“先完成评审”时用 `claude-review-result` Skill 继续原票据；选“先处理扫描问题”时展示原因后停下。`unavailable` 和 `current` 不弹卡片。runner 不拦截 `plan`，交给 Codex 的说明按实际状态生成。
- 回答规划问题、恢复问答和 `revise-plan` 不触发卡片。`fix` 和 `revise-plan` 以评审报告为输入，仍然必须先有对应评审。

### 交付目标与执行摘要

`/chatgpt-implement` 执行当前获批计划；是否修改代码取决于交付目标。规划时只读是本次规划调用的限制，不是未来实现阶段的默认限制。

- `state.plan.contract` 保存最终任务类型：`investigate` 调查报告、`modify` 修改交付物、`investigate-and-modify` 调查后完成修改。文档、配置、脚本也是交付物。调查报告由宿主保存到任务目录；要求修改项目内文档时应归为修改交付物。
- Codex 负责判断需求是否明确。仅写“排查问题”且已有需求/决定不能说明是否包含修复时，通过现有问题轮确认；明确“只调查”或“定位并修复”时不重复询问。真实回答立即保存，未回答不推定修复授权。
- 正式计划顶部目标摘要由脚本生成。规划结果正文只描述未来执行步骤，不把“本轮仅修订计划”等临时指令写成执行约束。Claude 评审检查正文、结构化目标、原始需求和问答的一致性；冲突必须修订或问答解决，不能删除关键词或擅自选择某一段。
- 每次 `implement` 或 `fix` 前先读取 `status`、计划及当前评审，展示任务、计划版本、交付目标、允许修改范围、排除范围、验收要求；`fix` 同时说明本次评审问题范围。已明确的用户阶段命令就是该范围授权，不额外重复确认。存在未答决策或目标冲突时停止依赖动作，通过原有规划/评审问答解决，不能自行改状态。
- `executionSummary.migrationRequired` 表示旧计划缺少目标记录。旧任务可以查看、恢复和读取报告；实现/修复前请用 `/chatgpt-plan` 补齐原有目标，并重新 `/claude-review-plan`。优先读取已有需求和问答，不自动扩大范围，不手动填入 contract 绕过升级。
- 目标内容发生任何变化，即使通过 `revise-plan` 修改，原评审都不再沿用：重新评审，或由用户在卡片中选择跳过。目标未变且没有重大方案变化的普通评审修订继续沿用原有规则。

### 执行结果与完成情况

实现和修复输出结构化结果；完整中文报告仍在 `.result.md`，原始输出在 `.result.raw.txt`，有效结构化结果在 `.result.json`。结果无效时 `.result.md` 保留原文用于核对，不能把它当成已通过的报告。

`lastRun.status=completed` 只表示 CLI 调用结束。`delivery.outcome` 是 Codex 自报的交付完成情况，`delivery.assessment` 是脚本校验状态，二者都不等于 Claude 验收通过。核对交付物必须读取 delivery 中的报告、逐项结果和验证证据；`resume` 的最新回顾不能替代这些执行记录。

- `needs-review`：结构与交付项覆盖有效，仍需 `/claude-review-result` 核实。分别展示已完成、部分完成、受阻及未验证内容。
- `invalid-result`：结果缺失、格式不合法或覆盖不完整；保留原始输出与实际改动，提示“结果待核对”，由 Claude 成果评审检查。不能自动再跑 implement/fix，不能把正常退出当成功。
- `execution-failed`：调用失败，可能有部分修改；先检查错误和实际文件，不自动重跑。
- 修改任务的 `changesDetected=false`：明确显示“未检测到本次交付物修改，需要核对”，同时展示 `changeExplanation`、逐项结果及验证依据。已有实现满足要求可以不改，但需 Claude 实际核实；只有原因分析不能替代修复。
- 有变化不代表完成；调查报告任务无业务文件变化是正常情况。快照失败、忽略文件等未覆盖情况必须说明，不能据此断言没有变化。

前后快照、原始输出和交付结果按执行 run ID 保存；`state.delivery` 指向最近一次执行，规划或只读回顾不会覆盖它。若 `executionSummary.deliveryMatchesCurrentPlan=false`，它只是旧计划的历史结果。结束摘要应同时说明交付目标、实际结果、验证范围和下一步；无新增范围的确认缺陷用 `/chatgpt-fix`，新增范围回到 `/chatgpt-plan`。

- `new`, `plan`, internal `answer`, `revise-plan`, and a NEW read-only recap turn started by `resume`: Codex **read-only** sandbox, including in a resumed conversation previously allowed to write. When `resume` attaches to an already running implementation/fix, it starts no new turn and does not change that run’s sandbox or approval route.
- `implement`, `fix`: Codex **workspace-write**, only when the user requested that phase and Claude's current permissions permit it. If Claude is in Plan mode, explain that the user must switch to an execution mode before running these actions. Do not start a writing child from Plan mode.
- All inference and review actions write local workflow state/artifacts. Even planning is not a zero-write host operation. Use Manual or Auto; if currently in Plan, stop before metadata writes and explain the need to switch manually. If any policy blocks the helper, report the actual operation and follow the normal permission flow. Do not disguise it as a read-only shell command or work around a denial.
- Do not call `ExitPlanMode` to launch Claude implementation. The user switches modes manually. The helper's sandbox is fixed per phase; only the routing of Codex approval requests follows Claude's mode.
- A plan-review-guided revision may proceed to explicit approval without a compulsory second review. If it adds new scope or leaves a material choice unresolved, use `plan` to record the new requirements and invalidate the old review; before implementation obtain a fresh `/claude-review-plan` or let the user choose to skip it on the card.
- On a missing/stale plan review use the card above; for `fix` and `revise-plan` point to `/claude-review-result` or `/claude-review-plan`. Never forge a review, rewrite state, or skip a check on your own initiative. Unfinished review questions/drafts block approval, implementation, plan revision and fixes until the review is completed. If needed, invoke that skill under the user's standing authorization for this workflow, without assuming it authorizes implementation.

## Continuation and results

### Resume routing before Codex question handling

Inspect `selectionRequired` first. Once bound, if `threadLost` is present, show the recovery card below before anything else. Otherwise, if `resumeOwner: claude` or `reviewSession` exists, read [shared review workflow](review.md) and continue that review inline with its saved kind and ticket. The returned `reviewSession.stale` flag requires reinspection before continuing; historical answers are not automatically current decisions. Restore only missing review answers; if all are saved, finish Claude's report or retry its saved draft. Do not send review questions to Codex, call planning `answer`/`clarify`, or request a Codex recap on this branch. Keep the original `/chatgpt-resume` purpose; completion of review does not authorize implementing fixes.

### 会话恢复卡片

Codex 会话可能在 Codex 或 ChatGPT 应用中被删除。runner 会报告“找不到本任务的会话”，并记录 `threadLost`。此时没有启动执行，任务状态已还原。

- 命令遇到该错误时：说明原因，请用户运行 `/chatgpt-resume`，不自动重试或重建。
- `/chatgpt-resume` 先用 `status` 查看；有 `threadLost`，或本次 resume 报告该错误时，用 AskUserQuestion 问一次：
  - “重建 Codex 会话（推荐）”：调用 `{"action":"resume","rebuildThread":true}`。在同一任务新开只读会话，交给它需求、计划、问答和评审记录；丢失的只有旧的 Codex 对话。
  - “重试原会话”：用户已在 Codex 中找回时选择。没有未完成的评审或问答时调用普通 `resume`；有则直接继续那一项。
- 取消、跳过问题、空白、超时都不算选择：停下，状态不变。卡片不可用时改用文字提问。
- `rebuildThread` 只能来自用户本次的明确选择，模型不得自行决定，也不得用于其他错误。没有 `threadLost` 时 runner 会拒绝。
- 重建成功后按返回状态继续：未完成的评审或问答照常恢复，已保存但未发送的答案重新发送；不自动实现或修复。告诉用户计划、评审和批准不变，可以重发原命令。
- 旧版本留下的 `implementing` 阶段同样适用：先 resume 一次，由 runner 确认会话确实不存在，再弹卡片。
- 提示“正被占用”时：请用户关闭 Codex 或 ChatGPT 应用中打开的该会话后重试，不重建。

### Interactive clarification in the current Claude conversation

After `new`, `plan`, `revise-plan`, `answer`, or `resume`, inspect returned `pendingQuestions`. Questions come from Codex; you present them without doing the planning yourself. Run this loop inline in the current Claude conversation (no fork/background Claude agent):

1. If `pendingQuestions.answers` already exists, delivery was interrupted. Retry the saved `answer` payload using its round ID without asking the user again. Retry once per user-requested continuation; on another failure report it and wait, rather than spinning.
2. Otherwise read `pendingQuestions.partialAnswers` and ask only the questions still missing answers. Use the native **AskUserQuestion** tool for questions having options. Preserve Codex's `question`, `header`, `options` and `multiSelect`; omit the internal question ID from tool arguments. Keep a mapping from each exact question text to its ID. Respect the tool's current limits; split batches if necessary. Do not ask only as prose when the native card tool is available and supports the question.
3. For an open-text question (`options: []`), ask it plainly in this conversation; do not invent options. If AskUserQuestion is unavailable or blocked, explain the fallback and ask in this conversation. Never change permission settings to enable it.
4. Wait for actual user answers. Empty/cancelled/skipped/timed-out results are NOT approval or answers; leave the round pending. Do not apply recommendations automatically, including when a configured question timeout fires. Preserve selected labels, free text and notes exactly. If the user requests an explanation instead of choosing, invoke runner `clarify` with the exact request in `text`; present Codex's explanation then ask the pending questions again. This read-only action preserves the round and does not register an answer. If they ask to wait, wait.
5. After EACH tool result or text reply containing real answers, immediately call runner `record-answers` with `roundId` and that subset of `answers: [{id, answer}]`, then show a visible receipt containing each question and exact answer/notes in the Claude conversation. Do this even if other questions were skipped or will be asked in a later batch. Never paraphrase choices or notes. This stages partial answers without calling Codex. Once all questions have answers, submit runner `answer` using the full saved `partialAnswers` list. The helper persists the completed set before calling Codex on the same UUID. Explicit user corrections can update staged answers before submission; already-submitted corrections require a later planning turn.
6. Inspect the returned result. If there is another pending round, repeat. If `planningStatus: ready`, read and present `paths.plan`, then stop and offer both next steps: `/claude-review-plan`（推荐） or `/chatgpt-implement`（会先让用户选择评审或跳过）. Do not implement just because answers were submitted. A clear initial brief may need no questions; do not manufacture an interview.

The user does not need to type `/chatgpt-plan` after each card answer. Continue the same skill loop automatically. If a user answers in ordinary chat while this round is active, map only explicit answers and submit them through the same protocol; clarify ambiguous mappings. On restart `/chatgpt-resume` re-presents pending cards or retries already-saved answers. Also read `paths.questions` to restore prior decisions into the Claude conversation when needed.

Question cards, answers and visible receipts live in the current Claude conversation through normal tool/chat history. `.chatgpt-workflow` also stores structured and readable copies. Never write directly to Claude's private session JSONL files or promise that an old interactive card UI can be recreated identically after restart. Plan-mode metadata-write limitations still apply; a question is saved locally only after the helper succeeds.

The runner stores one explicit Codex UUID per task and a separate task binding for each Claude session in `.chatgpt-workflow/`. Never use `--last`, `--resume-last`, plugin job lookup, or project active.json as a substitute. After `claude -c` or `/resume`, pass the current entry's session ID to status/resume. Old or newly forked Claude sessions with no binding require explicit task selection. Changing Claude history does not restore the working tree. `/rewind` 只影响 Claude 对话和 Claude 自己用编辑工具写的文件，不回退任务阶段、评审、批准、Codex 对话或 Codex 改的成果。发现对话与状态不一致时以 status 为准；不要因为对话里看不到就重发 new 或 implement。用户要改计划时走 `/chatgpt-plan`。 Do not silently start fresh when Codex resume fails; report the saved UUID and failure, then let the user explicitly create another task if needed.

Codex runs in a detached worker that outlives the tool call. Pass `timeout: 600000` to Bash/PowerShell for every inference action, `wait` and `approveCommand`. Act on the returned `runState` until it is `completed`; on `running` call `wait`. If the tool call itself is interrupted or moved to the background, call `wait` rather than starting the action again. A lost worker is reported, never rerun automatically. Run each runner command alone, without pipes or filters; read the returned file paths with Read for details. Use the clarification loop for pending questions. Ordinary chat outside an active clarification round does not automatically route to Codex.

Finish with a short result/verification summary, task ID, and next applicable command. Distinguish CLI completion from tests passing or the feature being finished. 任何检查命令非零退出，都要说明哪一项没有跑成、影响哪些结论；同一条命令前段有输出不代表整条成功，没跑成的检查不能当作通过。需要 Python 时写成脚本文件再运行，不用多行 `python -c`：Windows 上 `python` 可能是 `.bat` 垫片，多行参数会被截断。 Failures may leave partial code changes; inspect status and results before retrying. Do not commit, push, deploy, install globally, or change account/model settings as part of this skill.

## 中文状态与成果修复

向用户解释状态时使用中文，不直接把整个 JSON 当作说明；机器字段、UUID、命令名及底层原始错误可保留原文。查看帮助或状态时遵循 [帮助状态展示](status.md)，只建议下一步，不执行它。

`fix` 读取完整成果评审及问答，包括验证记录和未验证范围。优先修复已确认、已批准范围内的问题；测试问题单独核实，不削弱断言来换取通过。环境受阻不等于产品缺陷；新增建议不等于批准的新需求。部分验收报告允许修复已确认问题，但未解决的必要决策仍阻止相关修改，不能用“部分评审”绕过问答门禁。Codex 执行自己环境允许的验证；Claude 的浏览器验收不替代这些检查，修复后由用户再次运行 `/claude-review-result`。

## 普通目录支持

所有项目均使用 files-v1 文件快照，不依赖 Git。快照按内容哈希记录新增、修改、删除和类型变化；Git 状态、提交和差异只作辅助，不参与评审版本判断。固定排除 .git、.chatgpt-workflow、.astra-workflow 和 .claude/settings.local.json（Claude Code 保存权限选择时会改写它；执行期间的改动仍由防篡改检查报告）；默认排除 node_modules、.venv、__pycache__、.cache、.vs、.next、.nuxt、.turbo、coverage、test-results、playwright-report、.playwright-mcp、.pytest_cache、.mypy_cache、TestResults；bin/obj 仅在同级有 *.csproj、*.fsproj、*.vbproj 时排除，target 仅在同级有 Cargo.toml、pom.xml 时排除。扫描不采用 .gitignore，dist/build 默认纳入。排除目录不算已检查。UTF-8 文本每文件最多 1 MiB，每次快照最多新增 32 MiB 原文备份，按内容哈希去重；二进制、大文件及预算外内容只记录指纹和未备份原因。不能据此承诺完整回滚。

首次规划明确失败且没有 UUID 时，用户执行 `/chatgpt-resume` 可在原任务中重试首次规划；runner 先核对进程与事件日志，发现 UUID 则恢复它，结果不明或进程可能仍运行时停止。保留原需求、绑定和失败记录，不生成第二个任务。已有 UUID 的正常恢复仍不重跑实现或修复。 不因为不存在 Git 仓库而要求 git init、改可信配置或重新新建任务。resume 返回规划问题时继续本文件的问答循环；返回已完成计划时展示计划并停在待评审，不直接实现。
