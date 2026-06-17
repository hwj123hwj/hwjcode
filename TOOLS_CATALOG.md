# Easy Code / DeepVCode 内置工具目录

> 生成日期：2026-06-16
> 共 **40 个工具类**（34 个核心注册 + 6 个动态注册），依运行模式实际可用 31~37 个

---

## 一、概览

工具分三大注册来源：

| 来源 | 数量 | 说明 |
|---|---|---|
| **Core 核心内置**（`config.ts`） | 34 | 始终注册或按模式条件注册 |
| **Feishu 飞书动态**（`feishuCommand.ts`） | 5 | 仅飞书常驻模式下动态注册/注销 |
| **Goal 模式动态**（`client.ts`） | 1 | 仅 `/goal` 模式下动态注册 |

---

## 二、核心内置工具（34 个）

### 📂 文件读取（2 个）

| # | 工具名 | 类 | 功能简介 |
|---|---|---|---|
| 1 | `read_file` | `ReadFileTool` | 读取单文件内容。支持文本、图片(PNG/JPG/GIF/WEBP/SVG/BMP)、PDF、Excel(.xlsx/.xls)、Word(.docx)。可指定行偏移和行数 |
| 2 | `read_many_files` | `ReadManyFilesTool` | 批量读取多个文件（支持 glob 模式）。拼接内容返回，自动处理混合文件类型。支持 .gitignore 过滤 |

**精简建议**：`read_many_files` 可覆盖 `read_file` 绝大多数场景（单个文件也可用 glob 匹配），但 `read_file` 有独立的图片/PDF 渲染能力，保留。

### ✏️ 文件写入与编辑（5 个）

| # | 工具名 | 类 | 功能简介 |
|---|---|---|---|
| 3 | `write_file` | `WriteFileTool` | 创建或覆盖写入文件。自动修正内容、写后 lint 检查 |
| 4 | `replace` | `EditTool` | 精确文本替换（old_string → new_string）。支持单次/多次替换，AI 容错纠偏 |
| 5 | `multiedit` | `MultiEditTool` | 单次调用内对多个文件执行多次顺序替换。支持 JSON 反序列化纠错 |
| 6 | `patch` | `PatchTool` | 应用 unified diff 补丁修改多个文件，支持增/删/改/移动 |
| 7 | `delete_file` | `DeleteFileTool` | 安全删除文本文件（先捕获内容以备回滚）。非文本文件需用 shell |

**精简建议**：
- `replace` + `multiedit` 功能高度重叠，`multiedit` 是 `replace` 的批量版。理论上可合并。
- `patch` 使用频率较低（需生成 unified diff），模型倾向用 `replace`/`multiedit`。可考虑移除或降级为辅助函数。

### 🔍 文件搜索与导航（3 个）

| # | 工具名 | 类 | 功能简介 |
|---|---|---|---|
| 8 | `search_file_content` | `GrepTool` | 基于 ripgrep 的正则全文搜索。支持文件类型/glob/上下文行数过滤 |
| 9 | `glob` | `GlobTool` | 按 glob 模式查找文件，按修改时间排序（最新优先）。尊重 .gitignore |
| 10 | `list_directory` | `LSTool` | 列出目录内容。支持忽略模式及 .gitignore/.geminiignore 过滤 |

**精简建议**：三者职责清晰正交，保留。

### 💻 Shell 与系统（2 个）

| # | 工具名 | 类 | 功能简介 |
|---|---|---|---|
| 11 | `run_shell_command` | `ShellTool` | 执行 bash 命令。支持进程组追踪、后台任务(Ctrl+B)、5min超时、危险命令检测、Windows编码自适应 |
| 12 | `local_time` | `LocalTimeTool` | 获取当前本地时间（IANA 时区，ISO/unix/星期几等格式）。纯函数无 IO |

**精简建议**：两者功能正交，保留。

### 🌐 网络与搜索（3 个）

| # | 工具名 | 类 | 功能简介 |
|---|---|---|---|
| 13 | `web_fetch` | `WebFetchTool` | 通过 Gemini 处理 URL 内容（最多 20 个）。自动 GitHub blob→raw 转换，私有 IP 处理 |
| 14 | `google_web_search` | `WebSearchTool` | 通过 Gemini + Google Search 联网搜索，返回带引用的结果。30s 超时 |
| 15 | `codesearch` | `CodeSearchTool` | 通过 Exa.ai MCP 服务搜索 API/库/SDK 代码上下文 |

