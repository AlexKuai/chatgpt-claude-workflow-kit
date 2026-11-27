# Claude 规划协议

用于 `/claude-new`、`/claude-plan`、`/claude-revise-plan`，以及 `/chatgpt-resume` 返回 `resumeOwner: claude-plan` 时。计划由**当前 Claude 会话模型**亲自编写；不委托 Codex、不启动其他 Claude 或子代理。实现仍由 Codex 通过 `/chatgpt-implement` 完成，成果评审与修复流程不变。用中文回答。

## 边界

- 只读检查项目：可以读文件、搜索、运行不改文件的只读命令；**不修改业务文件、依赖、配置或测试，不开始实现**。要写入的只有请求文件和 runner 保存的工作流记录。
- 和评审一样在 Manual 或 Auto 中进行：保存票据、问答和计划都要写工作流文件。已知在 Plan 模式时，先请用户手动切换。
- 这些动作都不调用 Codex，不产生 Codex 会话。由 Claude 规划的任务在第一次 `/chatgpt-review-plan`、`/chatgpt-implement` 或 `/chatgpt-plan` 时才新建 Codex 会话，runner 会把原始需求、计划、目标和问答一起交给它。
- 编写计划会消耗较多 Claude 额度；如实说明，不承诺节省。

## JSON 动作

每个请求都带入口给出的 `sessionId`，按 [runner.md](runner.md) 写请求文件后调用。

- `new` 加 `"planner":"claude"`：其余字段与 `/chatgpt-new` 相同（`requestId`、`suggestedTask`、完整 `text`）。创建并绑定任务，不调用 Codex，返回 `ticket`。返回 `creationReplay: true` 时按 `/chatgpt-new` 的重放规则处理，票据见 `authoring.ticket`。
- `plan-start`：`kind` 为 `plan`（重新规划当前任务）或 `revise`（按已保存的计划评审修订），可选 `text` 为用户的补充说明。`revise` 要求当前计划评审有效，返回 `sourceReviewFile`。同一种未完成规划会返回原票据；计划在此期间被改动时归档旧票据并开新票。返回 `reviewNotice` 时先向用户展示。
- `plan-questions`：`ticket`、`questions`（1–3 个，唯一 `id` 与问题原文，`header` 不超过 12 字，`multiSelect`，2–4 个选项或 `[]`），可选 `text` 笔记。未答完上一轮前不能加新一轮。
- `plan-record-answers`：`ticket`、`roundId`、`answers: [{id,answer}]`，每批真实回答后立即保存。
- `plan-save`：`ticket`、`plan`（执行细节 Markdown）、`contract`、可选 `model`。所有问题答完才能保存。先保存草稿再写 plan.md；中断后**省略 plan 和 contract** 重试同一票据即使用原草稿。相同票据完成后的重复保存只返回状态，内容不同会被拒绝。
- `plan-cancel`：`ticket`。只在用户明确要求放弃这次 Claude 规划时调用；已保存的问答进入历史，原计划和评审保持不变。

`authoring.stale: true` 表示规划开始后计划已被其他操作改变：说明情况，按入口重新 `plan-start`，旧回答只作历史线索。

## 问答

只在需求、取舍或验收标准无法从项目文件确定时提问，不为提问而提问。先 `plan-questions` 保存问题，再用 **AskUserQuestion** 原样展示（不显示内部 ID，选项为 `[]` 或卡片不可用时改为文字提问）。取消、跳过、空白、超时和默认选项都不是用户的决定；未答完的问题会阻止保存计划。用户要求解释时由你解释，问题保持待答。每批回答保存成功后再显示回执。若“排查问题”之类的说法分不清只要报告还是要修复，必须提问，不推定修改授权；明确要求只调查或要修复时不重复确认。

保存后，问答以 `askedBy: claude` 记入 `questions.json` / `questions.md`，实现时一并交给 Codex。

## 计划内容

`contract` 与 Codex 计划完全相同，runner 用同一套规则校验：

- `kind`：`investigate`（只交报告，不修改业务文件，`allowedChanges` 为空）、`modify`（修改代码、文档、配置等交付物）或 `investigate-and-modify`。
- `deliverables`：唯一的 `{id, description}`；修订时含义不变的交付物保持原 ID。
- `allowedChanges`、`excludedChanges`、`acceptanceCriteria`：文本列表。

`plan` 只写未来执行的细节：需求与决定、方案、涉及文件、步骤、验证方法和风险。目标摘要由 runner 生成在 plan.md 顶部，正文不要重复。规划时的只读限制只针对这次规划，**不要写进执行约束**（例如不要写“本轮仅修订计划、不改代码”）。与目标冲突的内容通过提问或修订解决，不悄悄覆盖约束。

## 修订（`/claude-revise-plan`）

读 `sourceReviewFile`（通常是 ChatGPT 的评审）、当前 plan.md、原始需求和已保存问答。逐条核实每个发现：接受的改进计划，不接受的说明理由，并把“接受 / 不接受及原因”写进计划正文的一节。评审中的“需要用户决定的问题”用问答协议问用户，不替用户决定。新增需求或范围变化要提问确认。

交付目标（`contract`）不变时，原评审继续有效，可以直接 `/chatgpt-implement`（返回 `reviewCarriedOver: true`）。目标有任何变化都需要重新评审：推荐 `/chatgpt-review-plan`，也可以在实现前的卡片中选择跳过。

## 结束

保存成功后展示任务 ID、计划版本、交付目标摘要和 plan.md 路径，然后停下，不自动评审或实现。下一步：

- 新计划：推荐 `/chatgpt-review-plan` 让 ChatGPT 评审；也可以直接 `/chatgpt-implement`，会出现评审选择卡片。
- 沿用评审的修订：`/chatgpt-implement`。
