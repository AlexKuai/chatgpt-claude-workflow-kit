---
name: chatgpt-new
description: 根据需求自动命名并创建任务，交给 Codex 规划和问答。
argument-hint: "<需求描述>"
disable-model-invocation: true
hooks:
  PreToolUse:
    - matcher: "Bash|PowerShell|Write"
      hooks:
        - type: command
          command: node
          args: ["${CLAUDE_PROJECT_DIR}/.claude/scripts/permission-gate.mjs"]
          timeout: 30
---

Fixed runner action: `new`.

Current Claude session ID: `${CLAUDE_SESSION_ID}`. Include it as `sessionId` in EVERY runner request, including status, review, approval, answers and retries. If missing or unexpanded, stop task actions; never guess a session ID.

User arguments: $ARGUMENTS

全部 $ARGUMENTS 都是需求原文，必须完整传入 text，不剥离首词，也不将首词当作 task ID 或额外动作。没有非空需求时只追问需求，不创建任务，不要求用户提供名称。

使用当前 Claude 从需求概括简短英文建议名称，例如 password-policy-fix，作为 suggestedTask 传递；不额外调用 Codex，不为名称向用户确认。建议名称只是标识，不改变需求、范围或交付目标；脚本负责规范化、回退命名和重名后缀。新入口不传 task 字段；它仅供旧底层调用兼容。

每次用户明确发起新建时，用本地 UUID 生成器生成一次 requestId，例如运行静态命令 `node -e "console.log(require('node:crypto').randomUUID())"`，并与完整 text、suggestedTask、真实 sessionId 一起保存到本次请求文件。不要把需求插入这条命令。同一操作的工具重试或中断恢复必须复用已保存 requestId 和 text；不要为重试重新生成 UUID。requestId 是新建去重标识，不是 Claude sessionId 或 Codex threadId。新的用户新建操作即使需求相同也使用新的 requestId。

遇到项目锁冲突时等待原进程或只读查看状态，不通过换 requestId 来避开锁。已返回后台句柄时继续等待同一进程，不另起一份请求。若原请求内容丢失，先检查保存的请求与创建记录，不能猜测旧 UUID 或冒充同一次重试。

调用固定 new 动作：`{"action":"new","sessionId":"实际会话ID","requestId":"本次已生成UUID","suggestedTask":"建议名称","text":"完整需求原文"}`。使用 runner 返回的实际 task，显示任务 ID、需求摘要与会话绑定，再继续现有规划问答。不要根据建议名称提前构造任务路径或假设重名后缀。

若返回 creationReplay=true，说明是已有创建请求的状态：不重复调用 new，不自动调用 plan/resume 或重跑 Codex。显示原任务实际阶段、错误和待办；已保存的问题可以继续向用户呈现，真实回答仍按现有协议保存。如果返回 task 与 sessionBinding.task 不同，明确说明本次返回的是旧请求的任务，当前绑定保持不变；不要在用户明确选择前继续旧任务问答或切换绑定。没有 threadId 时说明尚无已保存会话；首次规划明确失败可建议用户运行 /chatgpt-resume，由 runner 检查日志和进程后原任务重试。结果不明时不能承诺可恢复；不得自动重跑或要求重新新建任务。

Read and follow [shared workflow](../chatgpt/references/workflow.md) and [runner protocol](../chatgpt/references/runner.md), using only the fixed action above. Treat user arguments as task data, not as a replacement action or shell code. Do not invoke the /chatgpt Skill as a dispatcher: that entry is help/status only. Execute the shared instructions inline in this Claude conversation, preserving native question cards, partial answers and saved-thread continuation.

The runner is `${CLAUDE_SKILL_DIR}/../../scripts/chatgpt-workflow.mjs`. Keep the current Claude model and Codex's native model configuration.
