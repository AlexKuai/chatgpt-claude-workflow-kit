# Resume

`resume`: `action`，另有可选 `rebuildThread:true`（只在用户于会话恢复卡片中明确选择时使用；没有与当前 UUID 一致的 `threadLost` 记录时拒绝）。resume never reruns implementation or fixes, and never restores project files to an earlier time.

## Resume routing

Inspect `selectionRequired` first (see [runner.md](runner.md)). Once bound, check in this order:

1. `threadLost` is present → show the 会话恢复卡片 below before anything else.
2. An existing run → resume attaches to it without a new turn or changed sandbox/approval route; continue with [codex-run.md](codex-run.md) (pending approvals and runtime questions are re-presented).
3. `resumeOwner: claude` or `reviewSession` exists → read [review.md](review.md) and continue that review inline with its saved kind and ticket. The returned `reviewSession.stale` flag requires reinspection before continuing; historical answers are not automatically current decisions. Restore only missing review answers; if all are saved, finish Claude's report or retry its saved draft. Do not send review questions to Codex, call planning `answer`/`clarify`, or request a Codex recap on this branch. Completion of the review does not authorize implementing fixes.
4. `resumeOwner: claude-plan` or `authoring` exists → read [claude-planning.md](claude-planning.md) and continue that Claude planning inline with its saved ticket: restore missing answers, then write the plan, or retry `plan-save` without plan/contract when `authoring.draft` exists. `authoring.stale` requires a new `plan-start`. No Codex call on this branch.
5. `pendingQuestions` (`resumeOwner: codex-questions`) → returned without a Codex call; continue the question loop in [planning.md](planning.md); saved full answers retry delivery.
6. 由 Claude 规划且尚无 Codex 会话的任务，resume 只返回状态和说明，不调用 Codex。
7. 首次规划明确失败且没有 UUID → 按下面的首次失败恢复处理，并继续正常问答（[planning.md](planning.md)）；返回已完成计划时展示计划并停在待评审，不直接实现。
8. Otherwise resume requests a read-only Codex recap on the saved explicit UUID, listing completed work and next steps. It does not replace the saved plan or `delivery`.

A NEW recap turn started by `resume` is **read-only**, including in a conversation previously allowed to write. The runner never modifies Claude transcript files.

## 会话恢复卡片

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

会话丢失的判定：`thread/resume`（exec 为启动会话前的错误输出）明确返回 `no rollout found for thread id <本任务 UUID>` 时，没有启动回合。runner 把本次动作改过的阶段、版本、批准、评审、执行轮次和 delivery 还原，保留失败记录与已保存的回答，并写入 `threadLost`（UUID、时间、动作、runId）。其他错误按普通失败处理。重建后的新 UUID 在回合启动时写入，旧 UUID 进入 `threadHistory`，`threadLost` 清除；在此之前失败可再次重建。原会话恢复成功也会清除 `threadLost`。runner 从不自动重建。

## 首次失败恢复

首次规划明确失败且没有 UUID 时，用户执行 `/chatgpt-resume` 可在原任务中重试首次规划；runner 先核对进程与事件日志，发现 UUID 则恢复它，结果不明或进程可能仍运行时停止。保留原需求、绑定和失败记录，不生成第二个任务。已有 UUID 的正常恢复仍不重跑实现或修复。原始需求优先来自 state.requirements，旧任务从原 request.txt 读取并核对创建需求哈希。成功恢复前的运行放入 runHistory；所有原始事件、错误和结果文件保留。日志损坏、发现已完成的运行、记录结果不明或进程可能仍活跃时停止。不要手工清空 UUID、改 state 或反复调用 new；不能宣称所有无 UUID 情况都能自动重试。

## Claude 会话与 Codex 会话

The runner stores one explicit Codex UUID per task and a separate task binding for each Claude session in `.chatgpt-workflow/`. Never use `--last`, `--resume-last`, plugin job lookup, or project active.json as a substitute. After `claude -c` or `/resume`, pass the current entry's session ID to status/resume. Old or newly forked Claude sessions with no binding require explicit task selection. Changing Claude history does not restore the working tree. `/rewind` 只影响 Claude 对话和 Claude 自己用编辑工具写的文件，不回退任务阶段、评审、批准、Codex 对话或 Codex 改的成果。发现对话与状态不一致时以 status 为准；不要因为对话里看不到就重发 new 或 implement。用户要改计划时走 `/chatgpt-plan`。Do not silently start fresh when Codex resume fails; report the saved UUID and failure, then let the user explicitly create another task if needed. Saved UUIDs require corresponding Codex history in the same local CLI environment; state files alone do not transplant history.
