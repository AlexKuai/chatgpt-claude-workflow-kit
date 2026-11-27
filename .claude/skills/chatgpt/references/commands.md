# 项目命令

| 命令 | 用途 |
| --- | --- |
| `/chatgpt` | 查看本项目工作流的帮助、当前任务和下一步命令。 |
| `/chatgpt-new <需求描述>` | 根据需求自动命名并创建任务，交给 Codex 规划和问答。 |
| `/chatgpt-plan [补充需求或讨论内容]` | 补充需求或继续 Codex 规划。 |
| `/claude-review-plan [关注点]` | 使用 Claude 当前模型评审计划，必要时问答并保存意见。 |
| `/chatgpt-revise-plan [修改重点]` | 让 Codex 根据已保存的计划评审修改计划。 |
| `/claude-new <需求描述>` | 根据需求自动命名并创建任务，由 Claude 规划和问答。 |
| `/claude-plan [补充需求或讨论内容]` | 由 Claude 为当前任务补充需求或重新规划。 |
| `/chatgpt-review-plan [关注点]` | 让 ChatGPT（Codex）在只读沙箱中评审当前计划并保存意见。 |
| `/claude-revise-plan [修改重点]` | 由 Claude 根据已保存的计划评审修改计划。 |
| `/chatgpt-implement` | 授权 Codex 执行当前计划；未评审时可选择先评审或跳过。 |
| `/claude-review-result [关注点或验证要求]` | 使用 Claude 评审实现成果；网页交互使用可用的 Playwright MCP 验证。 |
| `/chatgpt-fix [问题编号或修改重点]` | 让 Codex 根据已保存的成果评审修改交付物。 |
| `/chatgpt-status` | 查看会话绑定、任务阶段和待处理事项，不调用 Codex。 |
| `/chatgpt-use <任务ID>` | 将明确选择的已有任务绑定到当前 Claude 会话。 |
| `/chatgpt-resume` | 恢复问答、首次规划启动失败或原会话的只读回顾。 |
| `/chatgpt-doctor` | 检查 Codex 路径版本、文件快照配置与可选 Git 状态。 |
| `/chatgpt-unlock` | 清理已结束进程遗留的工作流锁。 |
| `/claude-review` | 查看计划评审和成果评审命令的帮助。 |

尖括号表示必填，方括号表示可选，实际输入时不包含括号。

Manual 模式下，Codex 的越权请求在 Claude Code 原生权限框逐项确认；Auto 模式下由 Codex 自动审查，不弹窗也不无条件放行。规划、问答和评审也会保存工作流文件，不要使用 Plan 模式。长任务在后台 worker 中运行，`/chatgpt-resume` 可继续等待或重新呈现待审批项。纯帮助、状态和 doctor 检查不要求切换模式。

评审是推荐步骤。没有计划评审就 `/chatgpt-implement`，或上次成果没评审、评审已失效就 `/chatgpt-plan` 时，会弹卡片让你选择先评审还是跳过；也可在命令后直接写“跳过评审”。`/chatgpt-fix` 和 `/chatgpt-revise-plan` 仍需要先有对应评审。

`/chatgpt-implement` 执行当前获批计划；是否修改代码取决于交付目标。帮助同时展示任务的最终交付目标、修改范围、自报完成情况和待核对事项；CLI 调用完成不代表成果已验收。旧计划缺少目标时，先 `/chatgpt-plan` 补齐，再 `/claude-review-plan`，不自动扩大范围。

`new` 只需提供需求，全部文字原样传递。任务 ID 根据需求自动生成，例如 `login-page`；重名时追加 `-2`、`-3`，不覆盖已有任务。缺少需求时先追问，不创建空任务。`use` 仍必须指定已有任务 ID，不猜测绑定。旧任务 ID（含下划线）继续有效。参数提示仅用于显示，不替代校验。

两条规划路线可混用：默认 `/chatgpt-new` → `/claude-review-plan` → `/chatgpt-revise-plan`；Claude 规划 `/claude-new` → `/chatgpt-review-plan` → `/claude-revise-plan`（多用 Claude 额度）。之后都是 `/chatgpt-implement` → `/claude-review-result` → `/chatgpt-fix`。修订后交付目标不变时沿用原评审。

`/chatgpt` 只显示帮助和状态，`/claude-review` 只显示评审帮助。问答收集、回答保存和重发由工作流自动执行，无需独立手工命令。