**精简建议**：三者各有分工。`codesearch` 使用频率相对低（依赖 Exa.ai 外部服务），可考虑移至可选/按需加载。

### 🤖 Agent 与委托（4 个）

| # | 工具名 | 类 | 功能简介 |
|---|---|---|---|
| 16 | `task` | `TaskTool` | 启动代码分析子 Agent（独立工具集），支持实时流式 UI，30min 超时 |
| 17 | `delegate_to_agent` | `DelegateToAgentTool` | 委托任务给外部 Agent（Claude Code / Codex）via ACP。支持流式/后台两种模式 |
| 18 | `check_delegate_status` | `CheckDelegateStatusTool` | 查询后台委托 Agent 的任务状态（运行中/完成/失败/取消） |
| 19 | `workflow` | `WorkflowTool` | 执行 JS 编排脚本，协调多个子 Agent 串/并行工作。VM 沙箱隔离 |

**精简建议**：
- `check_delegate_status` 功能单一（只查状态），可与 `delegate_to_agent` 合并成一个工具（加 `action` 参数区分委托 vs 查状态）。
- `workflow` 仅在 CLI 模式可用（VSCode 排除），使用门槛较高。

### 🧠 记忆与目标管理（2 个）

| # | 工具名 | 类 | 功能简介 |
|---|---|---|---|
| 20 | `save_memory` | `MemoryTool` | 保存长时记忆（写入 DEEPV.md / AGENTS.md / .cursor/rules） |
| 21 | `goal_achieved` | `GoalAchievedTool` | 声明 `/goal` 模式任务完成。经独立评估器验证后释放上下文（**动态注册，仅 goal 模式**） |

**精简建议**：两者用途独立，保留。

### 🎯 技能系统（4 个）

| # | 工具名 | 类 | 功能简介 |
|---|---|---|---|
| 22 | `use_skill` | `UseSkillTool` | 激活技能（加载 SKILL.md）。对有脚本的技能显示可用命令 |
| 23 | `list_available_skills` | `ListSkillsTool` | 列出所有已安装和启用的技能，按插件分组 |
| 24 | `get_skill_details` | `GetSkillDetailsTool` | 获取单个技能的详细信息（路径、文档、用法） |
| 25 | `skill_hub` | `SkillHubTool` | 从 custom-skills 仓库搜索/安装/列出技能（51+ 精选技能） |

**精简建议**：四个技能工具的职责可合并：
- **建议合并方案**：`use_skill` + `list_available_skills` + `get_skill_details` → 合并为一个 `skill` 工具，用 `action` 参数区分（`use`/`list`/`details`/`hub`）。
- `skill_hub` 功能较独立（联网安装），可保留或并入上述统一工具。

### 💬 通信与飞书（2 个）

| # | 工具名 | 类 | 功能简介 |
|---|---|---|---|
| 26 | `ask_user_question` | `AskUserQuestionTool` | 向用户发起多选题对话框。支持预览、多选、自动追加"其他"（CLI 模式，VSCode 排除） |
| 27 | `lark_cli` | `LarkCliTool` | 统一封装官方 lark-cli 工具，覆盖 18+ 业务域。自动设备流登录 |

**精简建议**：`lark_cli` 体量较大但功能全面。保留。

### 📋 Todo 与 Lint 管理（3 个）

| # | 工具名 | 类 | 功能简介 |
|---|---|---|---|
| 28 | `todo_write` | `TodoWriteTool` | 管理待办列表。响应式 store 实时更新 UI |
| 29 | `read_lints` | `ReadLintsTool` | 读取工作区 lint 诊断结果（VSCode 回调）。按文件分组、严重度排序（**仅 VSCode 插件模式**） |
| 30 | `lint_fix` | `LintFixTool` | 自动修复 lint 错误，支持预览和选择性修复 |

**精简建议**：`read_lints` + `lint_fix` 可合并为一个 `lint` 工具（`action: "read" | "fix"`）。注意 `read_lints` 仅 VSCode 模式注册。

### 🎨 多媒体（3 个）

| # | 工具名 | 类 | 功能简介 |
|---|---|---|---|
| 31 | `image_reader` | `ImageReaderTool` | 纯文本模型的图片回退工具。调用 Gemini Flash 描述图片内容 |
| 32 | `audio_reader` | `AudioReaderTool` | 纯文本模型的音频回退工具。调用 Gemini Flash 转录音频（**飞书动态注册**） |
| 33 | `ppt_outline` | `PptOutlineTool` | 管理 PPT 大纲（创建/更新/查看/清除），与用户协作编辑 |

