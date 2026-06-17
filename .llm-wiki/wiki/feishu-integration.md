---
type: entity
date: 2026-06-05
tags: [feishu, lark, gateway, bot-integration, services]
sources: [packages/cli/src/services/feishu/gateway.ts, packages/cli/src/ui/commands/feishuCommand.ts, packages/cli/src/services/feishu/credentials.ts]
---

# Feishu / Lark Bot Integration

Easy Code features a robust Feishu (Lark) Workspace Bot integration, turning the CLI agent into a conversational workspace assistant that can interact with the Feishu Open Platform.

## Architecture & Communication

Traditional webhooks require public endpoints and SSL certificates, which is highly impractical for local development or CLI execution behind corporate NATs. Easy Code solves this using a **WebSocket Long-Connection (WS) Gateway**:

```
Feishu Platform ←(WebSocket / Protobuf)→ WSClient (via @larksuiteoapi/node-sdk)
  ↑                                         ↓
Sends Events (Messages, Clicks)             FeishuGateway.ts (Dispatches events)
                                            ↓
                                        Triggers Sub-Agent (GeminiClient)
                                        & executes requested commands/tools
```

### Key Components

1. **`FeishuGateway` (`packages/cli/src/services/feishu/gateway.ts`)**:
   - Manages the socket connection lifecycle.
   - Connects by resolving dynamic WebSocket URLs through `pullConnectConfig` (`POST /callback/ws/endpoint`).
   - Dispatches incoming messages, media files (audio/video), and cards trigger actions (`card.action.trigger`) to the internal LLM.
2. **`feishuCommand.ts` (`packages/cli/src/ui/commands/feishuCommand.ts`)**:
   - Implements the `/feishu` CLI slash command.
   - Orchestrates setup (interactive QR code or manual input), connection monitoring, and terminal dashboards.

## Credentials & Cryptography

To protect sensitive corporate App Secrets, credentials are encrypted on disk:

- **Storage Location**: `~/.easycode-user/feishu-credentials.json` (Global, not project-specific).
- **Encryption Scheme**: Encrypted using **AES-256-GCM** with standard authenticity validation.
- **Key Storage**: Symmetric key stored separately in `~/.easycode-user/feishu-key`.
- **System Permissions**: Both files are written using strictly **0o600 permissions** (owner read/write only) on POSIX-compliant systems.
- **Backward Compatibility**: Decrypts legacy, unvalidated AES-256-CBC credentials, automatically upgrading them to GCM format on save.

## Sub-commands Reference

| Sub-command | Purpose |
|-------------|---------|
| `/feishu` | Interactive entrance (launches step-by-step QR setup). |
| `/feishu setup` | Explicitly configures App ID, Secret, and Domain (Feishu/Lark). |
| `/feishu start` | Boots up the long-connection WebSocket client in the background. |
| `/feishu stop` | Gracefully closes WebSocket connections and unsubscribes from events. |
| `/feishu status` | Displays detailed connection state, bound workspaces, scope audits, and bot name. |
| `/feishu logout` | Wipes credential and key files from the user directory. |

## Advanced Integration Capabilities

### 🎙️ Inbound Audio, Media & File Intake
When users send voice notes, video files, or document attachments in private chats or groups, the gateway automatically:
1. Downloads the media stream via Feishu Resource API.
2. Formats audio into `.opus` or standard files.
3. Automatically detects content structures and feeds them directly into the agent's prompt context.

### 🛡️ Secure File Upload Sandboxing
The `SendFeishuFileTool` (`feishu-send-file-tool.ts`) exposes file uploads to the AI, allowing it to send local project files back to the chat. It enforces strict security boundaries:
- Rejects any requests pointing to paths outside the project root (`isWithinRoot` verification).
- Requires explicit user confirmation in the CLI workspace before shipping files.

### ⚡ Live Output Streaming & Fallbacks
- Executes `lark-cli` operations directly, capturing dynamic outputs.
- Gracefully handles browser flow login and permission approvals asynchronously, updating status cards in real-time.

### 🔒 Security, Logging & UI Layout Protections
To guarantee a clean TUI (terminal) display and protect sensitive corporate prompt secrets, the Feishu integration uses two critical safeguards:
1. **Safe Logging Truncation (`safeTruncateForLog`)**:
   - Logging full user messages or compiled system instructions directly to `process.stderr` (e.g. `[Feishu Debug] Raw messageText from Feishu`) would leak private system prompts (especially the compiled `/goal` mode contract containing hundreds of lines of constraints) and completely clutter/corrupt the terminal's React-Ink layout.
   - All inbound and paths-reconstructed message text logged in the terminal is automatically sanitized using `safeTruncateForLog`. It converts all newlines into single spaces (preventing multi-line spill-over) and truncates text to 150 characters with a total character suffix (e.g. `... (truncated, total 12053 chars)`).
2. **Tool Card Display Clamping (`clampCodeBlock`)**:
   - Standard Feishu cards have strict character limits. A single massive tool block output (like a large file write or a lengthy bash stdout) can exceed Feishu's limits, causing card failures or unwanted pagination.
   - Large tool blocks are parsed and clamped via `clampCodeBlock` using a dual-constraint model (lines + characters), preserving readability while guaranteeing layout compliance on all screens.

## 自然语言命令映射 (NL Command Mapping)

飞书支持将用户的自然语言输入自动映射为对应 slash 命令，无需输入 `/` 前缀。处理顺序在斜杠命令检测之后、发给 AI 之前。

### 模型切换
用户说 `切换到 deepseek` / `用 glm` / `换 claude` 等 → 自动改写为 `/model <name>`。支持 13 种触发词和 6 层匹配（精确名→显示名→关键词交集→厂商别名），仅匹配收藏模型。

> **飞书端 `/model favorites` 子命令**（1.1.30 新增）：支持 `/model favorites add/remove/list`，与 CLI 端 `modelCommand.ts` 对齐。此前飞书端 `/model` 是独立实现，缺少 favorites 子命令，输入 `/model favorites add xxx` 会被当成模型名查找而报错。详见 [[source-feishu-model-favorites]]。

### 命令分发
| 自然语言示例 | 映射命令 |
|---|---|
| `新对话` `清空对话` `重新开始` | `/new` |
| `压缩上下文` `精简对话` `总结对话` | `/compress` |
| `更新知识库` `整理知识库` | `/wiki ingest .` |

### 工具开关
| 自然语言 | 等效命令 |
|---|---|
| `开启生图` `关闭生图` | `/tool enable/disable nanobanana_generate` |
| `开启音频` `关闭音频` | `/tool enable/disable audio_reader` |

详见 [[nl-command-dispatch]]。

## Related Pages
- [[nl-command-dispatch]]
- [[lark-cli-tool]]
- [[tools-system]]
- [[cli-module]]
