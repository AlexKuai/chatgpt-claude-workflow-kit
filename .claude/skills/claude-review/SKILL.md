---
name: claude-review
description: 查看计划评审和成果评审命令的帮助。
---

本入口只显示帮助，不执行评审。说明 `/claude-review-plan [关注点]` 评审已保存的计划；`/claude-review-result [关注点或验证要求]` 评审代码、文档、配置等实际成果，涉及网页交互或明确要求时使用当前会话可用的 Playwright MCP。两者都由当前 Claude 模型执行，支持必要的原生问答、保存决定及报告。即使用户附带旧的分派参数，也只指向对应独立命令，不在本入口执行。
