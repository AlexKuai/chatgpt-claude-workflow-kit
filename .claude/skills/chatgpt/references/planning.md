# Planning: new, plan, revise-plan and planning questions

Codex plans; Claude only presents Codex's questions and saves the user's real answers. `new`, `plan`, internal `answer`, `revise-plan` and `clarify` run Codex in a **read-only** sandbox, including in a resumed conversation previously allowed to write. The read-only restriction applies to that planning turn only, not to future execution.

| Fixed action and accepted arguments | Runner request / behavior |
| --- | --- |
| `new <requirements>` | `{"action":"new","text":"<完整需求>","suggestedTask":"<Claude建议名称>","requestId":"<本次新建UUID>"}`，同时传真实 sessionId。脚本生成实际任务 ID，新操作创建新任务，不覆盖已有任务；相同 requestId 重放只返回原状态。 |
| `plan [message]` | `{"action":"plan","text":"<message>"}`. Read `status` first and apply [review-choice.md](review-choice.md) BEFORE calling `plan`. Continue discussion when no question round is pending; invalidates prior review/approval. 返回 `reviewNotice` 时原样展示。 If answering pending questions, use the answer protocol below instead. |
| `revise-plan [focus]` | `{"action":"revise-plan","text":"<focus>"}`. Send saved Claude plan findings to the same Codex thread; change the plan only. Requires a current plan review; otherwise point to `/claude-review-plan`. |

For new, preserve all arguments as requirements; ask only when requirements are empty and generate the suggested name/request UUID as the entry directs. Only explicit resume or planning actions enter the planning question loop.

## new 与创建请求去重

new 成功后显示实际任务 ID、需求摘要和绑定，而不是建议名称。创建失败时从保存的原请求重放相同 requestId/text 获取状态，不以新 UUID 重试。同 requestId 不重复调用 Codex；实际需求改变必须是新的用户新建操作。creationReplay 返回旧任务而当前 sessionBinding 指向别的任务时，只展示差异，不自动切换或继续旧任务的问答/实现。后续需求变化不重命名任务。旧任务标识与 UUID 保留。

- `new`：`action`、真实 `sessionId`、完整非空 `text`、本次创建 UUID `requestId`，以及可选 `suggestedTask`。新公开入口不传 task。脚本把建议名称规范化成小写字母、数字和连字符，最多 64 字符；缺失、规范化后为空或 Windows 保留名称则回退 `task-需求SHA256前8位`。同名在项目锁内从 -2 递增，必要时截短，不覆盖目录或已保留名称。底层兼容显式 task（原有 1–64 位小写字母、数字、下划线或连字符）；该旧调用可不传 requestId，显式重名仍报错而非改名。
- entry 使用本地 UUID 生成器生成并保存 requestId，不向用户询问。每次新用户操作使用新 UUID；同一工具请求重试必须复用原 UUID 与原 text，不因名称冲突、启动失败或丢失工具输出换 UUID。完整需求不剥离首词，text 哈希基于原始文本（包括空白）。suggestedTask 仅为首次分配建议，重试改变建议名称不会重命名原任务；改变需求、显式 task 或 sessionId 则拒绝。
- 项目锁内先保存 `.chatgpt-workflow/creations/<requestId哈希>.json` 名称保留与需求哈希，再创建任务；`state.creation` 保存同一创建信息及最多 160 字符的需求摘要。正常重复请求返回 creationReplay=true 和原状态，不调用 Codex，不创建新任务。若原会话尚未完成绑定则补齐绑定；若已经绑定其他任务则保留该绑定，返回原 task 与实际 sessionBinding 的差异。创建标识已保存但任务状态缺失/不一致时停止并明确报错，不分配第二个任务来掩盖保存失败。
- Codex 启动失败不等于任务未创建。返回/重放状态保留失败阶段、错误和可能已有的 threadId；不得因为 lastRun 失败就把重复 new 当作执行重试。首次规划明确失败且没有 UUID 时，建议用户 `/chatgpt-resume`，按 [resume.md](resume.md) 的首次失败恢复规则处理。名称仅为标识，后续 plan/revise-plan 不重命名任务。

## Planning JSON actions