**精简建议**：`ppt_outline` + `ppt_generate` 可合并为一个 `ppt` 工具，用 `action: "outline" | "generate"` 区分。

### 📊 PPT 生成（1 个）

| # | 工具名 | 类 | 功能简介 |
|---|---|---|---|
| 34 | `ppt_generate` | `PptGenerateTool` | 提交 PPT 大纲并启动生成（外部 API） |

见上条精简建议。

### 🖼️ 图片生成（1 个 — 飞书动态注册）

| # | 工具名 | 类 | 功能简介 |
|---|---|---|---|
| 35 | `nanobanana_generate` | `NanobananaGenerateTool` | 通过 NanoBanana 服务生成 AI 图片。支持比例/分辨率选择（**飞书动态注册**） |

### 📎 飞书文件发送（1 个 — 飞书动态注册）

| # | 工具名 | 类 | 功能简介 |
|---|---|---|---|
| 36 | `send_feishu_file` | `SendFeishuFileTool` | 发送本地文件到当前飞书会话。50 MiB 上限（**飞书动态注册**） |

### 🏗️ 项目建群（1 个 — 飞书动态注册）

| # | 工具名 | 类 | 功能简介 |
|---|---|---|---|
| 37 | `create_project_and_group_chat` | `CreateProjectAndGroupChatTool` | 一键创建本地项目目录 + 飞书群聊 + 工作区绑定（**飞书动态注册**） |

### 🛠️ 批量与更新（3 个）

| # | 工具名 | 类 | 功能简介 |
|---|---|---|---|
| 38 | `lsp` | `LspTool` | 统一 Language Server Protocol 操作（跳转定义/查找引用/Hover/文档符号等） |
| 39 | `batch` | `BatchTool` | 顺序执行多个独立工具调用（最多 20 个）。自动修复 LLM JSON 序列化错误 |
| 40 | `self_update` | `SelfUpdateTool` | 更新并重启 Easy Code（飞书模式）。支持 npm/local 源（**飞书动态注册**） |

---

## 三、按运行模式实际可用工具数

| 模式 | 可用数 | 说明 |
|---|---|---|
| **CLI 普通模式** | 31 | 排除 `ReadLintsTool`(VSCode-only) + 5 个飞书动态工具 + `GoalAchievedTool` |
| **CLI 飞书模式** | 36 | 上述 31 个 + `AudioReader` + `SelfUpdate` + `Nanobanana` + `SendFeishuFile` + `CreateProjectGroup` |
| **CLI Goal 模式** | 32 | 普通模式 + `GoalAchievedTool`（动态注册） |
| **VSCode 插件模式** | 31 | 排除 `AskUserQuestionTool` + `WorkflowTool`(CLI-only) |

---

## 四、精简建议汇总

### 🔴 高优先级精简

| 建议 | 涉及工具 | 理由 |
|---|---|---|
| **合并 4 个技能工具 → 1 个** | `use_skill` `list_available_skills` `get_skill_details` `skill_hub` | 职责高度重叠，`action` 参数可统一入口 |
| **合并 2 个 PPT 工具 → 1 个** | `ppt_outline` `ppt_generate` | 同一业务领域，`action` 区分即可 |
| **合并 `read_lints` + `lint_fix` → 1 个** | `read_lints` `lint_fix` | 同一 lint 领域，`action` 参数区分 |

### 🟡 中优先级精简

| 建议 | 涉及工具 | 理由 |
|---|---|---|
| **合并 `delegate_to_agent` + `check_delegate_status`** | `delegate_to_agent` `check_delegate_status` | 查状态是委托的子功能，可并入同一工具 |
| **考虑移除 `patch`** | `patch` | 使用频率低，同功能已被 `replace`/`multiedit` 覆盖 |
| **考虑将 `codesearch` 设为可选加载** | `codesearch` | 依赖外部 Exa.ai 服务，非核心场景 |

### 🟢 低优先级 / 保留

- 文件读写工具（`read_file` / `read_many_files` / `write_file` / `replace` / `multiedit` / `delete_file`）— 核心工作流，保留
- 搜索导航工具（`search_file_content` / `glob` / `list_directory`）— 职责正交，保留
- Shell / 时间工具 — 保留
- 网络工具（`web_fetch` / `google_web_search`）— 保留
- Agent 工具（`task` / `workflow`）— 保留，使用场景不同
- 记忆/目标工具（`save_memory` / `goal_achieved`）— 保留
- 通信工具（`ask_user_question` / `lark_cli`）— 保留
- 飞书动态工具 — 仅飞书模式加载，无精简必要
- `batch` / `lsp` — 功能独立，保留

