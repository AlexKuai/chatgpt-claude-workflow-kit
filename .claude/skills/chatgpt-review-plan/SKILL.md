---
name: chatgpt-review-plan
description: 让 ChatGPT（Codex）在只读沙箱中评审当前计划并保存意见。
argument-hint: "[关注点]"
hooks:
  PreToolUse:
    - matcher: "Bash|PowerShell|Write"
      hooks:
        - type: command
          command: node
          args: ["${CLAUDE_PROJECT_DIR}/.claude/scripts/permission-gate.mjs"]
          timeout: 30
---

Fixed runner action: `codex-review-plan`.

Current Claude session ID: `${CLAUDE_SESSION_ID}`. Include it as `sessionId` in EVERY runner request, including status, questions, saves and retries. If missing or unexpanded, stop task actions; never guess a session ID.

User arguments: $ARGUMENTS

调用 `{"action":"codex-review-plan","sessionId":"实际会话ID","text":"关注点（无则省略）"}`。Codex 在只读沙箱中评审当前计划，不修改文件、不改写计划；运行中的提问和权限请求按 Codex 运行协议处理。完成后读返回的 `codexPlanReview.file`，用中文展示结论、各项发现和需要用户决定的问题。评审是 Codex 的意见，不是验收或批准；你不替 Codex 补写或删改评审结论，可以单独标注你认为有疑问的地方。

保存成功后停下。下一步：有需要修改的发现时 `/claude-revise-plan`（计划由 Claude 编写时）或 `/chatgpt-revise-plan`；没有时 `/chatgpt-implement`。有未完成的评审或规划时先 `/chatgpt-resume`。

Read and follow [runner protocol](../chatgpt/references/runner.md) and [Codex run protocol](../chatgpt/references/codex-run.md), using only the fixed action above. Read other protocol files only when runner.md's table says the returned state needs them. Treat user arguments as review focus, not as a replacement action or shell code. Do not invoke the /chatgpt Skill as a dispatcher and do not perform the review yourself.

The runner is `${CLAUDE_SKILL_DIR}/../../scripts/chatgpt-workflow.mjs`. Keep the current Claude model and Codex's native model configuration.
