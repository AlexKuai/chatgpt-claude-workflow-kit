# Codex runs: waiting, approvals and runtime questions

Codex runs in a detached worker that outlives the tool call. Pass `timeout: 600000` to Bash/PowerShell for every inference action, `wait` and `approveCommand`. Act on the returned `runState` until it is `completed`:

- `completed`：含原有状态字段，按调用该动作的协议继续。
- `running`：展示 progress 并用 `wait` 继续等待；不重复发起任务。If the tool call itself is interrupted or moved to the background, call `wait` rather than starting the action again. A lost worker is reported, never rerun automatically.
- `awaiting-approval`、`awaiting-user-input`：按下文处理。
- `resume` 遇到进行中的执行时只继续等待，不启动新 turn。

Run each runner command alone, without pipes or filters; read the returned file paths with Read for details. Ordinary chat outside an active clarification round does not automatically route to Codex.

## Codex 权限请求

Codex 需要越出沙箱（执行命令、访问网络、改沙箱外文件、扩大权限、调用需确认的 MCP 工具）时，runner 返回 `runState: awaiting-approval`。去向取决于 Codex 本轮启动时的 Claude 模式：

| Claude 模式 | Codex 权限请求 |
| --- | --- |
| Manual（default）、acceptEdits | 由用户在 Claude Code 原生权限框逐项确认 |
| Auto、bypassPermissions | 由 Codex `auto_review` 按风险自动批准或拒绝，不弹窗，不是无条件放行 |
| dontAsk、模式未知 | 自动拒绝并列入执行结果 |
| Plan | 不启动实现/修复 |

处理 `awaiting-approval`：

1. 直接用 Bash 或 PowerShell 原样运行返回的 `approveCommand`（timeout 600000）。权限 hook 会弹出原生权限框并显示 Codex 的真实请求，**由用户决定**。不要先用文字或 AskUserQuestion 询问，不要改写、拼接或添加参数，不要自己生成 gate。
2. 用户选 Yes：命令返回下一个状态，按同样规则继续处理。权限框里的“始终允许”只对本包的 approve-codex 命令无害；其他“始终允许”规则会改写 `.claude/settings.local.json`，使本次运行后续审批失效。
3. 用户选 No：运行 `declineCommand`；附有反馈时改用 JSON `approval-decline`（`id` 与用户原话 `text`），反馈会转给 Codex。不要重复请求同一审批，不要替 Codex 执行被拒命令，不要换写法绕过。
4. 只有用户明确说“本次运行内同类都允许”时，才在 `approveCommand` 末尾加 `--scope run`，它会再次弹框；不写入任何持久规则。
5. 命令报告缺少有效权限确认时，说明权限 hook 未加载，请用户运行 `/chatgpt-resume`（`/clear`、`/resume` 会移除 hook），不得绕过。

模式在下一个 Codex turn 生效。运行中由 Auto 切到 Manual 时，本轮仍由自动审查处理；用户要立即接管就 `cancel` 后恢复。结束时展示 `delivery.approvals`：批准与拒绝数、被拒项及原因、`kitFilesChanged`。被拒项可能使交付受阻，不能报告为已完成。

## 运行中问答

运行中问答（`runState: awaiting-user-input`）与规划阶段的 `pendingQuestions` 是不同协议，不能混用 roundId 或 record-answers：

