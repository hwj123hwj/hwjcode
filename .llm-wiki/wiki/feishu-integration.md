---
type: entity
date: 2026-05-30
tags: [feishu, lark, gateway, bot-integration, services]
sources: [packages/cli/src/services/feishu/gateway.ts, packages/cli/src/ui/commands/feishuCommand.ts, packages/cli/src/services/feishu/credentials.ts]
---

# Feishu / Lark Bot Integration

DeepV Code features a robust Feishu (Lark) Workspace Bot integration, turning the CLI agent into a conversational workspace assistant that can interact with the Feishu Open Platform.

## Architecture & Communication

Traditional webhooks require public endpoints and SSL certificates, which is highly impractical for local development or CLI execution behind corporate NATs. DeepV Code solves this using a **WebSocket Long-Connection (WS) Gateway**:

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

- **Storage Location**: `~/.deepv/feishu-credentials.json` (Global, not project-specific).
- **Encryption Scheme**: Encrypted using **AES-256-GCM** with standard authenticity validation.
- **Key Storage**: Symmetric key stored separately in `~/.deepv/feishu-key`.
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

## Related Pages
- [[lark-cli-tool]]
- [[tools-system]]
- [[cli-module]]
