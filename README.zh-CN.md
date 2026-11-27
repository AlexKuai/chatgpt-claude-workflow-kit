# Codex 规划与实现，Claude 交互评审：项目本地命令包

本版提供独立的 `/chatgpt-*` 和 `/claude-review-*` 命令。Codex 负责需求规划、实现和修改；Claude Code 当前模型负责协调、问题卡片和评审。适用于普通项目文件夹中的代码、文档、配置和混合交付物，不要求存在或安装 Git。

本版提供 18 个中文命令入口，统一必填和可选参数提示，并增强网页交互成果的 Playwright MCP 验收；保留会话绑定、问答保存与恢复、评审交接机制。本文只描述当前行为，各版本的变更见 [CHANGELOG.md](CHANGELOG.md)。

Claude Code 自身的 “Jump to bottom”“auto mode on” 等界面文案不受本包控制，不能通过修改命令描述中文化。

本包不固定模型、不改变登录方式、不安装全局设置。直接调用本机 Codex CLI，并非 `/codex:rescue` 的别名，也不依赖 codex-plugin-cc。可以与原插件并存，但两者的会话恢复映射不能混用。

## 1. 复制、升级与检查

前提：已安装 Claude Code、已登录的 Codex CLI、Node.js 20+。Git 为可选工具。将本包 **`.claude` 文件夹合并复制到目标项目目录**，然后重启 Claude Code。

升级时请在没有运行中的任务时完整复制本包自己的 Skills（含 `skills/chatgpt/references/` 下的全部文件）和 scripts；不要只复制单个 runner，不要在审批等待中替换 runner 或 hook，也不要覆盖项目的其他配置。保留 `.chatgpt-workflow`（或旧 `.astra-workflow`）及 Codex 本地历史，不复制其他项目的任务状态。旧任务仍可查看和恢复；缺少结构化目标时，在下一次实现或修复前运行 `/chatgpt-plan 补齐当前任务的最终交付目标，保留已确认范围`，随后重新 `/claude-review-plan`。不必新建任务或换 Codex UUID，旧问答和报告保留，原批准不能自动扩展为修改授权。

```text
项目根目录/
  .claude/
    scripts/chatgpt-workflow.mjs
    scripts/goal-contract.mjs
    scripts/file-snapshot.mjs
    scripts/app-server-client.mjs
    scripts/codex-bridge.mjs
    scripts/control-store.mjs
    scripts/permission-gate.mjs
    scripts/runtime-questions.mjs
    scripts/output-view.mjs
    skills/chatgpt/SKILL.md
    skills/chatgpt/references/
    skills/chatgpt-new/SKILL.md
    skills/chatgpt-implement/SKILL.md
    skills/chatgpt-*/SKILL.md
    skills/claude-review-plan/SKILL.md
    skills/claude-review-result/SKILL.md
    skills/claude-review/SKILL.md
```

