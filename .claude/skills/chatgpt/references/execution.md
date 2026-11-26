# Execution: approve, implement and fix

`implement` and `fix` run Codex with a **workspace-write** sandbox, only when the user requested that phase and Claude's current permissions permit it. If Claude is in Plan mode, explain that the user must switch to an execution mode before running these actions; do not start a writing child from Plan mode. The helper's sandbox is fixed per phase; only the routing of Codex approval requests follows Claude's mode ([codex-run.md](codex-run.md)).

| Fixed action and accepted arguments | Runner request / behavior |
| --- | --- |
| `implement` | Treat this explicit request as approval of the displayed current plan. Read `status` first. `planReview` `none`/`stale`: 先按 [review-choice.md](review-choice.md) 询问。Otherwise check the plan/review and unresolved decisions, run `approve`, then `implement`. Do not ask for the same approval again. |
| `fix [R1/R2 or focus]` | `{"action":"fix","text":"<focus>"}`. Pass the saved result review and exact decisions to Codex; validate findings against actual deliverables before modifying. Requires a current result review; otherwise point to `/claude-review-result`. |

- `approve`: `action`, optional `withoutReview:true`. 只在用户本次明确选择跳过评审时使用；仅当 `planReview` 为 `none` 或 `stale` 时接受，其他状态拒绝。不带该参数时检查与原来一致。No `approve` launches Codex.
- `implement`, `fix`: `action`；fix 另有可选 `text`。

Unfinished review questions/drafts block approval, implementation and fixes until the review is completed. Never forge a review, rewrite state, or skip a check on your own initiative. If needed, invoke the review skill under the user's standing authorization for this workflow, without assuming it authorizes implementation.

## 交付目标与执行摘要

`/chatgpt-implement` 执行当前获批计划；是否修改代码取决于交付目标。规划时只读是本次规划调用的限制，不是未来实现阶段的默认限制。

- `state.plan.contract` 保存最终任务类型：`investigate` 调查报告、`modify` 修改交付物、`investigate-and-modify` 调查后完成修改。文档、配置、脚本也是交付物。调查报告由宿主保存到任务目录；要求修改项目内文档时应归为修改交付物。
- 正式计划顶部目标摘要由脚本生成。Claude 评审检查正文、结构化目标、原始需求和问答的一致性；冲突必须修订或问答解决，不能删除关键词或擅自选择某一段。
- 每次 `implement` 或 `fix` 前先读取 `status`、计划及当前评审，展示任务、计划版本、交付目标、允许修改范围、排除范围、验收要求；`fix` 同时说明本次评审问题范围。已明确的用户阶段命令就是该范围授权，不额外重复确认。存在未答决策或目标冲突时停止依赖动作，通过原有规划/评审问答解决，不能自行改状态。
- `executionSummary.migrationRequired` 表示旧计划缺少目标记录。旧任务可以查看、恢复和读取报告；实现/修复前请用 `/chatgpt-plan` 补齐原有目标，并重新 `/claude-review-plan`。优先读取已有需求和问答，不自动扩大范围，不手动填入 contract 绕过升级，也不复用旧批准。

## 执行结果与完成情况

implement/fix 使用 `--output-schema`：`outcome` 为 completed/partial/blocked，`deliverables` 每个计划 ID 恰好一次，包含 id/status/summary/evidence；`verification` 包含 description/status/evidence，状态为 passed/failed/blocked/not-applicable；另有 unfinished、changeExplanation 和完整中文 Markdown report。字段和交付项覆盖校验不能验证语义及证据真实性。自报 completed 与未完成事项、失败/受阻验证不兼容；部分或受阻必须说明原因。

执行结果原文保存为 `<run>.result.raw.txt`，有效结果另存 `<run>.result.json`，report 保存为 `<run>.result.md`（结果无效时保留原文用于核对，不能把它当成已通过的报告）。每次 implement/fix 保存 `<run>.before.snapshot.json`、`<run>.after.snapshot.json` 和 `<run>.delivery.json`，与第一次实现基线用途不同。`state.delivery` 指向最近一次执行，规划或只读回顾不会覆盖它。

`lastRun.status=completed` 只表示 CLI 调用结束。`delivery.outcome` 是 Codex 自报的交付完成情况，`delivery.assessment` 是脚本校验状态，二者都不等于 Claude 验收通过。核对交付物必须读取 delivery 中的报告、逐项结果和验证证据；`resume` 的最新回顾不能替代这些执行记录。

- `needs-review`：结构与交付项覆盖有效，仍需 `/claude-review-result` 核实。分别展示已完成、部分完成、受阻及未验证内容。
- `invalid-result`：结果缺失、格式不合法或覆盖不完整；保留原始输出与实际改动，提示“结果待核对”，由 Claude 成果评审检查。不能自动再跑 implement/fix，不能把正常退出当成功。
- `execution-failed`：调用失败，可能有部分修改；先检查错误和实际文件，不自动重跑。
- 修改任务的 `changesDetected=false`：明确显示“未检测到本次交付物修改，需要核对”，同时展示 `changeExplanation`、逐项结果及验证依据。已有实现满足要求可以不改，但需 Claude 实际核实；只有原因分析不能替代修复。
- 调查报告任务无业务文件变化是正常情况；若 `delivery.warnings` 报告调查任务检测到文件变化，原样展示变化清单，交给成果评审核对是否应保留，不自动回滚。
- 有变化不代表完成。快照失败（`changesDetected=null`）、排除目录等未覆盖情况必须说明，不能据此断言没有变化。

若 `executionSummary.deliveryMatchesCurrentPlan=false`，它只是旧计划的历史结果。结束摘要应同时说明交付目标、实际结果、验证范围和下一步；无新增范围的确认缺陷用 `/chatgpt-fix`，新增范围回到 `/chatgpt-plan`。

## fix 的范围

`fix` 读取完整成果评审及问答，包括验证记录和未验证范围。优先修复已确认、已批准范围内的问题；测试问题单独核实，不削弱断言来换取通过。环境受阻不等于产品缺陷；新增建议不等于批准的新需求。部分验收报告允许修复已确认问题，但未解决的必要决策仍阻止相关修改，不能用“部分评审”绕过问答门禁。Codex 执行自己环境允许的验证；Claude 的浏览器验收不替代这些检查，修复后由用户再次运行 `/claude-review-result`。不能仅靠 `/chatgpt-fix` 把调查报告范围扩大成业务修复。
