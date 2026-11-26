# 帮助与状态展示

只运行一次 `status <sessionId>`，按返回字段展示。**不编写或运行其他脚本，不复查交付物或旧评审，不解析 `state.json`**；必要时只用 Read 读返回路径中的计划或评审。发现可疑之处只列为“待查项”，建议 `/claude-review-result` 或 `/claude-review-plan`，不在这里核实或更正。

从本次 `status` 返回值说明当前 Claude 会话绑定、任务ID、阶段、Codex UUID、待答问题和报告草稿。字段没有返回就说明未知，不根据聊天记忆补造状态。原始错误可原样附上，原因与下一步用中文解释。

同时展示 `executionSummary` 的任务类型、最终交付物、允许修改范围、排除范围和验收要求。目标缺失显示“旧计划待补齐交付目标”，不是默认只读或默认允许修改。待答问题优先 `/chatgpt-resume`；无未决问答的旧目标用 `/chatgpt-plan` 补齐并重新评审，status 自身不迁移。

存在 `delivery` 时单独列出“Codex 调用状态 / 自报交付情况 / 成果待核实状态”：`completed` 自报已完成、`partial` 部分完成、`blocked` 受阻，均不代表验收通过。`invalid-result` 显示“结果待核对”，读取原始输出并建议 `/claude-review-result`，不重跑。`execution-failed` 检查错误和实际改动。展示未完成事项和 warnings；无变化的修改任务同时展示解释和验证依据。`deliveryMatchesCurrentPlan=false` 时标注是历史执行结果，不据此宣布当前计划完成。`lastRun` 可能是只读回顾，不能替代 delivery 的执行记录。

`lastRun.leftoverProcesses` 为 true 时说明：Codex 已结束，但有残留进程未退出，可能仍会改动文件；本工具没有结束它。`threadHistory` 列出被替换的旧 UUID。

存在 `activeRun` 时先展示：动作、是否存活、最近进度、待处理审批或提问。`delivery.approvals` 展示审批方式、批准数与被拒项。

先处理高优先级状态，再参考阶段：

| 实际状态 | 中文说明与适用的下一步建议 |
| --- | --- |
| activeRun 有待审批或提问 | Codex 等待确认；建议 `/chatgpt-resume` 重新呈现，不重新发起 |
| activeRun 存活 | 执行中；建议 `/chatgpt-resume` 继续等待，需要停止时由用户明确要求取消 |
| threadLost | Codex 会话在工作流之外被删除，任务状态未变；建议 `/chatgpt-resume`，由用户选择重建或重试原会话 |
| selectionRequired | 当前会话尚未绑定；列出已有任务，明确选择后使用 `/chatgpt-use <任务ID>`，或 `/chatgpt-new <需求描述>` 自动命名新任务 |
| 未完成 reviewSession（含过期、问题或草稿） | 评审待继续；建议 `/chatgpt-resume`。过期需重新检查，草稿需保存成功后才算完成 |
| pendingQuestions | 规划问答待继续或答案待发送；建议 `/chatgpt-resume` |
| lastRun.status 为 running / failed | 执行中：等待原进程；失败：检查错误及实际改动，不直接重跑。只在确认进程结束且遗留锁时建议 `/chatgpt-unlock` |
| planned | 计划已生成；若尚未评审，并列给出 `/claude-review-plan`（推荐）和 `/chatgpt-implement`（会先询问评审或跳过）。如有本轮有效评审修订关系且无新增范围，展示修订后可建议 `/chatgpt-implement` |
| reviewed-plan | 计划已评审；有修改建议时用 `/chatgpt-revise-plan`，否则确认范围后可用 `/chatgpt-implement` |
| approved | 当前计划已批准；使用 `/chatgpt-implement`；若误在 Plan，先手动切换 |
| needs-code-review | 实现或修复已返回，成果待评审；建议 `/claude-review-result`。也可直接 `/chatgpt-plan`（会先询问评审或跳过） |
| reviewed-code | 成果评审已保存，是否有效看 `resultReview`。`current` 且有确认缺陷时建议 `/chatgpt-fix`；`stale` 或 `invalid` 建议重新 `/claude-review-result`；仅环境受阻则恢复环境后重评；无待改项则无需修复 |
| planning / planning-error / implementing / fixing | 规划中、规划失败、实现中、修改中；结合最后运行状态解释，不把中断当完成 |
| 其他或缺失阶段 | 如实展示原始阶段并注明无法判定；建议先检查记录，不猜测已批准或已通过 |

展示 `planReview` 和 `planReviewNote`：`current` 已评审、`none` 未评审、`stale` 评审后文件有变化、`in-progress` 评审未完成、`unavailable` 现在不能批准（按说明处理）。展示 `resultReview` 和 `resultReviewNote`：`current` 有效、`stale` 已过期、`invalid` 报告不可信、`in-progress` 未完成、`unknown` 无法判断、`none` 未评审、`unavailable` 不适用。**只有 `current` 才能说成果评审有效**，不能因为有历史报告就说有效。`delivery.shortened` 出现时说明内容已截短，并给出完整文件路径。

必要时只读查看返回路径中的计划和评审以决定建议。状态显示不替代 runner 的有效性门禁；只有脚本执行时校验通过才能进入依赖阶段。部分评审不是验收完成；包含未验证范围时必须在状态说明中明确指出。

`/chatgpt` 显示完整 14 项命令表和括号说明，再突出适用的下一步。`/chatgpt-status` 仅需状态及下一步。两者均不调用 Codex、不启动浏览器或问答、不选择任务、不批准、不实施。

## 文件快照状态

帮助、status 和 doctor 展示 snapshotStatus 中的快照格式、扫描规则、最新快照路径、覆盖限制和可选 Git 状态。Git 不可用是正常状态，不建议为启动工作流而初始化仓库。configurationError 必须说明。查看状态不保存新快照，也不调用 Codex；存在评审时会只读扫描文件校验是否仍然有效（一次查询最多扫描一次），大项目可能需要时间。

首次规划失败且没有 UUID 时建议 /chatgpt-resume，由 runner 判断是否可以原任务恢复；不能宣称所有无 UUID 情况都能自动重试。旧评审需要升级时建议对应的 /claude-review-plan 或 /claude-review-result，保留旧报告。

运行中同时显示 activeRun 的实际负责人及代次、等待审批或问题、已保存答案与缺题数量。archiveWarnings 非空时明确说明外部记录仍待归档；不把执行结果未知或归档失败显示为已完成。帮助与 status 只展示，不自动接管、归档或调用 Codex。