每个 Skill 就是一个斜杠命令，不需要另建 `.claude/commands`。输入 `/chatgpt-` 或 `/claude-review-` 可筛选命令；实际菜单加载依赖 Claude Code。[官方 Skills 说明](https://code.claude.com/docs/en/skills)

已有 `.claude` 时只合并本包文件，不替换整个目录；同名文件若自行改过，先备份或比较。本包没有 `CLAUDE.md`、`settings.json`、权限绕过配置或全局钩子；权限 hook 只写在本包 Skill 中，使用命令后在当前会话生效。请在包含 `.claude` 的项目根目录启动 Claude Code，否则 hook 找不到脚本，Codex 的越权请求会被拒绝。

从旧版升级：

1. 合并新版 `.claude`，包括所有入口、共享 references 和脚本；不要混用新旧脚本与 Skill。若曾复制试用版，**只删除旧的 `.claude/skills/claude-review-code` 目录**；合并复制不会替你删除旧入口，不要删除其他 Skill。
2. **保留项目 `.chatgpt-workflow`**，不要删除任务、UUID、问答或评审报告。任务 schema 和内部 `code` 评审记录保持兼容，无需手工改文件。
3. 重启 Claude。旧任务还没有 Claude 会话绑定，第一次运行 `/chatgpt-use <任务ID>`，之后 `/chatgpt-resume`。
4. 从 2026-11-23 之前的版本升级时，扫描规则有变化（新增排除 `.claude/settings.local.json`），升级前保存的评审会过期一次，按提示重新评审即可。旧版生成的审批凭据不跨版本沿用。旧的 `skills/chatgpt/references/workflow.md` 已不再使用，可以删除。
5. 需要 Codex CLI 支持 `app-server`（本包在 0.171.0 上验证）。较旧版本可在 `.claude/chatgpt-workflow.json` 设置 `"transport": "exec"` 回退，但没有审批回传。
6. 审批控制文件保存在 `~/.chatgpt-claude-kit/`，卸载本包时可一并删除。
7. 如果使用最早的 Astra 包，仅移除该包自己的旧 `astra`、`opus-review` Skill 和 `astra-workflow.mjs`，不要删除其他配置。保留 `.astra-workflow`，新版会原地复用旧任务；若新旧目录都存在 active.json，会停止并报告歧义，不自动删除或合并。

不要把运行后的 `.chatgpt-workflow` 或 `.astra-workflow` 当模板复制到别的项目。这些目录包含真实需求、回答、项目路径和模型运行记录。

在终端检查：

```sh
node .claude/scripts/chatgpt-workflow.mjs doctor
codex login status
claude
```

`doctor` 检查 Node、Codex 路径和版本，并显示扫描规则与可选 Git 状态，不调用模型，不验证模型权限或登录计费。应确认 Codex CLI 使用你希望的 ChatGPT 登录；如果 CLI 使用 API 计费，本包不会自动改成订阅计费。

Windows 无法找到 Codex 时，可以使用本项目 `.claude/chatgpt-workflow.json` 的 `codexCommand` 配置；详细格式见 [配置说明](.claude/skills/chatgpt/references/internals.md)。不需要改全局 PATH。

## 2. 模型与模式：Manual 逐项确认，Auto 自动审查

Codex 新建与恢复会话均不传模型、推理强度或 profile 覆盖参数，沿用 Codex 自身配置和原生恢复规则。另一个交互窗口临时切换的模型不一定成为新 CLI 进程的持久配置。Claude 协调和评审沿用当前会话模型，所有入口都没有模型覆盖字段。

**Claude 的模式与 Codex 的沙箱是两套机制。** 本包为 Codex 规划、改计划、恢复摘要设置 `read-only`；实现和修复设置 `workspace-write`。沙箱不随 Claude 的界面模式改变；**随模式改变的只是 Codex 越权请求由谁批准**。

| Claude 模式 | Codex 越权请求 | 适合 |
| --- | --- | --- |
| Manual、acceptEdits | 在 Claude Code 原生权限框显示真实命令、目录、理由；Yes 批准一次，No 可附反馈并转给 Codex | 默认，逐项把关 |
| Auto | 由 Codex `auto_review` 按风险批准或拒绝，不弹窗，结论写入审计 | 长任务、可信范围 |
| bypassPermissions | 与 Auto 相同，不做无条件放行 | 不建议 |
| dontAsk、未知 | 自动拒绝并列入结果 | — |
| Plan | 不启动实现或修复 | 不使用 |

切换模式（Shift+Tab）在**下一个 Codex turn** 生效。运行中由 Auto 改为 Manual 时，本轮仍由自动审查处理；要立即接管，请让 Claude 取消后再恢复。想让 Auto 也弹框，设置 `"permissions": {"auto": "ask"}`；想让 Auto 直接拒绝越权，设为 `"never"`。

审批要点：

- 默认只批准一次。明确说“本次运行内同类都允许”时才扩大到本次运行，且会再确认一次；不写入全局规则。
- 模型不能代答：批准命令必须经过权限 hook 弹框；缺少确认码会被拒绝。`/clear`、`/resume` 之后 hook 会被移除，运行 `/chatgpt-resume` 即可重新加载。
- 内容过长无法完整展示、类型未知、30 分钟未答复的请求一律拒绝；Codex 继续执行并在结果中列出受阻项。
- 规划阶段保持只读沙箱，文件修改申请一律拒绝；命令申请照常弹框并标注“规划阶段”。
- 权限框里选“始终允许”：只对本包的审批命令无害，后续审批照常弹框；对其他命令选“始终允许”会改写 `.claude/settings.local.json`，本次运行后续审批会失效。执行中请尽量只选单次允许。
- 请求文件、状态查询等工作流自身操作不再弹框；`/chatgpt-implement`、`/chatgpt-fix` 只在你输入命令的当轮免弹框。Claude 评审自己运行的测试命令仍按正常权限处理。
- 边界：此机制防误批和模型跳步，不防能以你的账户读取用户目录的恶意程序。实现阶段 Codex 可以写项目目录，包括 `.claude`；执行期间若本包脚本或权限配置被改动，后续批准自动失效并在结果中警告。

规划、问答和评审也要保存文件，因此不应按 Claude 原生的 Plan 模式流程来使用本包。

| 阶段 | Claude 模式 | 文件操作 |
| --- | --- | --- |
| Codex 规划、需求问答 | Manual 或 Auto | Codex 只读分析；宿主脚本保存计划、问答和会话状态 |
| Claude 计划评审、评审问答 | Manual 或 Auto | 读取项目，保存评审票据、回答和报告 |
| Codex 修改计划 | Manual 或 Auto | Codex 只读分析；宿主脚本保存修订计划 |
| Codex 实现计划 | Manual 或 Auto | Codex 按获批范围修改交付物；宿主保存执行记录 |
| Claude 评审成果 | Manual 或 Auto | 检查成果、执行适用验证并保存评审记录 |
| Codex 修改成果 | Manual 或 Auto | Codex 按有效评审修改；宿主保存结果 |

启动后检查当前模式；如果处于 Plan，手动切到 Manual 或 Auto，以界面实际显示为准。**问题卡片不依赖 Plan 模式**，Manual 和 Auto 中照常进行需求问答和评审问答。Auto 仍可能拒绝调用，本包不把它作为免审批保证。[官方权限模式说明](https://code.claude.com/docs/en/permission-modes)

辅助脚本保存任务、UUID、计划、问题、答案和报告都涉及写入工作流元数据。这里的“Codex 规划只读”只指 Codex 子进程，不能把整个命令当作零写入操作。如果在 Plan 中发起需要持久化的 Kit 命令，先说明需要写哪些记录，并请用户切换到 Manual 或 Auto 后继续；不先尝试写入，也不伪装写入或绕过拒绝。Manual 仍遵守正常工具审批，进入该模式不等于所有操作自动获准。Claude 的“只评审、不修改业务交付物”由 Skill 指令与正常权限约束，不是独立 OS 只读沙箱。

本包不调用 Claude 原生计划批准流程来启动 Claude 实现，也不依赖“进入 Auto”弹窗。通过 `/chatgpt-implement` 或 `/chatgpt-fix` 明确发起对应阶段；处于哪种模式本身都不会授权实施。

Codex 在独立进程中运行，Claude 的工具超时不会结束它；超过等待时间时 Claude 显示进度并继续等待。说“取消本次执行”会中断 Codex 并终止其进程树。退出 Claude 后重新进入，运行 `/chatgpt-resume` 可接上进行中的执行或重新显示待审批项。

## 3. 完整八步操作

下面只有 `claude` 在终端运行，其余 `/` 命令在 Claude Code 对话框输入。

### 完整流程与简化流程

下面的八步是推荐的完整流程，规则不变。评审可以跳过，两种流程能随时互换：

| 操作 | 已评审 | 没有评审 |
| --- | --- | --- |
| `/chatgpt-new`、`/chatgpt-plan`、`/chatgpt-revise-plan`（或 Claude 规划的 `/claude-new`、`/claude-plan`、`/claude-revise-plan`）后 `/chatgpt-implement` | 直接实现，不弹卡片 | 弹卡片：先评审计划 / 跳过评审直接实现 |
| `/chatgpt-implement` 或 `/chatgpt-fix` 后 `/chatgpt-plan` | 直接规划，不弹卡片 | 弹卡片：先评审成果 / 跳过评审继续规划 |

- 想省一步，可在命令后写明，例如 `/chatgpt-implement 跳过评审`，不再弹卡片；只对这一次有效。
- 选“先评审”：Claude 当场评审后停下，你再输入一次原命令。取消或超时不算选择，什么都不会执行。
- `/chatgpt-revise-plan` 后交付目标没变，沿用原评审，不弹卡片。评审后项目文件有变化，也会弹卡片并列出变化的文件。
- 成果评审后又改了文件、改了扫描规则，或评审报告被改动、丢失，都不再算“已评审”：`/chatgpt` 会显示原因，`/chatgpt-plan` 会弹卡片。
- 不评审就规划时，上次的未完成项和旧评审意见会交给 Codex 核对；但这次成果不能再单独评审。
- 跳过评审的计划执行过一次后，不会重复执行；只有明确失败且确认没有文件变化时可以重试。其他情况请用 `/claude-review-result`、`/chatgpt-fix` 或 `/chatgpt-plan` 继续。
- `/chatgpt-fix` 和 `/chatgpt-revise-plan` 以评审报告为输入，仍需要先有对应评审。评审做到一半时，先用 `/chatgpt-resume` 完成。

### 另一条规划路线：Claude 规划，ChatGPT 评审计划

想让 Claude 写计划、ChatGPT 挑毛病时，把规划阶段换成：

1. `/claude-new <需求描述>`：Claude 只读检查项目，必要时用问题卡片问你，然后保存计划和交付目标。已有任务要重新规划用 `/claude-plan [补充说明]`。
2. `/chatgpt-review-plan [关注点]`：Codex 在只读沙箱中评审计划，不改文件、不改计划，保存结论、发现和需要你决定的问题。
3. `/claude-revise-plan [修改重点]`（按需）：Claude 逐条核实评审意见，说明接受或不接受的理由，需要你决定的地方会提问。交付目标没变时沿用原评审；目标变化需要再评审一次（或在实现前的卡片中跳过）。
4. 之后和默认流程完全相同：`/chatgpt-implement` → `/claude-review-result`（含 Playwright 浏览器验收）→ `/chatgpt-fix`。

说明：

- 两条路线可以混用，它们作用在同一份计划上。例如 Claude 写的计划也可以 `/claude-review-plan`，或 `/chatgpt-plan` 交给 Codex 重新规划。实现前的评审卡片按计划作者推荐评审方：Claude 写的推荐 ChatGPT 评审，Codex 写的推荐 Claude 评审。
- Claude 规划的任务在 Codex 第一次参与（评审、实现或重新规划）时才建立 Codex 会话，runner 会把原始需求、计划、目标和你的回答一并交给它。
- Claude 编写计划比只做评审多用 Claude 额度；ChatGPT 评审计划消耗 Codex 额度。
- Claude 规划做到一半退出，`/chatgpt-resume` 会接着问剩下的问题或重试保存。要放弃这次规划请明确告诉 Claude，原计划和评审不受影响。

### 第一步：打开 Claude Code

在目标项目目录运行（普通文件夹即可）：

```sh
claude
```

### 第二步：选择 Manual 或 Auto

检查当前权限模式，若处于 Plan，手动切到 Manual（逐项确认）或 Auto（自动审查）。后续各阶段不再切回 Plan，可以随时在 Manual 与 Auto 之间切换。不要使用带 plan 权限模式的启动方式来运行本流程。

### 第三步：委托 Codex 规划并回答问题

```text
/chatgpt-new 编写新员工开发环境搭建文档，覆盖 Windows 和 macOS，包含验证步骤与常见故障排查。
```

命令后的全部文字都是需求原文，不需要手写名称、`new` 或模型参数。当前 Claude 会建议简短英文名称，脚本生成实际任务 ID，例如 `onboarding-guide`；遇到重名会使用 `onboarding-guide-2` 等后缀，不覆盖已有任务。名称无效或没有建议时，回退为 `task-需求哈希前8位`。示例 ID 仅作说明，以创建后实际显示为准。

创建后会显示实际任务 ID、需求摘要和当前会话绑定。后续 `/chatgpt-plan`、`/chatgpt-implement` 等命令自动使用该绑定，无需记住任务 ID。名称只是标识，不替代完整需求或决定交付范围；后续修改需求不会重命名任务。新入口不再识别旧的“任务 ID + 需求”格式，首词也会作为需求内容保留。

每次新建操作由 Skill 自动生成并保存一个创建请求 ID；同一次失败重试复用它，不会重复创建或自动重跑 Codex。若任务已创建但 Codex 启动失败，会保留实际阶段、错误及可能已有的 Codex UUID。首次规划明确失败且没有 UUID 时，用户执行 `/chatgpt-resume` 可在原任务中重试首次规划；runner 先核对进程与事件日志，发现 UUID 则恢复它，结果不明或进程可能仍运行时停止。保留原需求、绑定和失败记录，不生成第二个任务。已有 UUID 的正常恢复仍不重跑实现或修复。 不要通过反复输入新建命令来重试同一请求。相同需求的再次主动新建仍是独立任务。历史请求重放不会覆盖后来选择的其他任务绑定。

命令创建任务及 Codex 会话，并绑定当前 Claude 会话。Codex 只读检查项目，提出必要问题；Claude 将问题呈现为原生选择卡片或文字问题，保存你的真实回答并自动送回同一个 Codex 会话。每次回答后不用再输入斜杠命令。

需求已经清楚时，Codex 可以直接完成计划，不强制制造问题。存在待回答问题时不会实现；规划完成后显示完整计划并停在待评审阶段。

没有活动问题轮时，补充需求用：

```text
/chatgpt-plan 补充：需要覆盖公司代理环境，暂不包含容器方案。
```

活动问答中的普通回答会自动交回对应流程；问答以外的普通聊天不会天然转交给 Codex，请用 `/chatgpt-plan`。

### 第四步：Claude 评审计划并进行必要问答

```text
/claude-review-plan 重点检查跨平台差异、步骤完整性与验收方式。
```

关注点可以省略。当前 Claude 模型读取真实计划和相关文件，发现重要决策缺口时直接与你问答，不委托 Codex 代答。每个问题轮和真实回答都会保存；收齐后自动完成评审。

报告包含发现编号、证据、修改建议、验收方式、已确认决定和检查限制。它不是切换模型的命令，也不会自行修改计划或批准实施。

### 第五步：Codex 根据评审修改计划

```text
/chatgpt-revise-plan
```

也可以指定范围：

```text
/chatgpt-revise-plan 优先处理 R1 和 R2，保留已经确认的范围。
```

脚本将已保存的计划评审和原始问答交给原 Codex 会话。Codex 检查建议是否成立，再修改计划，**不开始实现**。新的重要选择仍通过规划问答解决。

普通评审意见修订可以直接进入明确授权，不强制再评审一次；如果增加范围、产生重大方案变化，或修订中新问题使原评审关系不再适用，应再运行 `/claude-review-plan`，或在实现时选择跳过。没有修改意见可以跳过第五步。

### 第六步：Codex 实现计划

输入：

```text
/chatgpt-implement
```

这条命令代表你授权执行当前展示的计划。Skill 先检查评审与未解决决策（没有评审时弹卡片让你选择），再登记批准并实施，不要求额外 `/approve`。如果当前仍在 Plan，先提示切换，不启动写入子任务。

实现包括代码、文档、配置或混合成果。Codex 保留无关改动，按计划执行适当验证并报告实际结果。不会自动提交、推送或部署。

执行前会展示任务、计划版本、最终交付物、允许修改范围、排除项和验收要求。需求与评审明确时直接继续，不重复要求批准；有冲突或必要问题未回答时停止并澄清。执行中 Codex 需要越权时，按当前模式弹权限框或自动审查；执行摘要列出批准与拒绝项。

### 同一个命令，两种交付目标

只调查原因：

```text
/chatgpt-new 只调查密码强度检查失效的原因，交付原因报告、证据及修复建议，不修改业务代码或配置。
/claude-review-plan
/chatgpt-implement
/claude-review-result
```

这里执行的交付物是报告，没有业务文件变化是正常结果。报告由宿主保存在任务工作流目录，不意味着 Codex 处于只读沙箱：implement/fix 仍使用 workspace-write，范围由获批目标与正常权限约束。

调查后完成修复：

```text
/chatgpt-new 定位并修复密码强度检查失效，最终交付代码修改、必要测试及实际验证结果；不恢复无关功能，不提交、不部署。
/claude-review-plan
/chatgpt-implement
/claude-review-result
```

如果计划评审有修改意见，先 `/chatgpt-revise-plan`；交付目标变更后原评审不再沿用，可重新评审，或在实现时选择跳过。只写“排查这个问题”而未说明是否要修复时，规划问答会要求明确目标；已有明确回答则不重复提问。两种任务规划期间都只读，但未来执行要求不同。

已有调查任务转入修复，可用 `/chatgpt-plan 基于已有原因报告，增加实际修复和验证作为最终交付；先明确修改范围和验收条件`，重新评审后实施。不能仅靠 `/chatgpt-fix` 把报告范围扩大成业务修复。

### 如何判断本次执行是否完成

CLI 正常退出只表示调用结束。脚本校验结果结构与交付项覆盖，Claude 成果评审检查事实与质量。显示“Codex 自报已完成”仍需成果评审；部分完成、受阻和未验证范围会单独列出。

修改任务未检测到本次变化时会提示核对，并展示 Codex 的解释和验证依据。已有实现满足要求可以无需修改；仅交原因报告不能视为修复完成。有变化也不自动通过。结果缺失或格式无效时保留原始输出，建议 `/claude-review-result` 核对实际成果，不自动重复执行。文件快照排除目录及项目外部状态仍需实际检查；没有历史内容备份时明确对比限制。

### 第七步：Claude 评审实现成果

输入：

```text
/claude-review-result 重点检查操作步骤是否可复现，以及平台差异是否写清楚。
```

当前 Claude 模型检查批准计划、实现前基线、任务变更和实际交付物，不只看 Codex 完成摘要：

| 成果 | 评审重点 |
| --- | --- |
| 代码 | 功能、回归、兼容性及实际验证 |
| 文档 | 需求覆盖、事实与逻辑、结构、术语、示例和链接 |
| 配置或脚本 | 环境假设、配置含义、执行行为及验证 |
| 混合成果 | 分别检查，并核对相互一致性 |
| PDF、Word、图片 | 用实际可用的读取或渲染工具检查内容/外观，并列出未检查部分 |

文件存在或哈希改变不代表内容已经检查。没有对应工具时必须注明检查不完整，不能假装已读取二进制文档。必要决策同样通过 Claude 问答完成并保存。

涉及网页交互时执行下节浏览器验收。导航、快照、点击、填表、截图等常用 Playwright 操作在本次评审当轮免弹框；执行脚本、上传文件、启动服务和运行测试仍按正常权限处理。不想预先放行浏览器操作时，删除 `claude-review-result/SKILL.md` 中的 allowed-tools 一行。

### 第八步：Codex 修改成果

输入：

```text
/chatgpt-fix
```

也可以限制范围：

```text
/chatgpt-fix 处理 R1、R2，暂缓 R3。
```

Codex 读取当前有效的成果评审和原始问答，验证发现后修改相关交付物，按类型进行检查。`fix` 不限于代码修复。报告或源文件已变化时旧评审会被拒绝，必须重评当前版本。

修改后可再 `/claude-review-result` 复核；没有有效修改意见就不必运行 fix。复核是评审，不自动启动下一轮修改。

### 网页交互的浏览器验收

当需求或实际变更涉及页面、表单、导航、登录等网页交互，或你明确要求浏览器验证时，Claude 按 Skill 调用本会话已配置、实际可用的 Playwright MCP。纯文档或后端任务若不涉及网页交互且没有明确要求，不强制启动浏览器。

```text
/claude-review-result 使用 Playwright MCP 验证登录、退出和错误提示。
```

执行顺序：检查计划和真实变更 → 发现可调用的 MCP 工具 → 确认项目测试地址与验收场景 → 在已有授权内启动必要的测试服务并确认可访问 → 操作页面、检查实际状态并记录证据 → 保存正式评审。缺少地址、测试账号或关键验收条件时通过原有评审问答补齐；账号可由用户在浏览器手动登录，不要求把密码保存到任务问答中。

这会明确指示 Claude 调用浏览器，但它是模型执行的 Skill，并不是确定性的浏览器启动脚本。工具是否可用、是否弹出窗口、新实例或已有连接均取决于 MCP 配置。Codex 不共享 Claude 的 MCP 或登录会话。不自动安装 MCP、不扩大权限、不自行切到生产环境。[Playwright MCP 官方说明](https://github.com/microsoft/playwright-mcp)

网页操作只在已授权的测试场景内进行；评审期间不修改业务代码、测试断言或验收标准。权限或模式阻止操作时正常报告并按权限流程处理。

**受阻时保存部分评审：** 已确认的问题仍可交给 `/chatgpt-fix`；未启动浏览器、服务不可访问或无法登录的场景记为“受阻”，不能算通过，也不直接视为产品缺陷。存在未回答的必要决策时，仍需先完成问答；不能用部分报告绕过门禁。

成果报告固定包含“验证记录”：浏览器是否需要、实际工具、测试地址、逐项通过/失败/受阻/不适用、复现步骤、预期与实际、证据路径和未验证范围。发现分为产品缺陷、测试问题、环境问题、新增建议；部分场景通过不代表整体验收完成。截图等优先放在返回的 `paths.task` 下的 `evidence/`（含兼容旧目录），工具限制位置时记录实际路径，不虚构复制成功。

`/chatgpt-fix` 接收完整评审，优先修复已确认范围内的问题，不能削弱测试断言，也不能自动实施新增建议。Codex 仍运行其环境允许的检查。修复后再次 `/claude-review-result`，重跑失败项、相关回归项及已解除阻塞项；旧截图不作为新版本通过的证据。

## 4. 问答、退出与恢复

### 两种问答的分工

| 阶段 | 谁生成问题/解释选项 | 谁显示卡片并记录 | 回答交给谁 |
| --- | --- | --- | --- |
| 需求规划、计划修订 | Codex | 当前 Claude 会话 | 同一个 Codex 会话 |
| 计划或成果评审 | 当前 Claude 模型 | 当前 Claude 会话 | Claude 完成评审，再随报告交给 Codex 修改 |

取消、跳过、空回答、超时均不作为选择。每次实际回答立即保存，即使其余问题没有回答；恢复时只补问缺失项。如果请求“先解释选项”，会解释并保留待选择状态，不把解释请求记成选择。界面没有卡片工具或问题适合自由文本时，在同一对话中使用文字问答。

只有成功落盘的回答能从项目记录恢复。若一次写入被权限阻止，会说明尚未保存；不能承诺这条未保存回复在退出后仍可由脚本恢复。原生卡片的视觉状态也不保证跨重启保持一致，但已保存的内容与待办状态可恢复。本包不修改 Claude 私有 transcript。

### 恢复最近或指定 Claude 会话

在同一项目目录：

```sh
claude -c
```

或者在 Claude 中通过 `/resume` 选择历史会话。`claude -c` 恢复当前目录最近的会话。[官方 CLI 说明](https://code.claude.com/docs/en/cli-reference)

随后：

```text
/chatgpt
/chatgpt-resume
```

`/chatgpt` 只显示帮助和状态，不调用 Codex、不打开问题卡片。`/chatgpt-resume` 根据状态路由：

1. 未完成的 Claude 评审：恢复相应问题、已有回答或已保存报告草稿；不会发给 Codex。
2. 未完成的 Codex 规划问题：恢复缺失回答，或重试已保存完整答案的发送。
3. 首次规划失败且没有 UUID：核对原失败记录，在同一任务重试规划，并继续正常问答。
4. Codex 会话已被删除：弹出卡片，选择重建 Codex 会话或重试原会话；取消则不变。
5. 其他没有未完成问答/评审的情况：用保存的明确 UUID 让 Codex 只读回顾，列出已完成和下一步。

若问答期间计划或成果改变，旧评审不能直接完成。重新核对当前源文件并取得新评审版本；旧答案保留为历史，不会自动作为新版本的决定。

最终报告已经写好，但问答历史的可读副本导出失败时，会明确返回警告；权威状态和报告仍然保存成功。修正导出问题后可重试相同评审保存，不需要重新问答。若报告本身写入失败，则恢复已保存草稿。二者不会混报。

### Claude 与 Codex 会话怎样对应

```text
当前项目 + 当前 Claude 会话 ID
  → 这个 Claude 会话选中的任务 ID
  → 该任务保存的 Codex UUID
  → Codex 原生本地历史
```

Skills 使用官方 `${CLAUDE_SESSION_ID}` 传入当前会话身份。恢复 Claude 后，第一次调用 kit 才解析绑定，不会在启动时自动调用 Codex。[Skills 会话变量](https://code.claude.com/docs/en/skills#available-string-substitutions)

在同一项目中，Claude 会话 A 可以绑定任务 A，会话 B 绑定任务 B。B 切换任务不会改变 A 的绑定。新会话、fork 会话或升级前的会话没有绑定时，会显示任务供明确选择，绝不静默采用项目最后一次任务：

```text
/chatgpt-use onboarding-guide
/chatgpt-resume
```

`use` 只选择并绑定已有任务，不创建 Codex 会话，不调用模型。如果在两个 Claude 会话中明确选择同一任务，它们共享该任务进度；绑定不是工作目录隔离，项目工作流仍串行运行。

恢复条件：保留工作流目录，并使用仍含该 Codex 历史的本地环境、账号及 CODEX_HOME。UUID 本身不能把完整历史搬到另一台电脑；模型上下文仍有窗口和压缩限制。CLI 用明确 ID 恢复，不使用 `--last` 猜测。[Codex 非交互恢复说明](https://learn.chatgpt.com/docs/non-interactive-mode)

**不支持用 `/rewind` 回退任务。** 它只回退 Claude 对话和 Claude 自己写的文件；任务阶段、评审、批准、已提交的回答、Codex 对话和 Codex 改的成果都不变，运行中的 Codex 也不会停。改计划用 `/chatgpt-plan`。用过 `/rewind` 后先运行 `/chatgpt-status`，不要直接重发 `/chatgpt-new`（会另建任务并改绑会话）或 `/chatgpt-implement`（批准仍有效时会再执行一遍）。成果需要回退时，请自己用 Git 或副本留底。

恢复不重跑实现或修复，也不把项目文件恢复到历史时刻。先查看当前成果，再发对应阶段命令。Codex UUID 不可访问时报告错误，不静默换模型、重建会话或创建新任务。**任务没结束前，不要在 Codex 或 ChatGPT 应用里删除或占用对应会话**；需要时用 `/chatgpt-status` 查看它的 UUID。失败的实现可能已有部分修改，应先检查实际文件。

## 5. 命令速查

| 命令 | 用途 |
| --- | --- |
| `/chatgpt` | 查看本项目工作流的帮助、当前任务和下一步命令。 |
| `/chatgpt-new <需求描述>` | 根据需求自动命名并创建任务，交给 Codex 规划和问答。 |
| `/chatgpt-plan [补充需求或讨论内容]` | 补充需求或继续 Codex 规划。 |
| `/claude-review-plan [关注点]` | 使用 Claude 当前模型评审计划，必要时问答并保存意见。 |
| `/chatgpt-revise-plan [修改重点]` | 让 Codex 根据已保存的计划评审修改计划。 |
| `/claude-new <需求描述>` | 根据需求自动命名并创建任务，由 Claude 规划和问答。 |
| `/claude-plan [补充需求或讨论内容]` | 由 Claude 为当前任务补充需求或重新规划。 |
| `/chatgpt-review-plan [关注点]` | 让 ChatGPT（Codex）在只读沙箱中评审当前计划并保存意见。 |
| `/claude-revise-plan [修改重点]` | 由 Claude 根据已保存的计划评审修改计划。 |
| `/chatgpt-implement` | 授权 Codex 执行当前计划；未评审时可选择先评审或跳过。 |
| `/claude-review-result [关注点或验证要求]` | 使用 Claude 评审实现成果；网页交互使用可用的 Playwright MCP 验证。 |
| `/chatgpt-fix [问题编号或修改重点]` | 让 Codex 根据已保存的成果评审修改交付物。 |
| `/chatgpt-status` | 查看会话绑定、任务阶段和待处理事项，不调用 Codex。 |
| `/chatgpt-use <任务ID>` | 将明确选择的已有任务绑定到当前 Claude 会话。 |
| `/chatgpt-resume` | 恢复问答、首次规划启动失败或原会话的只读回顾。 |
| `/chatgpt-doctor` | 检查 Codex 路径版本、文件快照配置与可选 Git 状态。 |
| `/chatgpt-unlock` | 清理已结束进程遗留的工作流锁。 |
| `/claude-review` | 查看计划评审和成果评审命令的帮助。 |

尖括号表示必填，方括号表示可选，实际输入时不包含括号。

`new` 只有需求描述必填，缺少需求先追问，不创建空任务。自动任务 ID 使用不超过 64 字符的小写字母、数字和连字符，重名时追加后缀。`use` 仍需明确已有任务 ID，不猜测绑定；旧 ID（包括下划线）、Codex UUID 和会话映射不变。`argument-hint` 只是自动补全提示，Skill 和脚本仍负责校验。

`/chatgpt-new`、`/chatgpt-plan`、`/chatgpt-revise-plan`、`/claude-new`、`/claude-plan`、`/claude-revise-plan`、`/chatgpt-implement`、`/chatgpt-fix`、`/chatgpt-use`、`/chatgpt-unlock` 只能由你输入触发，Claude 不会在普通聊天中自行调用它们；帮助、状态、恢复和评审命令可由 Claude 在流程中调用（例如评审选择卡片中选“先评审”）。

不用每次填写模型、resume 或 wait 参数。普通聊天中的评审不会自动登记成有效评审报告，交接给 Codex 时请使用相应评审命令。

## 6. 数据、验证与限制

```text
.chatgpt-workflow/
  .gitignore                    # 忽略内部运行数据
  active.json                   # 兼容信息，不再用它选当前会话任务
  sessions/<hash>.json           # 当前 Claude 会话 → 任务
  creations/<request-id哈希>.json # 新建请求去重、名称保留与原始需求哈希
  tasks/<id>/state.json          # 权威状态、Codex UUID、版本、问答、评审草稿
  tasks/<id>/plan.md
  tasks/<id>/questions.json      # Codex 规划问答
  tasks/<id>/questions.md
  tasks/<id>/review-questions.json
  tasks/<id>/review-questions.md # Claude 评审问答，含旧版本历史
  tasks/<id>/*.plan-review.md
  tasks/<id>/*.code-review.md    # 成果评审沿用内部旧名称，兼容既有任务
  tasks/<id>/implementation-baseline.json
  tasks/<id>/*.request.txt
  tasks/<id>/*.result.md
  tasks/<id>/*.result.raw.txt    # 实现/修复的原始输出（即使无效也保留）
  tasks/<id>/*.result.json       # 有效的逐项交付结果和验证记录
  tasks/<id>/*.delivery.json     # 本次执行的交付状态、警告和证据路径
  tasks/<id>/*.before.snapshot.json
  tasks/<id>/*.after.snapshot.json
  tasks/<id>/*.events.jsonl
  tasks/<id>/*.rpc.jsonl         # 与 Codex app-server 的原始协议记录
  tasks/<id>/*.approvals.jsonl   # 权限审批与自动审查审计
```

`state.plan.contract` 保存任务类型、交付物、修改范围和验收要求，脚本据此生成 plan.md 顶部摘要。计划版本同时绑定正文和结构化目标哈希；改变目标需重新评审和批准。`state.delivery` 指向最近一次执行结果，包含对应计划版本、实际变化和验证；恢复摘要不会覆盖它，计划更新后旧结果只能作为历史证据。

`state.creation` 保存新建请求 ID、所属 Claude 会话、需求原文哈希、摘要和实际任务 ID。去重索引先于任务状态保存；若创建索引已保留但任务状态缺失，脚本停止并报错，不通过创建第二个任务掩盖失败。旧任务无此字段仍可继续使用，不需要重新命名或重新绑定。完整复制本包 `.claude` 即可升级，不复制或删除工作流数据；旧底层显式 task 调用继续兼容。

所有项目均使用 files-v1 文件快照，不依赖 Git。快照按内容哈希记录新增、修改、删除和类型变化；Git 状态、提交和差异只作辅助，不参与评审版本判断。固定排除 .git、.chatgpt-workflow、.astra-workflow 和 .claude/settings.local.json（Claude Code 保存权限选择时会改写它；执行期间的改动仍由防篡改检查报告）；默认排除 node_modules、.venv、__pycache__、.cache、.vs、.next、.nuxt、.turbo、coverage、test-results、playwright-report、.playwright-mcp、.pytest_cache、.mypy_cache、TestResults；bin/obj 仅在同级有 *.csproj、*.fsproj、*.vbproj 时排除，target 仅在同级有 Cargo.toml、pom.xml 时排除。扫描不采用 .gitignore，dist/build 默认纳入。排除目录不算已检查。UTF-8 文本每文件最多 1 MiB，每次快照最多新增 32 MiB 原文备份，按内容哈希去重；二进制、大文件及预算外内容只记录指纹和未备份原因。不能据此承诺完整回滚。 计划和成果评审均绑定文件指纹及扫描规则；评审期间实际文件变化使旧评审失效。Git 初始化、暂存或提交不会单独使评审过期。浏览器截图、渲染预览放到任务 evidence 目录或授权的项目外临时目录；.gitignore 忽略不等于文件快照忽略。

当前模型身份字段只是可选归属记录，不是独立认证。主要规划/执行消耗 Codex 所用账号额度；Claude 协调、展示结果、问答与评审仍消耗 Claude 额度，不能保证节省比例或零消耗。

本包的运行逻辑经过离线测试，并用真实 Claude Code 与真实 Codex 做了无界面联调；权限框点击、问题卡片、Auto 全链路、超长任务与 Playwright 复验仍需在界面中验证。完整证据与手动验收清单见 [VALIDATION.md](VALIDATION.md)。不宣称真实 UI 端到端已经通过。

在本包目录复现离线验证：

```sh
node --test validation/*.test.mjs
```

只需复制 `.claude` 即可运行；README 和 validation 无须复制到项目。卸载只删除本包自己的 Skill 与脚本，保留或备份工作流数据，不需要卸载 Codex、原插件或改全局配置。

## 非 Git 项目的快照与升级

快照规则见上一节。可在本项目的 `.claude/chatgpt-workflow.json` 配置扫描排除项，和现有 codexCommand 字段合并：

```json
{"snapshot":{"excludeDirectories":["node_modules",".venv","__pycache__",".cache","generated/cache"],"excludeFiles":["dev.db","logs/server.log"]}}
```

此配置**替换**全部默认排除项，包括 bin/obj/target 的条件排除；需要保留的默认目录请一并写入。

该数组替换普通默认排除项。单名称匹配任意层级同名目录，带 / 的路径相对于项目根目录；不支持通配符、绝对路径或 ..。设为空数组可纳入依赖目录，但固定排除项始终生效。改变规则会使相关评审失效；交付物涉及排除目录时先调整范围。

`excludeFiles` 排除单个文件，规则与目录相同（单文件名匹配任意层级同名文件，带 / 的路径相对于项目根目录）。浏览器验收或测试服务会写入项目内的本地数据库、日志时，先把它们加进来再开始评审，否则评审期间的写入会让评审在保存时过期。不配置 `excludeFiles` 时扫描规则与旧版完全相同。

任务内新增 `objects/<SHA256>` 文本原文备份，现有 baseline 与每次 before/after snapshot 文件使用 files-v1 格式。条目记录 contentFile 或 backupReason；变更清单保存在 delivery.changes，changesDetected=null 表示变化未知，不等于没有修改。执行前快照不可靠时不启动写入；执行后快照失败时保留执行输出，不自动重跑。

升级后旧任务仍可查看和恢复。旧 Git 快照、UUID、问答和报告不删除或改写；下一次实现须重新评审计划，下一次修复须重新评审成果。已实现任务的升级快照会明确标为“升级时当前文件”，不冒充实现前基线。旧任务若同时缺少交付目标，还需按前述流程补齐目标。

遇到此前“目录不可信，首次规划失败且没有 UUID”的任务：合并整套新版 .claude，保留运行记录，重启并恢复原 Claude 会话，运行 /chatgpt-status 后 /chatgpt-resume 即可尝试原任务恢复。不需要 git init，也不需要新建带 -2 后缀的任务。

## 7. 运行中断、接管与收尾

- **输出精简**：runner 只打印必要内容，完整记录仍在任务文件里；排错用 `status <会话ID> --full`。给本包命令加管道或拼接其他命令会被 hook 退回，Claude 自行改成单条命令重试，不弹框打扰你。同一会话里任何经过 hook 的命令都会更新权限模式；子代理的模式不影响主会话。
- **取消**：从启动 worker 起处理取消，初始化或恢复期间取消不会继续启动执行回合。执行请求已发出时会尝试中断，超过 10 秒仍未停止则终止进程树；已产生修改不会自动回滚。已经完成的任务返回实际结果。
- **接管**：原 Claude 会话仍可正常恢复。新会话先用 `/chatgpt-use <任务ID>` 绑定，再用 `/chatgpt-resume` 接管后台任务；不用解锁、不生成新 Codex 会话。旧会话未提交的审批凭据失效，已提交决定保留。本轮审批模式不因接管自动变化。
- **部分回答**：运行中一次问多题，只回答其中一题也会立即保存；恢复后只问剩余问题。用户明确更正会记录历史。退出 Claude 不等于取消，未回答或超时不算同意。
- **保存位置**：会话绑定在工作流 sessions 目录；外部 `~/.chatgpt-claude-kit/` 控制目录保存审批记录、运行负责人代次和逐题暂存。任务目录的 `<运行ID>.runtime-questions.json` 保存运行问答、原文答案、更正及终止原因。它们不会写进 Claude 私有聊天文件。归档失败时明确提示并保留外部暂存，后续续接先重试归档；不能以重跑实现替代恢复。
- **收尾**：Codex 主进程退出后约 2 秒内收尾，不等它留下的后台进程（例如插件更新的 `git clone`）。**残留进程**不会被结束，但会在状态中说明；实现和修复还会在交付记录中警告，因为它之后仍可能改动文件。
- **会话被删除**：在 Codex 或 ChatGPT 应用中删除任务的会话后，命令会明确说明原因，并保持任务状态不变。运行 `/chatgpt-resume`，可选择重建 Codex 会话（推荐）或重试原会话。重建不会重跑实现；丢失的只有旧的 Codex 对话。升级前因会话丢失而卡住的任务同样适用；旧版已作废的批准和评审不会自动找回。
- **会话被占用**：在应用中打开任务的会话可能使命令失败，关闭后重试即可。
- **任务文件被占用**：Windows 上，`state.json` 等文件被其他程序短暂打开时（查看状态、编辑器、杀毒软件），运行不会失败或中断。保存最多等约 10 秒；一直被占用时会指明文件和处理办法，不会重新执行。请不要长时间独占打开 `.chatgpt-workflow` 中的文件。