1. 读取 `userInput.partialAnswers` 和 `unansweredQuestionIds`，只呈现尚未回答的问题；有选项用 AskUserQuestion，无选项用文字。分批提问时也遵守下面的保存规则。
2. 每收到一项或一批真实回答，立即调用 `user-input-record-answers`，传当前真实 `sessionId`、`userInput.id` 和本次子集 `answers: [{id, answer}]`。保持原文和补充说明。用户明确更正时用同一动作保存更正，不推断其他答案。
3. 保存成功后才在聊天中显示逐题保存回执；取消、跳过、空白和超时均不算回答。保存失败时保留可见原文，说明失败并重试保存，不要求用户重答已经给出的内容，也不先提交最终答案。
4. 未回答问题为空时，调用 `user-input-answer`，传当前 `sessionId` 和请求 `id`，不必重传答案；runner 会提交已保存的完整集合。部分答案不能直接用这个动作提交。
5. 用户要退出 Claude 时，先保存已经真实提供的答案。退出不等于取消任务；仅在用户要求停止时调用 cancel。恢复后读取暂存状态，只补问缺失项。
6. `archiveWarning` 表示答案仍保存在外部运行控制目录，尚未成功归档到项目；明确说明。下一次续接会重试归档，失败时先解决实际写入问题，不能删除记录或重跑实现。
7. 请求超时、撤回或运行取消后，答案保留为历史记录，不能自动提交到另一个问题请求。新的决策仍需依据当前有效问题确认。

## JSON actions

- `wait`, `cancel`: `action`. 不占项目锁。等待本会话进行中的执行；取消先中断 turn，10 秒后终止进程树。没有执行时返回 `runState: none`。
- `approval-decline`: `action`, `sessionId`, `id`, 可选 `text`（用户原话）。所有交互提交校验当前负责人，不能省略会话 ID。
- `user-input-record-answers`: `action`, `sessionId`, `id`, `answers: [{id, answer}]`，保存本次真实回答子集；返回 `saved`、`userInput.partialAnswers` 和 `unansweredQuestionIds`。支持明确更正，保留历史。
- `user-input-answer`: `action`, `sessionId`, `id`，提交已暂存的完整答案；兼容一次传入完整 `answers`。缺题、空白、重复 ID 均拒绝；重复最终提交不再次回复 Codex。30 分钟未完成则保留历史并记录未回答，不视为同意。
- 运行问答先保存在外部控制目录的 `interactions/<请求ID>.json`，再归档到任务目录的 `<运行ID>.runtime-questions.json`；不并发改写 task state。归档失败不清理外部记录，后续续接先重试。Codex 后续调用会收到相关问答历史。

## 取消、接管与收尾

取消覆盖启动和执行阶段：启动前取消不发出执行回合；执行请求已发出则可能已有部分修改。不要承诺回滚；实际已经完成的任务仍按完成结果呈现。

跨会话恢复：`/chatgpt-use <任务ID>` 仅选择并绑定任务，之后停止；`/chatgpt-resume` 才接管已有运行、继续审批或问答。接管沿用原 run 和 Codex UUID；旧会话尚未提交的审批凭据及后续答案提交失效，必须由当前负责人继续。不要复用另一会话的 sessionId。会话已有自己的活动运行时，先完成或按用户要求取消，不能直接改绑其他任务。use 使用独立的短时绑定锁，resume 使用短时交互锁转移负责人及代次；不释放长执行锁、不重启任务。审批 gate 绑定负责人及代次，接管前尚未提交的 gate 作废；已提交决定保留。

收尾以 Codex 主进程退出为准，随后最多约 2 秒读完剩余输出。`lastRun.leftoverProcesses` 为 true 时告诉用户有残留进程，本工具没有结束它，不要自行结束；实现和修复另在 `delivery.warnings` 说明，之后的文件改动由快照校验发现。

文件占用：任务文件被其他程序短暂占用时自动重试，保存最多约 10 秒，读取和锁约 1 秒。返回“无法保存 …”表示一直被占用：原样告诉用户是哪个文件，请用户关闭占用它的程序，再用 status 和实际文件核对。此时状态可能停在执行中，但 Codex 可能已经完成，输出在任务目录的 `<运行ID>.*` 文件；**不重新执行**，成果可用 `/claude-review-result` 评审。

Codex 会话在工作流之外被删除时，命令报告“找不到本任务的会话”并记录 `threadLost`：说明原因，请用户运行 `/chatgpt-resume`，不自动重试或重建（见 [resume.md](resume.md)）。提示“正被占用”时：请用户关闭 Codex 或 ChatGPT 应用中打开的该会话后重试，不重建。
