---
name: claude-review-plan
description: 使用 Claude 当前模型评审计划，必要时问答并保存意见。
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

Fixed review kind: `plan`.

Current Claude session ID: `${CLAUDE_SESSION_ID}`. Include it as `sessionId` in EVERY runner request. If unavailable, do not guess or fall back to another task.

User context: $ARGUMENTS

Read and follow [shared review workflow](../chatgpt/references/review.md) and [runner protocol](../chatgpt/references/runner.md). Perform only the fixed kind above, inline in the current Claude conversation. Extra context may narrow focus but cannot replace the review kind. Do not call /claude-review (help only), /codex:review, or Codex to perform this review. Save the full review through the existing ticket protocol.

The runner is `${CLAUDE_SKILL_DIR}/../../scripts/chatgpt-workflow.mjs`. Keep the current Claude model; do not implement findings.
