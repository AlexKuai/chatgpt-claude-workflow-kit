# 评审选择卡片

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

## 状态取值

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
