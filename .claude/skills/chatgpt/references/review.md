# Claude review and durable questions

Perform the review yourself, inline in the **current Claude Code session model**. Do not delegate review or review questions to Codex, invoke /codex:review, launch another Claude, or implement findings. Answer in Chinese. Exact model attribution is optional; use null when unavailable rather than inventing it.

The entry supplies fixed kind `plan` or `result`; legacy `code` means result. On /chatgpt-resume, use the saved reviewSession.kind. Read [runner protocol](runner.md) and include the entry's current `sessionId` in every request. Use the absolute runner path from the entry, not a path relative to this references directory. No binding means explicit task selection, never the last project task.

在 Manual 或 Auto 模式评审，不提示用户切回 Plan。读取交付物不修改业务文件，但创建评审票据、保存问题、回答、笔记和报告都要写工作流文件。若已知当前在 Plan，应在这些写入前说明原因，请用户手动切到 Manual 或 Auto 后继续；纯读取可进行，但不能声称已完成可供后续修复使用的持久评审。评审自身的命令仍需要正常工具审批；常用 Playwright 操作在本次 `/claude-review-result` 当轮免弹框，脚本执行与文件上传不在其内。不要自动改模式、修改权限或伪装写入。浏览器和测试服务按下述协议执行。评审阶段不得修改业务交付物、依赖、测试断言、验收标准或格式；避免会重写受跟踪文件的检查。只评审是指令约束，不是 OS 沙箱；原生问答在两种模式中照常使用。只有保存成功才能声明记录已持久化。

## Start or resume

1. Call `review-start` with fixed kind, current sessionId and optional user focus in `text`. Keep the returned opaque ticket, source version and snapshotFile. A valid unfinished review returns its original ticket/rounds; do not repeatedly start a new review. Read plan, relevant decisions, actual artifacts and saved notes. When the returned `delivery.shortened` exists, read its `fullRecord` first: the printed delivery is incomplete.
2. If /chatgpt-resume returned a reviewSession, continue that session. If `stale: true`, explain what changed and call review-start for its kind to obtain a new ticket, then reinspect the current sources. Old rounds are historical evidence, not decisions automatically carried over. If the plan was edited outside the workflow and review-start rejects it, use /chatgpt-plan to reconcile/re-plan, then obtain a fresh review; never force-save the old ticket.
3. Resume pending round answers before asking any new questions. When there are no unanswered questions and reviewSession.draft exists, retry `review-save` with ticket and kind and **omit text** to use the exact saved draft. Retry once per user continuation; another failure stops with the saved state. If no draft exists, finish the actual Claude review from the saved artifacts and decisions.

### 未完成检查的持久笔记

`review-questions.text` 仅在添加新问题轮时保存 notes，已有未答轮时不能用它更新笔记；也不能用虚构回答调用 `review-record-answers`，或用 `review-save` 绕过未答门禁。若等待回答期间新增缺陷、浏览器结果或阻塞信息，使用当前允许的文件写入工具，将完整累计笔记保存为 `paths.task/review-notes/<ticket>.md`。ticket 取 runner 返回的 UUID；记录 ticket、source version、时间、已检查范围、发现、证据和待办，更新前先读已有文件，保留先前记录。此文件只是评审中间资料，不是正式报告、决定或批准。

开始或恢复评审时，除 state 中的 notes/rounds 外，也读取同一 ticket 的该文件（不存在则跳过）。存在已保存正式 draft 时优先按原协议重试草稿，不偷偷把新增内容塞进重试；需修改报告时先完成恢复，再开始新评审。源版本已变化时旧笔记只作历史线索，必须重新核查，不将旧结论直接用于新票据。只有实际写入成功才说明笔记已保存；被权限阻止时明确尚未持久化，不伪称可恢复。最终完成评审时把已核实笔记纳入完整报告，由 `review-save` 正式登记，Codex 仍只接收正式报告及问答。

## Questions in the current conversation

Ask only when a material requirement, tradeoff or acceptance decision cannot be resolved by inspecting the project. Do not manufacture questions when requirements are clear, or make the user answer questions the files settle.

