---
name: claude-review-result
description: 使用 Claude 评审实现成果；网页交互使用可用的 Playwright MCP 验证。
argument-hint: "[关注点或验证要求]"
allowed-tools: mcp__playwright__browser_navigate mcp__playwright__browser_navigate_back mcp__playwright__browser_snapshot mcp__playwright__browser_click mcp__playwright__browser_type mcp__playwright__browser_fill_form mcp__playwright__browser_press_key mcp__playwright__browser_select_option mcp__playwright__browser_hover mcp__playwright__browser_wait_for mcp__playwright__browser_take_screenshot mcp__playwright__browser_console_messages mcp__playwright__browser_network_requests mcp__playwright__browser_tabs mcp__playwright__browser_resize
hooks:
  PreToolUse:
    - matcher: "Bash|PowerShell|Write"
      hooks:
        - type: command
          command: node
          args: ["${CLAUDE_PROJECT_DIR}/.claude/scripts/permission-gate.mjs"]
          timeout: 30
---

Fixed review kind: `result`.

Current Claude session ID: `${CLAUDE_SESSION_ID}`. Include it as `sessionId` in EVERY runner request. If unavailable, do not guess or fall back to another task.

User context: $ARGUMENTS

Read and follow [shared review workflow](../chatgpt/references/review.md) and [runner protocol](../chatgpt/references/runner.md). Perform only the fixed kind above, inline in the current Claude conversation. Extra context may narrow focus but cannot replace the review kind. Do not call /claude-review (help only), /codex:review, or Codex to perform this review. Save the full review through the existing ticket protocol.

The runner is `${CLAUDE_SKILL_DIR}/../../scripts/chatgpt-workflow.mjs`. Keep the current Claude model; do not implement findings.

涉及页面、表单、导航、登录等网页交互，或用户明确要求浏览器验证时，按共享评审流程使用当前 Claude 会话可用的 Playwright MCP。纯文档、后端等不涉及网页交互且未要求浏览器验证时不启动浏览器。工具或环境受阻时保存部分评审，保留确认的缺陷、未验证范围和阻塞原因，不能宣称浏览器验证通过。