- `plan`, `revise-plan`: `action`, optional `text`.
- `clarify`: `action`, `text` (a user's question about requirements/options). Ask Codex for a read-only explanation on the same UUID without replacing the pending round, recording a choice, or marking the plan ready. This supports "explain the options first" inside a question card.
- `record-answers`: `action`, `roundId`, `answers: [{id, answer}]` (any nonempty explicit subset). Persist partial answers immediately after each batch or text reply without calling Codex. `pendingQuestions.partialAnswers` survives restarts; ask only remaining questions. Cancellation and timeout without explicit answers do not call this action.
- `answer` (internal, normally automatic after the question cards): `action`, `roundId` (the current `pendingQuestions.id`), `answers: [{"id":"<question-id>","answer":"<exact user response and notes>"}]`. All pending questions must have nonempty explicit answers. A stale round or changed saved retry payload is rejected. Answers are persisted before Codex is called; a failed delivery is retried with the identical saved payload. No extra user command is needed for each answer.

规划动作使用 `--output-schema` 返回 `status`、`plan`、`questions`、`contract`。`needs_questions` 包含 1–3 个问题，目标未定时 contract 为 null；`ready` 必须包含完整目标与执行步骤，questions 为空。问题使用稳定 ID、原文、短标题、选项和 multiSelect。无效结果不能完成规划，pendingQuestions 阻止评审与批准；answer 仍为只读规划。

`contract` 字段：kind 为 investigate / modify / investigate-and-modify，deliverables 为唯一的 `{id,description}` 列表，allowedChanges / excludedChanges / acceptanceCriteria 为文本列表。调查报告不授权业务文件修改，因此 allowedChanges 为空；要求修改项目文档也属于 modify。Codex 负责判断需求是否明确：仅写“排查问题”且已有需求/决定不能说明是否包含修复时，通过问题轮确认；明确“只调查”或“定位并修复”时不重复询问，未回答不推定修复授权。正文 plan 只包含未来执行细节，目标摘要由脚本生成到 plan.md 顶部。`state.plan.contract` 与 contractHash 保存结构化目标；计划版本同时包含目标和正文哈希，任一变更使批准失效。

## Plan revision

A plan-review-guided revision may proceed to explicit approval without a compulsory second review. revise-plan 只有目标未变化、且没有重大方案变化时才保留评审修订关系。目标内容发生任何变化，原评审都不再沿用：重新评审，或由用户在卡片中选择跳过。If it adds new scope or leaves a material choice unresolved, use `plan` to record the new requirements and invalidate the old review. Unfinished review questions/drafts block plan revision until the review is completed.

## Interactive clarification in the current Claude conversation

After `new`, `plan`, `revise-plan`, `answer`, or `resume`, inspect returned `pendingQuestions`. Questions come from Codex; you present them without doing the planning yourself. Run this loop inline in the current Claude conversation (no fork/background Claude agent):

1. If `pendingQuestions.answers` already exists, delivery was interrupted. Retry the saved `answer` payload using its round ID without asking the user again. Retry once per user-requested continuation; on another failure report it and wait, rather than spinning.
2. Otherwise read `pendingQuestions.partialAnswers` and ask only the questions still missing answers. Use the native **AskUserQuestion** tool for questions having options. Preserve Codex's `question`, `header`, `options` and `multiSelect`; omit the internal question ID from tool arguments. Keep a mapping from each exact question text to its ID. Respect the tool's current limits; split batches if necessary. Do not ask only as prose when the native card tool is available and supports the question.
3. For an open-text question (`options: []`), ask it plainly in this conversation; do not invent options. If AskUserQuestion is unavailable or blocked, explain the fallback and ask in this conversation. Never change permission settings to enable it.
4. Wait for actual user answers. Empty/cancelled/skipped/timed-out results are NOT approval or answers; leave the round pending. Do not apply recommendations automatically, including when a configured question timeout fires. Preserve selected labels, free text and notes exactly. If the user requests an explanation instead of choosing, invoke runner `clarify` with the exact request in `text`; present Codex's explanation then ask the pending questions again. If they ask to wait, wait.
5. After EACH tool result or text reply containing real answers, immediately call runner `record-answers` with `roundId` and that subset of `answers: [{id, answer}]`, then show a visible receipt containing each question and exact answer/notes. Do this even if other questions were skipped or will be asked in a later batch. Never paraphrase choices or notes. Once all questions have answers, submit runner `answer` using the full saved `partialAnswers` list. Explicit user corrections can update staged answers before submission; already-submitted corrections require a later planning turn.
6. Inspect the returned result. If there is another pending round, repeat. If `planningStatus: ready`, read and present `paths.plan`, then stop and offer both next steps: `/claude-review-plan`（推荐） or `/chatgpt-implement`（会先让用户选择评审或跳过）. Do not implement just because answers were submitted. A clear initial brief may need no questions; do not manufacture an interview.

The user does not need to type `/chatgpt-plan` after each card answer. If a user answers in ordinary chat while this round is active, map only explicit answers and submit them through the same protocol; clarify ambiguous mappings. On restart `/chatgpt-resume` re-presents pending cards or retries already-saved answers. Also read `paths.questions` to restore prior decisions into the Claude conversation when needed.

Question cards, answers and receipts live in the current Claude conversation through normal tool/chat history. `.chatgpt-workflow` stores structured and readable copies (`questions.json`, `questions.md`; `state.json` is authoritative). Never write directly to Claude's private session JSONL files or promise that an old interactive card UI can be recreated identically after restart. A question is saved locally only after the helper succeeds.