1. Before displaying a question, call `review-questions` with ticket, kind, 1–3 questions and optional `text` containing review notes. Each question has a unique `id`, unique exact `question`, short `header` (at most 12 characters), `multiSelect` boolean and `options` (2–4 label/description choices, or [] for genuinely open text). The returned reviewSession.pendingRoundId identifies the round. Do not replace an unanswered round.
2. Read the saved round's partialAnswers. Ask only missing questions using native **AskUserQuestion** for supported option questions; preserve question text, options, multiSelect and headers, omitting internal IDs from tool arguments. Map exact question text to the stored ID. Split batches to meet actual tool limits. For [] or unavailable/blocked card tools, explicitly use text questions in this same conversation; do not invent choices.
3. Wait for real answers. Cancellation, skipped questions, empty input, timeout and default/recommended selections are not user decisions. Never alter timeout settings. If the user asks for an explanation instead of deciding, explain it as Claude, then leave that question pending; do not save the explanation request as a choice or send it to Codex.
4. After EACH real answer/batch, immediately call `review-record-answers` with ticket, kind, roundId and the answered subset `[{id,answer}]`. Preserve selections, free text and notes exactly. Display a visible receipt only after saving succeeds. For a failed save report that the latest reply is not yet persisted and retry the same reply when permitted; previously saved partials remain available. Do not make up an answer to complete the round.
5. Once every question in the round is answered, continue reviewing automatically; no extra user slash command is needed. Further necessary rounds can be added. Corrections to the current round may update its staged answers before saving the review; for a correction to an earlier round, record a new explicit correction question/answer so the original stays auditable. Unanswered decisions block final review-save, approval, implementation and fixes.

Question cards and receipts remain in normal Claude conversation history. The runner also keeps review-questions.json and review-questions.md, with state.json authoritative. Do not write Claude's private transcript files or promise identical old card rendering after restart. A reply can only be recovered from project files if saving it succeeded.

## Inspect the appropriate artifact

**Plan review:** check requirements and prior decisions, feasibility, repository constraints, scope, acceptance criteria, missing decisions, and artifact-appropriate verification. Read relevant source to validate assumptions. Use section references when there is no code line.

计划评审必须对照 `plan.contract`、脚本生成的目标摘要、执行步骤和原始问答。确认交付的是报告、实际修改还是调查后修改；明确排除项和验收条件。规划调用的只读限制不能被误写成未来执行限制。若“仅修订计划、不改代码”等文字与修改目标冲突，记录阻塞发现并要求修订，不能自行删词、忽略冲突或批准执行。旧计划缺少目标时，提示先 `/chatgpt-plan` 补齐，再评审新版；保留历史记录。

**Result review:** 读取获批计划、implementation.baseline、最新结果和 snapshotFile。以 files-v1 文件清单、delivery.changes、备份原文及当前交付物检查新增、修改、删除和类型变化；Git 可用时差异与提交仅作补充，不能要求 Git 仓库存在。旧 Git 基线与 upgradeSnapshot 分开说明，升级快照不是实施前内容。没有历史备份时说明无法完成原文对比，继续核对当前内容与验收要求。文件指纹不是语义或视觉验证。

`delivery.planReview` 为 `skipped` 表示计划未经评审：成果评审时同时核对计划是否符合原始需求和问答，把计划本身的偏差也列为发现。

成果评审还要逐项核对 `plan.contract.deliverables` 与 `delivery` 中的交付结果、验证、前后快照和 `report`；不能把最近一次 resume 的回顾当执行报告。检查 delivery 的计划版本是否匹配。原始输出不合法时读取 `rawResult` 并检查实际文件，不要求先重跑实现才能评审。已声明完成也必须独立核实证据；交付物存在、变化哈希和模型自报都不是验收通过。

修改任务只交原因报告时明确记录“修复未完成”；没有变化但声称现状已满足要求时实际检查并验证，不能机械判失败。报告应逐项列出已完成、未完成、受阻、未验证内容。把范围内缺口交给后续 `/chatgpt-fix`；新增需求进入规划。浏览器验收仍按下述既有规则执行，离线结果或受阻场景不能算通过。

| Deliverable | Inspect |
| --- | --- |
| Code | Correctness, regressions, compatibility, relevant security and risk-based tests |
| Documents | Requirements coverage, facts with appropriate evidence, logic, structure, consistent terms, examples, links and reproducible instructions |
| Configuration/scripts | Environment assumptions, behavior, compatibility and appropriate validation |
| Mixed outputs | Each artifact and consistency between code, documentation and examples |
| PDF/Word/images | Actual content and rendered appearance using available readers/renderers; identify inaccessible pages/files and unverified layout explicitly |

