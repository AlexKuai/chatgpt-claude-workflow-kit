---
name: chatgpt
description: 查看本项目工作流的帮助、当前任务和下一步命令。
hooks:
  PreToolUse:
    - matcher: "Bash|PowerShell|Write"
      hooks:
        - type: command
          command: node
          args: ["${CLAUDE_PROJECT_DIR}/.claude/scripts/permission-gate.mjs"]
          timeout: 30
---

User input: $ARGUMENTS

Current Claude session ID: `${CLAUDE_SESSION_ID}`. The runner is `${CLAUDE_SKILL_DIR}/../../scripts/chatgpt-workflow.mjs`.

This entry is HELP AND STATUS ONLY. Read [command list](references/commands.md) and [runner protocol](references/runner.md). Call the runner as `node "<runner>" status <sessionId>`; do not create an inbox request file just to display help. If the session ID is unavailable/unexpanded, omit it for task listing only and clearly report the missing binding. Show the session binding, task, phase, saved UUID, pending planning/review questions, any `activeRun` (progress and Codex approvals waiting) and saved review draft when available, followed by relevant commands in Chinese. On `selectionRequired`, list returned tasks and suggest /chatgpt-use or /chatgpt-new; do not automatically select. Run status once and show what it returned: do not write or run other scripts, re-inspect deliverables, or re-check earlier reviews; list anything doubtful as an item for /claude-review-result. Report errors without inventing state. Do not call Codex, start question cards, select another task, approve a plan, or perform any other action.

If the user supplied an old action such as new or implement, point to the matching independent command; do not execute it through this help entry. Keep the current Claude model.

成果评审是否有效只看 `executionSummary.resultReview`：只有 `current` 才有效，其他值连同 `resultReviewNote` 如实展示；不能因为有历史报告或阶段是 reviewed-code 就说有效。

按 [帮助状态展示](references/status.md) 用中文解释当前任务、阶段和适用的下一步命令；使用命令表中的原样用法（必填尖括号和可选方括号），不要将所有参数统一显示为方括号。