---

## 五、完整工具列表（按文件名索引）

| 文件名 | 工具名 | 类名 | 注册来源 |
|---|---|---|---|
| `tools/ls.ts` | `list_directory` | `LSTool` | Core |
| `tools/read-file.ts` | `read_file` | `ReadFileTool` | Core |
| `tools/read-many-files.ts` | `read_many_files` | `ReadManyFilesTool` | Core |
| `tools/grep.ts` | `search_file_content` | `GrepTool` | Core |
| `tools/glob.ts` | `glob` | `GlobTool` | Core |
| `tools/edit.ts` | `replace` | `EditTool` | Core |
| `tools/write-file.ts` | `write_file` | `WriteFileTool` | Core |
| `tools/multiedit.ts` | `multiedit` | `MultiEditTool` | Core |
| `tools/patch.ts` | `patch` | `PatchTool` | Core |
| `tools/delete-file.ts` | `delete_file` | `DeleteFileTool` | Core |
| `tools/shell.ts` | `run_shell_command` | `ShellTool` | Core |
| `tools/local-time.ts` | `local_time` | `LocalTimeTool` | Core |
| `tools/web-fetch.ts` | `web_fetch` | `WebFetchTool` | Core |
| `tools/web-search.ts` | `google_web_search` | `WebSearchTool` | Core |
| `tools/codesearch.ts` | `codesearch` | `CodeSearchTool` | Core |
| `tools/task.ts` | `task` | `TaskTool` | Core |
| `tools/delegate-agent.ts` | `delegate_to_agent` | `DelegateToAgentTool` | Core |
| `tools/delegate-status.ts` | `check_delegate_status` | `CheckDelegateStatusTool` | Core |
| `tools/workflow.ts` | `workflow` | `WorkflowTool` | Core (CLI only) |
| `tools/memoryTool.ts` | `save_memory` | `MemoryTool` | Core |
| `tools/goal-achieved.ts` | `goal_achieved` | `GoalAchievedTool` | 动态 (Goal mode) |
| `tools/use-skill.ts` | `use_skill` | `UseSkillTool` | Core |
| `tools/list-skills.ts` | `list_available_skills` | `ListSkillsTool` | Core |
| `tools/get-skill-details.ts` | `get_skill_details` | `GetSkillDetailsTool` | Core |
| `tools/skill-hub.ts` | `skill_hub` | `SkillHubTool` | Core |
| `tools/ask-user-question.ts` | `ask_user_question` | `AskUserQuestionTool` | Core (CLI only) |
| `tools/lark-cli.ts` | `lark_cli` | `LarkCliTool` | Core |
| `tools/todo-write.ts` | `todo_write` | `TodoWriteTool` | Core |
| `tools/read-lints.ts` | `read_lints` | `ReadLintsTool` | Core (VSCode only) |
| `tools/lint-fix.ts` | `lint_fix` | `LintFixTool` | Core |
| `tools/image-reader.ts` | `image_reader` | `ImageReaderTool` | Core |
| `tools/ppt/pptOutlineTool.ts` | `ppt_outline` | `PptOutlineTool` | Core |
| `tools/ppt/pptGenerateTool.ts` | `ppt_generate` | `PptGenerateTool` | Core |
| `tools/lsp.ts` | `lsp` | `LspTool` | Core |
| `tools/batch.ts` | `batch` | `BatchTool` | Core |
| `tools/audio-reader.ts` | `audio_reader` | `AudioReaderTool` | 动态 (Feishu) |
| `tools/self-update.ts` | `self_update` | `SelfUpdateTool` | 动态 (Feishu) |
| `tools/nanobanana-generate.ts` | `nanobanana_generate` | `NanobananaGenerateTool` | 动态 (Feishu) |
| `cli/.../feishu-send-file-tool.ts` | `send_feishu_file` | `SendFeishuFileTool` | 动态 (Feishu) |
| `cli/.../createProjectGroupTool.ts` | `create_project_and_group_chat` | `CreateProjectAndGroupChatTool` | 动态 (Feishu) |

> **注**：MCP 发现的工具（`DiscoveredMCPTool`）不属于内置工具，由外部 MCP 服务器按需提供，未列入此目录。