不能仅凭二进制文件存在或哈希变化批准成果。必须用可用工具实际读取或渲染；工具缺失时标明未检查范围。临时预览与浏览器证据优先保存到任务 evidence 目录，或者已授权的项目外临时目录；不要认为被 .gitignore 忽略就不会影响文件快照。计划和成果评审都核对 files-v1 证据；排除目录必须明确未覆盖，涉及交付物时先调整扫描配置。范围为当前本地项目内的成果，可没有 Git；不扩展到任意云端文档。

## 网页交互的 Playwright MCP 验收（成果评审）

以下任一条件成立即执行本节，不等待用户再次提醒：需求或变更涉及页面、表单、导航、登录等网页交互；用户明确要求浏览器验证、页面验收或使用 Playwright。纯文档、后端等不涉及网页交互且未被明确要求时，不启动浏览器，验证记录注明“不适用”及原因。

1. 从批准计划、验收条件和实际变更列出要验证的场景；修复后重评时包含之前失败项、相关回归项和已解除阻塞项。先复用已有有效评审问答，不让用户重复回答已确认信息。
2. 检查当前 Claude 会话实际可调用的 Playwright MCP 工具（含运行时提供的工具发现机制）。不要猜测固定工具前缀或调用不存在的工具；不要假定 Codex 能共享 MCP、浏览器连接或登录态。无可用工具时记为受阻，并继续可做的静态检查，保存部分评审；不自动安装 MCP、换其他工具后声称使用了 Playwright，也不要求 Codex 修复 MCP 安装。
3. 从项目配置、README、已知启动日志等确定测试地址、环境和服务启动方式。不猜端口、不自行选择生产环境。缺少测试地址、账号可用性或关键验收条件时，通过上面的 review-questions / review-record-answers 协议补齐。只记录非敏感决定（如使用哪个测试角色、用户已手动登录），不要将密码、令牌或会话 Cookie 写入问答、报告或发给 Codex；可请用户在测试浏览器手动登录。
4. 在既有授权和当前权限允许时启动必要的项目测试服务，优先复用确认属于本项目的实例。确认服务就绪、目标地址可访问，再操作页面。保留本次启动的进程句柄，按项目惯例管理它，不重复启动或终止用户原有服务。模式、权限、依赖缺失或服务错误阻止执行时，记录实际原因和已尝试步骤，按正常权限流程处理；不扩大权限、不安装全局依赖、不自动切换环境。若缺少信息已成为必要决策，保持评审问答待完成；若已有足够信息确定仅环境受阻，则无需制造问题，可保存部分报告。
5. 只在已授权测试场景内执行页面操作；登录、表单等可能写入测试数据，应核对目标和操作范围，遵循正常权限控制。检查真实页面状态与反馈，结合源码分析原因。逐场景记录测试时间、目标地址、操作步骤、预期、实际、结果和证据。工具调用成功只代表工具执行成功，不等于产品场景通过；未运行、无法登录、无法访问、未看到预期状态不能写成“通过”。浏览器窗口是否显示、使用新实例或已有连接以 MCP 配置及实际工具结果为准，不能承诺自动弹窗。
6. 证据优先使用 runner 返回的 `paths.task` 下 `evidence/<ticket>/`；旧任务可能位于兼容目录，不硬编码新的工作流根目录。截图、日志和预览仅在工具允许时写到该位置。工具限定输出目录时记录实际路径；只有读取/复制成功才能声称证据已保存/复制，不伪造截图或证据。任务目录通常已被内部 .gitignore 忽略，应确认实际路径。若工具生成了非忽略文件导致快照变化，按原有 stale 规则重新取得评审票据并核对当前成果，不删除证据或改状态以绕过校验。截图和日志避免包含敏感登录信息。
7. 保存正式评审，包括部分评审。确认的缺陷与未验证范围同时保留；整体验收不完整时必须明确写“检查不完整”，不因个别通过而判整体通过。服务未启动、MCP 不可用或账号不可用归类为环境受阻；只有证据证明产品行为错误时才列为产品缺陷。测试脚本/用例问题单列，不修改断言来掩盖缺陷；新增建议单列为未批准范围。

保存部分评审沿用 review-save、版本与问答门禁。已回答的必要决策必须全部保存；尚有必要决策未解决时先保存 review notes/问题及部分回答，不能强行完成报告或启动修复。仅环境验证受阻、没有待决问题时，可正式保存“检查不完整”的报告，让用户通过 `/chatgpt-fix` 修复已确认的范围内缺陷。只有环境阻塞且无确认缺陷时建议恢复环境后重评，不制造代码修复任务。任何源文件变化均遵循原有过期检查。

修复后不能复用旧版本截图或旧“通过”结论作为本轮验证；重新检查当前版本并执行相关场景，仍受阻的如实保留。Claude 浏览器验收不替代 Codex 在自身环境的单元测试、构建或其他适当检查。

## Final report and handoff

Report the actual findings, for example:

```text
评审者：Claude Code 当前会话模型（已知时注明具体型号）
评审对象：计划/成果、source version、实际检查的文件
结论：可执行或符合要求 / 需要修改 / 检查不完整
R1 [高/中/低] 文件:行号、章节或页码 — 具体问题
证据与影响：……
建议修改：……
验收或验证方式：……
用户已确认决定：……
检查限制与实际验证结果：……

## 检查覆盖（成果评审必填）
交付物 | 总量（页/文件/场景） | 已读文字 | 已看渲染 | 未检查范围 | 证据路径
……

## 验证记录（成果评审必填）
浏览器验证：需要 / 不适用（原因）
实际工具：实际调用的 Playwright MCP 工具名；没有运行则写“未运行”及原因
测试地址与环境：实际地址及已确认的测试环境；未知则注明未知
测试时间与成果版本：本轮实际执行时间、source version
场景 | 结果（通过/失败/受阻/不适用） | 步骤 | 预期 | 实际 | 证据路径
……
未验证范围及阻塞原因：……
发现分类：产品缺陷 / 测试问题 / 环境问题 / 新增建议
确认缺陷：按 R1、R2 编号，说明证据、影响、修复范围与复测方式
新增建议：明确是否获批；未批准不进入自动修复范围
```

检查覆盖的写法：

- 每个交付物一行，范围写成具体页码、文件或场景，例如“渲染 1–21、30–52 页；未看 22–29 页”。数字来自实际测量，不估计。
- 读文字提取稿、看缩略图、看逐页渲染是三种不同检查，分开写，不互相代替。
- 只有覆盖全部范围时才能写“逐页”“全部”“完整”。存在未检查范围时，结论写“检查不完整”，并说明哪些发现可能遗漏。
- 检查命令失败的项目列入未检查范围。发现已保存报告有误时，在新评审中写明更正，不改旧报告。

这是报告约定，脚本无法证明是否真的看过。

Do not invent findings. Resolve necessary user decisions through the question protocol BEFORE finalizing; do not hide unanswered decisions in report prose. If evidence is unavailable, distinguish incomplete inspection from a passed review. The coverage and verification sections are mandatory for every result report, including non-web artifacts (browser not applicable, actual checks still recorded). It is a Skill reporting contract, not automated proof of browser execution: the runner stores report text and cannot attest that a browser ran. Never invent a tool run to satisfy the template.

Call `review-save` with exact ticket, kind, full text and optional confirmed model. It saves a durable draft before writing the final report and automatically appends the exact questions/answers. On failure, inspect status: an unfinished review can recover its draft through /chatgpt-resume; if status already shows the same completed report, retry the identical ticket to confirm/export rather than reviewing again. A returned `warnings` entry about readable export means the report and state ARE saved; tell the user which derived copy failed, and retry the same ticket after the export issue is resolved. Do not call that a failed final report or start Codex to repair it. A stale ticket requires fresh inspection, never forced save. Display saved report path and findings. Saving is not implementation approval.

For plan changes suggest /chatgpt-revise-plan; when accepted, /chatgpt-implement. For result findings suggest /chatgpt-fix, then /claude-review-result to check the result. Do not suggest switching to Plan for review. New scope requires updated planning and review. A review with missing inspection evidence must disclose it before any user authorization, not silently claim completion.

旧评审缺少 files-v1 证据时重新启动对应评审，保留旧报告和回答；不得编辑旧报告元数据伪装升级。快照只做有限文本备份，大文件/二进制没有修改前内容时如实说明。
