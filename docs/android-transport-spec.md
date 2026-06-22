# Android Transport 层规格文档

> 来源：`dvcode-deepvlab-ai-web/src/pages/Remote/hooks/useCloudWebSocket.ts` +
> `dvcode-deepvlab-ai-web/src/pages/Remote/types/protocol.ts`
> 用途：供 Android 端 1:1 对表实现远程会话 transport 层（方案A）。
> 本文只描述 **传输/编排协议**，不含 UI。所有字段名、大小写、方向均以 Web 端实现为准。

---

## 0. 架构总览

```
┌────────────┐   外层: Relay 编排协议        ┌──────────────┐   内层: RemoteProtocol     ┌──────────┐
│ Android端  │ ───  WebSocket /ws/web   ───▶ │  云端 Relay   │ ─── 按 session 占用路由 ──▶ │ 本地 CLI │
│ (Web 对位) │ ◀──  JSON 消息（双向）    ──── │   Server     │ ◀── FORWARDED_FROM_CLI ──── │ (easycode)│
└────────────┘                               └──────────────┘                            └──────────┘
```

- **外层（Relay 编排层）**：客户端 ↔ Relay Server。负责鉴权、查资源、选机器(CLI)、占/放会话(session)、心跳、CLI 状态通知。
- **内层（RemoteProtocol）**：客户端 ↔ 选中的 CLI，**经 Relay 透传**。负责真正的对话（command / output / 工具调用 / 思考 / 历史恢复）。
- **关键事实**（已用服务端源码核实，见 §8）：内层消息**透明转发、顶层直达**——
  - Relay 的 `forwardCLIToWeb` 删除内部 `_cloudRoute` 字段后，把 CLI 原始消息**原样顶层下发** `{type,payload,...}`（如 `output`/`OUTPUT`、`status`、`tool_call`、`*_RESPONSE`）。
  - ⚠️ **`FORWARDED_FROM_CLI` 本服务端永不下发**：客户端的 `handleForwardedCLIMessage`（`OUTPUT_LINE`/`TOOL_CALL_STATUS`/`SESSION_LIST` 包裹形态）是遗留死代码。**Android 只实现顶层直达即可**，包裹路径可不做（或仅作向后兼容预留）。
  - 对同一语义的大小写变体（`output` 与 `OUTPUT`）仍建议一律等价处理（CLI 端历史上两种都出现过）。

### 统一消息信封

所有消息（内外层）共享信封：

```jsonc
{
  "type": "string",        // 消息类型（见清单）
  "payload": { ... },      // 载荷，可能为 {} 或缺省
  "id": "msg_<ts>_<rand>", // 客户端发出的消息唯一 ID（部分入站消息也带）
  "timestamp": 1690000000  // 毫秒时间戳
}
```

- `id` 生成规则：`` `msg_${Date.now()}_${Math.random().toString(16).slice(2)}` ``（或 `occupy_*`/`ui_*` 前缀变体，仅用于日志区分，服务端不依赖前缀）。
- 鉴权通过 **URL query 参数** 完成，不走消息体（见 §1）。

---

## 1. 连接与鉴权

| 项 | 值 |
|----|----|
| 端点 | `<cloudServerUrl>` 的 `http(s)` 替换为 `ws(s)`，路径 `/ws/web` |
| URL 构造 | `new URL('/ws/web', cloudServerUrl.replace(/^http/, 'ws'))` |
| 鉴权 | query 参数 `token=<userToken>`（如 `wss://host/ws/web?token=xxx`） |
| 协议 | 纯文本 JSON，每帧一条消息（`JSON.parse(event.data)`） |

- **没有独立的鉴权握手消息**：`protocol.ts` 里定义了 `AUTH_REQUIRED/AUTH_SUBMIT/AUTH_SUCCESS/AUTH_FAILED`，但 `useCloudWebSocket` **未使用**。当前实现鉴权 100% 靠 URL token。
  - `WebSocketState.needsAuthentication/isAuthenticated/authError` 字段保留但当前无写入路径。
  - Android 端：实现 token-in-query 即可；可预留 AUTH_* 消息位以兼容未来服务端。
- 连接建立成功（`ws.onopen`）**不立即查资源**，必须等待服务端下发 `WEB_CONNECT_SUCCESS` 后再 `QUERY_USER_RESOURCES`。

---

## 2. 消息清单

### 2.1 外层（Relay 编排协议）

#### 客户端 → Server（出站）

| 类型 | payload | 用途 |
|------|---------|------|
| `QUERY_USER_RESOURCES` | `{ includeOfflineCLIs?: bool=false, includeEmptySessions?: bool=true }` | 查询当前用户名下所有 CLI 机器及其 session 资源 |
| `SELECT_CLI` | `{ cliId: string }` | 选定一台 CLI 机器作为后续会话目标 |
| `OCCUPY_SESSION` | `{ sessionId: string, cliId: string }` | 占用（加锁）指定 CLI 上的某个 session |
| `RELEASE_SESSION` | `{}` | 释放当前占用的 session |
| `PING` | `{}`（无 payload） | 心跳（30s 周期，仅页面可见时发） |

> 注：`CREATE_SESSION` / `CLEAR_SESSION` / `REQUEST_UI_STATE` / `COMMAND` / `INTERRUPT` 虽由客户端发往 Relay，但语义上属**内层**（针对已占用的 CLi/session），见 §2.2。

#### Server → 客户端（入站）

| 类型 | payload | 用途 |
|------|---------|------|
| `WEB_CONNECT_SUCCESS` | `{ message?: string }` | 连接确认；收到后才可查资源/触发重连恢复 |
| `USER_RESOURCES_RESPONSE` | `UserResourcesResponse`（见 §3） | 返回用户的 CLI 列表与 session 资源 |
| `SELECT_CLI_RESPONSE` | `{ success: bool, cliId: string }` | 选 CLI 结果 |
| `OCCUPY_SESSION_RESPONSE` | `{ success: bool, sessionId, cliId, reason: OccupyReason, error?: string }` | 占用 session 结果（**核心锁响应**）。`reason` ∈ `OK`/`TAKEOVER`/`ALREADY_SELF`/`OCCUPIED_BY_OTHERS`/`NO_ACCESS`/`WEB_NOT_FOUND`/`ERROR`（见 §8.6 服务端已实现） |
| `RELEASE_SESSION_RESPONSE` | `{ success?: bool, ... }` | 释放 session 结果（客户端收到后回到选 CLI 态并重查资源） |
| `CLI_STATUS_NOTIFICATION` | `{ cliId: string, status: 'online'\|'offline' }` | 某 CLI 上/下线主动推送 |
| ~~`FORWARDED_FROM_CLI`~~ | — | ⚠️ **本服务端不下发**（遗留）。CLI 消息以顶层原始形态透传，见 §2.2 / §8 |
| `ERROR` | `{ error: string }` | Relay 层错误 |
| `PONG` | `{}` | 心跳响应（刷新 `lastActivity`） |

### 2.2 内层（RemoteProtocol，经 Relay 透传到/自 CLI）

类型常量定义见 `protocol.ts` 的 `MessageType`（值为小写串）。实际线上同时出现**小写**（CLI 原生）和**大写**（部分转发/兼容）两种 type，Android 需大小写都接。

#### 客户端 → CLI（出站，针对已占用 session）

| 类型 | payload | 用途 |
|------|---------|------|
| `COMMAND` | `{ command: string, workdir?: string }` | 发送一条用户指令（聊天输入） |
| `INTERRUPT` | `{}` | 中断当前执行（Ctrl+C 语义） |
| `CREATE_SESSION` | `{}` | 在选定 CLI 上新建 session |
| `CLEAR_SESSION` | `{}` | 清空当前 session 的历史/上下文 |
| `REQUEST_UI_STATE` | `{}` | 请求拉取已完成历史记录（占用成功 / 重连后调用） |
| `SELECT_SESSION` | `{ sessionId?: string }` | 协议中定义；本实现用 `OCCUPY_SESSION` 取代（`selectSession = occupySession`）。Android 用 OCCUPY 即可 |

#### CLI → 客户端（入站；可顶层直达或被 `FORWARDED_FROM_CLI` 包裹）

| 类型（大小写均可能） | payload | 用途 |
|------|---------|------|
| `output` / `OUTPUT` | `{ content: string, stream: 'stdout'\|'stderr', isComplete: bool }` | 流式输出片段。`stdout` 按 `currentResponseId` 聚合为同一回复行；`stderr` 独立成行并打断聚合 |
| `error` | `{ error: string, code?: number }` | CLI 运行期错误（成行展示） |
| `status` / `STATUS` | `{ status: 'idle'\|'running'\|'error'\|'processing', message?: string }` | 执行状态；`running`/`processing` ⇒ `isProcessing=true`；状态变更会**截断**流式聚合 ID |
| `tool_call` / `TOOL_CALL` | `{ callId, toolName, toolDescription?, args, result?, success, error?, duration? }` | 一次工具调用（含结果）。到达即重置流式聚合 ID |
| `tool_status` / `TOOL_STATUS` | `{ callId, toolName, status: 'starting'\|'running'\|'completed'\|'error', message?, progress?{current,total,description?} }` | 工具执行状态：`starting` 入列/更新，`completed` 出列 |
| `thought` / `THOUGHT` | `{ thoughtId, subject, description }` | 思考事件（Gemini 风格离散）。按 `thoughtId` 聚合 |
| `reasoning_chunk` / `REASONING_CHUNK` | `{ thoughtId, text, isComplete }` | 思考增量（OpenAI/Claude/DeepSeek 风格）。按 `thoughtId` 累加 `text`，`isComplete` 标记完成 |
| `ui_state_response` / `UI_STATE_RESPONSE` | `{ completedRecords: Record[], currentRecord: any\|null, isProcessing: bool }` | 历史恢复响应（见 §3 记录解析） |
| `create_session_response` / `CREATE_SESSION_RESPONSE` | `{ success: bool, sessionId?: string, error?: string }` | 新建 session 结果；成功后客户端**自动 OCCUPY** 该 session |
| `clear_session_response` / `CLEAR_SESSION_RESPONSE` | `{ success: bool, sessionId?: string, error?: string }` | 清空 session 结果；成功后清空本地 UI 数据 |

#### 遗留：`handleForwardedCLIMessage` 内的旧版类型（⚠️ 本服务端不触发）

下列类型仅存在于客户端的 `FORWARDED_FROM_CLI` 包裹分支。经服务端源码核实（§8），当前 Relay 不下发 `FORWARDED_FROM_CLI`，故**这些路径在生产中不会走到**。Android 可不实现；仅在未来服务端引入包裹转发时作兼容预留。

| 类型 | payload | 用途（遗留语义） |
|------|---------|------|
| `STATUS` | — | 状态（空处理） |
| `OUTPUT_LINE` | `{ content, type, ... }` | 整行输出 |
| `TOOL_CALL_STATUS` | `{ toolCallId, status: 'running'\|'completed'\|'failed', ... }` | 工具调用状态 |
| `SESSION_LIST` | `{ sessions: SessionInfo[] }` | 可用 session 列表 |
| `UI_STATE_RESPONSE` | 同上 | 历史恢复（包裹形态） |

---

## 3. 关键数据结构

### UserResourcesResponse（`USER_RESOURCES_RESPONSE.payload`）

```jsonc
{
  "userId": "string",
  "totalCLIs": 0, "onlineCLIs": 0,
  "totalSessions": 0, "occupiedSessions": 0,
  "clis": [ CLIInstance ]
}
```

### CLIInstance

```jsonc
{
  "cliId": "string",
  "status": "online" | "offline",
  "metadata": { "platform", "hostname", "workingDir", "nodeVersion" },
  "connectionInfo": { "connectedAt", "lastHeartbeat", "uptime" },
  "sessions": [ SessionResourceInfo ],
  "sessionSummary": { "total", "occupied", "processing", "idle" }
}
```

### SessionResourceInfo（**含锁状态**）

```jsonc
{
  "sessionId": "string",
  "status": "available" | "occupied_by_self" | "occupied_by_others" | "processing",
  "sessionInfo": {
    "createdAt", "lastActiveAt",
    "messageCount?", "firstUserInput?", "lastUserInput?", "isProcessing?"
  },
  "occupancy": {                 // 可选，仅被占用时存在
    "occupiedBy": "self" | "others",
    "occupiedAt": 0,
    "webId": "string"            // 占用者的连接标识
  }
}
```

- 选 CLI 后，客户端**仅把 `available` 与 `occupied_by_self` 的 session** 列入可选列表（`occupied_by_others` 不可选）。

### UI_STATE_RESPONSE 历史记录解析（`completedRecords[]`）

每条 `record`：`{ id, type, content, timestamp }`，按 `type` 分流：

| `record.type` | 解析为 | content 形态 |
|---------------|--------|-------------|
| `user_input` | 用户消息 | string |
| `ai_response` | 输出行（stdout） | string |
| `tool_call` | 工具调用 | object `{ callId, toolName, toolDescription?, args, result?, success, error?, duration? }` |
| 其它/未知 | 兜底为 stdout 输出行 | `content.toString()` 或 `JSON.stringify` |

- 恢复时清空进行中的 `toolStatuses`；用 `payload.isProcessing` 设置 `isProcessing` 与状态文案。

---

## 4. 连接状态机

```
        connectToCloud(url, token)
              │  (isConnecting 去重)
              ▼
       ┌─────────────┐  ws.onerror / 创建失败
       │ CONNECTING  │ ─────────────────────────────┐
       └─────┬───────┘                              │
             │ ws.onopen                            ▼
             ▼                                ┌──────────────┐
       ┌─────────────┐                        │ DISCONNECTED │◀───┐
       │ CONNECTED   │  启动心跳/请求WakeLock  └──────┬───────┘    │
       │ (await WCS) │                               │            │
       └─────┬───────┘                               │ ws.onclose │
             │ ◀── WEB_CONNECT_SUCCESS               │ (非1000)   │
             │                                        ▼            │
             │   ┌── wasInChatMode? ──是──▶ [重连恢复分支] ───────┤
             │   │                          re-SELECT_CLI         │
             │   否                         →re-OCCUPY_SESSION    │
             ▼   ▼                          →REQUEST_UI_STATE     │
       QUERY_USER_RESOURCES                                       │
             │                                                    │
             ▼ ◀── USER_RESOURCES_RESPONSE                        │
       ┌──────────────┐                                          │
       │ CLI_SELECTION │  needsCLISelection=true                  │
       └──────┬────────┘                                          │
              │ selectCLI(cliId) → SELECT_CLI                     │
              ▼ ◀── SELECT_CLI_RESPONSE                           │
       ┌──────────────────┐                                       │
       │ SESSION_SELECTION │ needsSessionSelection=true           │
       └──────┬───────────┘                                       │
              │                                                    │
     ┌────────┴─────────┐                                         │
     │                  │                                         │
 occupySession      createSession → CREATE_SESSION                │
 (existing)              │ ◀── CREATE_SESSION_RESPONSE(success)   │
     │                   │   自动 OCCUPY_SESSION                  │
     └─────────┬─────────┘                                        │
               ▼  OCCUPY_SESSION                                  │
       ┌───────────────┐                                          │
       │  OCCUPYING     │  await OCCUPY_SESSION_RESPONSE           │
       └──────┬────────┘                                          │
              │ success                                           │
              ▼  requestUIState → REQUEST_UI_STATE                │
       ┌──────────────────┐                                       │
       │ LOADING_HISTORY   │ isLoadingHistory=true                │
       └──────┬───────────┘                                       │
              │ ◀── UI_STATE_RESPONSE                             │
              ▼                                                    │
       ┌──────────────┐  wasInChatMode=true                       │
       │    CHAT       │ ◀──────────────┐                         │
       │ idle/processing│                │ COMMAND/INTERRUPT/      │
       └──┬────────┬───┘                │ output/tool_*/status...  │
          │        │ releaseSession      └─────────────────────────┘
          │        ▼ RELEASE_SESSION
          │   ◀── RELEASE_SESSION_RESPONSE → 回到 CLI_SELECTION + 重查资源
          │
          │ ws.onclose (非1000) 且 wasInChatMode
          ▼
       ┌──────────────┐  isReconnecting=true, 2s 倒计时
       │ RECONNECTING  │  scheduleReconnect → connectToCloud
       └──────┬───────┘   (前3次忽略页面可见性；之后页面隐藏则暂停)
              └──────────▶ 回到 CONNECTING（恢复分支）
```

### 状态字段对照（`CloudWebSocketState`）

| 阶段 | 关键标志 |
|------|----------|
| 连接中 | `connectionStatus='connecting'` |
| 已连接 | `connectionStatus='connected', isConnected=true` |
| 选 CLI | `needsCLISelection=true` |
| 选 session | `needsSessionSelection=true, availableSessions=[...]` |
| 占用成功 | `currentSessionId=set, wasInChatMode=true, needsCLISelection=false, needsSessionSelection=false` |
| 拉历史 | `isLoadingHistory=true`（收到 UI_STATE_RESPONSE 置 false） |
| 处理中 | `isProcessing=true, status='processing'` |
| 重连 | `isReconnecting=true, reconnectCountdown=N` |

---

## 5. OCCUPY_SESSION 锁：后台 / 息屏 / 重连策略

### 5.1 锁模型（已用服务端源码核实，见 §8）

- 锁 = 服务端 `PreciseConnectionManager.sessionOccupancy: Map<sessionId, {sessionId, cliId, webId, userId, occupiedAt, lastActivity}>`，**进程内存态、按 `webId` 记账**的会话独占锁。
- 状态投影到 `SessionResourceInfo.status`：`available` / `occupied_by_self` / `occupied_by_others` / `processing`（`processing` 由 CLI 上报的 `isProcessing` 优先覆盖）；归属判定靠 `occupancy.userId === currentUserId`。
- 加锁 = `OCCUPY_SESSION{sessionId,cliId}` → 服务端 `occupySession()` → 回 `OCCUPY_SESSION_RESPONSE{sessionId,cliId,success,error?}`。
- ✅ **支持同用户接管 + 幂等重占**（已实现，§8.6）：`occupySession` 命中已有 occupancy 时——同 webId→幂等成功(`ALREADY_SELF`)；同用户不同 webId→**接管**(`TAKEOVER`，清旧映射后覆盖)；他人→拒绝(`OCCUPIED_BY_OTHERS`)。失败时 error 已按原因细分，亦可直接读 `reason` 字段，**不必再查 USER_RESOURCES**。
  - ⚠️ 行为含义：同一用户的新连接/新设备会**静默接管**自己旧连接占用的 session（远程控制"单活跃会话"语义）；旧连接随后发消息将收到 `'请先占用一个Session'`。
- 占用前置校验：`canUserAccessSession`（CLI 属于该用户 ∧ 该 CLI 的 session 列表含此 sessionId）。占用成功会先 `releaseWebSession(webId)` 清掉该 web 之前占的 session（**一个 web 同时只占 1 个 session**）。
- 解锁触发（任一）：
  1. 客户端主动 `RELEASE_SESSION`（`releaseWebSession`）；
  2. **Web 连接 close/error → `removeWeb(webId)` → `releaseWebSession`**（正常断线即释放）；
  3. 该 CLI 掉线 → `releaseAllCLISessions(cliId)`；
  4. 清理定时器（每 60s）：`occupancy.lastActivity` 超 **30 分钟** → 强制释放。
- ✅ **占用已随转发续期**（已实现，§8.6）：`forwardWebToCLI` 每次转发 COMMAND 等会 `touchSessionOccupancy(sessionId)` 刷新 `lastActivity`，故 30min 空闲清理只回收**真正空闲**的会话，活跃聊天不再被误杀。

### 5.2 心跳与保活（影响锁存活判断）

- 心跳 `PING` **每 30s** 一次，且**仅在页面可见**（`isPageVisibleRef`）时发送；息屏/后台不发心跳。
- ⚠️ 实测校正：**服务端不因缺少 Web PING 而主动关连接或释放锁**。Web 心跳只刷新 `webActivity`；`PING` 仅触发服务端回 `PONG`。锁只在 §5.1 的四个触发点释放。Web 连接清理（10min 无活动）还附带条件 `ws.readyState !== OPEN`——即只清理已死的连接。故只要 TCP 仍 OPEN，锁可一直保留到 30min 占用上限。
- 客户端请求 **Wake Lock**（`wakeLock.request()`）尽量阻止页面被系统挂起，缓解息屏导致的心跳中断。
- 页面重新可见（`visibilitychange`）时：连接在 → 立即补发一次 PING；连接断 → 视隐藏时长触发重连。
- 长时间（>60s）隐藏后获得焦点（`focus`）→ 补发 PING 探活。

### 5.3 重连时的锁重获（核心）

断线（`ws.onclose` code≠1000）且 `wasInChatMode=true` 时：

1. 标记 `isReconnecting`，启动 2s 固定延迟重连（`scheduleReconnect`，最多 `maxReconnectAttempts=10`）。
2. 重连成功 → 收到 `WEB_CONNECT_SUCCESS` → **恢复分支**（仅当 `wasInChatMode && selectedCLI && currentSessionId && !isRestoring`）：
   - `isRestoringRef=true`（防重入）。
   - **延迟 1s** 后 `SELECT_CLI{cliId}`；
   - 再**延迟 0.5s** 后 `OCCUPY_SESSION{sessionId,cliId}` —— **重新抢锁**；
   - 占用成功（`OCCUPY_SESSION_RESPONSE.success`）→ `requestUIState()` 拉回历史；`isRestoring=false`。
3. 占用成功时清重连倒计时、`isReconnecting=false`。

### 5.4 后台 / 息屏决策表

| 场景 | 客户端行为 | 锁影响 |
|------|-----------|--------|
| 页面隐藏（息屏/切后台） | 停发心跳；记录 `pageHiddenTime`；Wake Lock 尽力保活 | 服务端可能因无心跳判超时 → 锁待回收 |
| 隐藏期间断线 | `onclose` 触发；前 3 次重连**忽略**页面可见性，第 4 次起若仍隐藏则**暂停重连** | 锁可能已被服务端释放，待页面可见后重连重抢 |
| 页面恢复可见、连接仍在 | 立即补发 PING | 锁维持 `occupied_by_self` |
| 页面恢复可见、连接已断 | 隐藏 >10s 或正在倒计时 → 取消倒计时，500ms 后重连 | 走 §5.3 重抢锁 |
| 重连重抢、旧 close 已触发 | `removeWeb` 先释放旧锁 → 新 `OCCUPY_SESSION` 成功(`OK`) | 正常恢复 |
| 重连重抢、旧 close 未触发（半开连接）| 旧 occupancy 以旧 webId 在册，但同用户 → 服务端**接管**，新 OCCUPY 成功(`TAKEOVER`) | ✅ **已修复**（§8.6）：不再卡死，无需退避重试 |
| 用户主动离开 | `RELEASE_SESSION` 或 `disconnect()`（close + 清状态） | 锁显式释放 |

### 5.5 Android 端落地要点（基于上面行为）

- **必须实现重连后重抢锁链路**：`SELECT_CLI → OCCUPY_SESSION → REQUEST_UI_STATE`，且要有**防重入**（对应 `isRestoring`）与**顺序/延迟容忍**（Web 用 1s/0.5s/0.2s 经验延迟，Android 可改为「响应驱动」：收到上一步 RESPONSE 再发下一步，更稳）。
- **持久化恢复上下文**：`selectedCLI(cliId)` 与 `currentSessionId` 必须在进程/连接重建后仍可用（Web 存在 React state，Android 应存内存/轻持久化）。
- **后台心跳策略**：Web 在后台停心跳；Android 可借前台服务/WorkManager 维持心跳或采用「重连重抢」兜底。建议两手都要：尽量保活 + 断线幂等重抢。
- **锁冲突处理**：`OCCUPY_SESSION_RESPONSE.success=false` 且 error 恒为 `'Session占用失败'`，**无法据 error 区分**。须先 `QUERY_USER_RESOURCES` 看该 session 是 `occupied_by_others`（提示用户/不可抢）还是 `occupied_by_self`（自占陈旧，旧 close 未到——退避重试，旧 close 触发或 30min 清理后即可重占）。服务端无接管接口。
- **30 分钟占用硬上限**：长会话需周期性自检（如基于 `occupiedAt` 计时或捕获 `'请先占用一个Session'` ERROR），触发后**重新 OCCUPY**。理想是推动服务端在转发 COMMAND 时续期 `occupancy.lastActivity`（见 §8 建议）。
- **只解析顶层直达**：服务端透明转发，无 `FORWARDED_FROM_CLI` 包裹；解析层归一 `type` 大小写即可，不必实现包裹拆包。
- **流式聚合规则**：`output(stdout)` 按当前 responseId 累加；遇到 `status` / `tool_call` / `tool_status` / `stderr` 均**重置聚合 ID**，开新行。
- **CREATE_SESSION 前置**：服务端要求**先 `SELECT_CLI`**（设 `webConn.selectedCLI`）且该 CLI 在线，否则回 ERROR `'请先选择一个CLI'`/`'CLI离线或不可用'`。收到 `CREATE_SESSION_RESPONSE.success` 后自动对新 `sessionId` 发 `OCCUPY_SESSION`，再 `REQUEST_UI_STATE`（Web 200ms；Android 建议响应驱动）。
- **去重**：`CREATE_SESSION_RESPONSE` 可能重复下发，Web 用 `processedCreateSessions` Set 去重；Android 同样要对 sessionId 去重避免重复占用。
- **路由对接透明**：CLI→Web 由服务端按 `sessionId/webId/_cloudRoute` 自动路由，Android 无需处理；但意味着**重占成功后 occupant 才更新为新 webId**，未重占成功前 CLI 回包无法送达。

---

## 6. 时序速查

### 6.1 冷启动到聊天

```
Client                         Relay/CLI
  │── ws open (?token) ────────▶│
  │◀── WEB_CONNECT_SUCCESS ─────│
  │── QUERY_USER_RESOURCES ────▶│
  │◀── USER_RESOURCES_RESPONSE ─│   → 选 CLI 列表
  │── SELECT_CLI ──────────────▶│
  │◀── SELECT_CLI_RESPONSE ─────│   → 选 session 列表
  │── OCCUPY_SESSION ──────────▶│   (或 CREATE_SESSION→RESP→OCCUPY)
  │◀── OCCUPY_SESSION_RESPONSE ─│   success
  │── REQUEST_UI_STATE ────────▶│
  │◀── UI_STATE_RESPONSE ───────│   → 历史渲染, 进入 CHAT
  │── COMMAND ─────────────────▶│
  │◀── thought/reasoning_chunk ─│
  │◀── output (stream)... ──────│
  │◀── tool_status/tool_call ───│
  │◀── status(idle) ────────────│
```

### 6.2 断线重连恢复

```
  ws.onclose(≠1000) & wasInChatMode → isReconnecting, 2s
  │── ws reopen ───────────────▶│
  │◀── WEB_CONNECT_SUCCESS ─────│
  │── (+1.0s) SELECT_CLI ──────▶│
  │── (+0.5s) OCCUPY_SESSION ──▶│   重抢锁
  │◀── OCCUPY_SESSION_RESPONSE ─│
  │── REQUEST_UI_STATE ────────▶│
  │◀── UI_STATE_RESPONSE ───────│   恢复 CHAT
```

### 6.3 心跳

```
  every 30s (page visible only): Client ── PING ──▶  ◀── PONG ── (刷新 lastActivity)
  visibility→visible & connected: 立即补 PING
```

---

## 7. 实现核对清单（Android）

- [ ] WS 端点 `/ws/web?token=`，http→ws / https→wss。
- [ ] 等 `WEB_CONNECT_SUCCESS` 再 `QUERY_USER_RESOURCES`。
- [ ] 外层 5 出站 / 9 入站消息全覆盖（§2.1）。
- [ ] 内层 RemoteProtocol 出站 6 / 入站 11+，大小写归一；**只解析顶层直达**（无需 `FORWARDED_FROM_CLI` 拆包，见 §2.2/§8）。
- [ ] 状态机 8 态 + 重连恢复分支（§4）。
- [ ] OCCUPY 锁：重连重抢链 + 防重入 + 冲突分类（靠 USER_RESOURCES 而非 error 文案）+ 持久化恢复上下文（§5）。
- [ ] **30min 占用硬上限自检 + 重占**（§5.1/§8 已确认服务端不续期）。
- [ ] 心跳 30s（前台/可见才发）+ Wake Lock 等价保活 + 可见性补 PING。
- [ ] CREATE_SESSION 前置 SELECT_CLI → 自动 OCCUPY，sessionId 去重。
- [ ] 流式 stdout 聚合 + 状态/工具/ stderr 截断聚合。
- [ ] UI_STATE_RESPONSE 历史记录三类分流解析（§3）。
- [ ] 重连上限 10 次、固定 2s 退避、前 3 次忽略可见性。

---

## 8. 服务端实测校正与确认

> 依据：`deepx-code-server/src/services/communication/{webSocketService,cloudConnectionManager,cloudMessageRouter}.ts`。
> 本节是对 §1–§7（从 Web 客户端反推）的服务端核对结果，**冲突处以本节为准**。

### 8.1 鉴权与连接（`webSocketService.ts`）
- 端点按路径分流：`/ws/cli`（CLI）与 `/ws/web`（Web）。Web 仅需 `?token=`，经 `authManager.validateAccessToken(token, {ip,ua})` 校验 JWT；失败 `close(4003)`。**确认无 AUTH_* 握手消息**。
- 注册后服务端立即下发 `WEB_CONNECT_SUCCESS { webId, message }`——**实际含 `webId`**（客户端目前未读，Android 可读取留存以便诊断/日志）。
- `ws.on('close')` 与 `ws.on('error')` 都调用 `removeWeb(webId)`（→ 释放该 web 占用的 session）。
- 部署：CLI 被强制只连 **leader pod**（`leaderChecker`，非 leader 回 `close(4010)` 让其重连）；`sessionOccupancy`/`webConnections` 是**各 Pod 进程内存态**。⇒ **Web 必须落到与目标 CLI 同一个 leader pod**（依赖 LB 粘性/统一入口），否则 `QUERY_USER_RESOURCES` 看不到该 CLI。Android 侧无法控制，属服务端/网关约束，需确认线上拓扑。

### 8.2 外层消息服务端实现（`cloudMessageRouter.ts handleCloudManagementMessage`）
服务端**在 Web 侧拦截并就地处理**（不转发给 CLI）的类型：`QUERY_USER_RESOURCES`、`OCCUPY_SESSION`、`RELEASE_SESSION`、`CREATE_SESSION`、`SELECT_CLI`、`PING`。其余一律走 `forwardWebToCLI`（要求已占用 session）。

| 消息 | 服务端关键行为 | 失败/边界 |
|------|----------------|-----------|
| `QUERY_USER_RESOURCES` | 读本 Pod `userCLIs`/`cliSessions`/`sessionOccupancy` 组装 | Web 连接不存在 → ERROR |
| `SELECT_CLI` | 校验 CLI 在线 ∧ 同 userId，设 `webConn.selectedCLI` | 不在线/跨用户 → ERROR（`'CLI不存在或离线'`/`'无权访问该CLI'`） |
| `OCCUPY_SESSION` | `occupySession()` 返回 `{success,reason}`；同用户接管/幂等（§8.6） | 响应带 `reason` + 细分 `error` |
| `RELEASE_SESSION` | 带 sessionId 仅释放属本 web 的；空则释放本 web 全部 | 总是回 `success:true` |
| `CREATE_SESSION` | 需先 `selectedCLI` ∧ CLI 在线；转发给 CLI（注入 `webId`，`sessionId:undefined`） | 缺 CLI → ERROR；响应 `CREATE_SESSION_RESPONSE` 由 CLI 透传回 |
| `PING` | 立即回 `PONG{id}` | — |

### 8.3 内层转发（`forwardWebToCLI` / `forwardCLIToWeb`）
- Web→CLI：必须已占用 session，否则 ERROR `'请先占用一个Session'`；转发时注入 `sessionId`、`webId`、`_cloudRoute{fromWeb,fromUser,ts}`。CLI 离线 → ERROR `'CLI离线或不可用'`。
- CLI→Web：**透明转发**，按优先级路由目标 web：`_cloudRoute.targetWeb` → `_cloudRoute.sessionId` 占用者 → 顶层/`payload.sessionId` 占用者 → `_cloudRoute.fromWeb`；都没有则**丢弃并告警**（不广播）。下发前**删除 `_cloudRoute`**，得到与原始 CLI 消息一致的顶层结构。⇒ **确认无 `FORWARDED_FROM_CLI`**。
- 故 Android 收到的内层消息 = CLI 原始 `{type,payload,id,timestamp[,sessionId]}`。

### 8.4 锁与清理（`cloudConnectionManager.ts performCleanup`，每 60s）
| 对象 | 阈值 | 动作 | 备注 |
|------|------|------|------|
| CLI | 5min 无 `lastHeartbeat` | 标记 `offline`（不删） | CLI 用 `CLI_HEARTBEAT` 续期 |
| Web 连接 | 10min 无 `webActivity` **且 `ws!=OPEN`** | `removeWeb` | OPEN 的连接不清 |
| Session 占用 | 30min 无 `occupancy.lastActivity` | 删除占用 | ✅ 已修复：转发 COMMAND 会 `touchSessionOccupancy` 续期（§8.6），故只回收真正空闲会话 |

### 8.5 给服务端的改进建议（原始清单）
1. ~~OCCUPY 幂等/同用户接管~~ → ✅ 已实现（§8.6 #1）
2. ~~占用续期~~ → ✅ 已实现（§8.6 #2）
3. ~~细分错误码~~ → ✅ 已实现（§8.6 #3）
4. （可选，未做）Web 侧空闲 ping 超时主动 close，加速半开连接锁回收。**未实现**：接管 #1 已根除半开连接卡死，无需额外服务端 ping 定时器（避免误判与复杂度）。

### 8.6 已落地的服务端改动（branch `ls-dev`，未部署）

> 文件：`cloudConnectionManager.ts`、`cloudMessageRouter.ts`。已 `tsc --noEmit` 通过。

1. **同用户接管 + 幂等重占**：`occupySession` 返回类型由 `boolean` 改为 `OccupyResult { success, reason }`。命中已有占用时：
   - 同 `webId` → 幂等成功 `ALREADY_SELF`（仅刷新 lastActivity）；
   - 同 `userId` 不同 `webId` → **接管** `TAKEOVER`（`webToSession.delete(旧webId)` 后覆盖 occupancy 到新 webId）；
   - 不同 `userId` → 拒绝 `OCCUPIED_BY_OTHERS`；
   - 首次占用 → `OK`；前置失败 → `WEB_NOT_FOUND` / `NO_ACCESS`；异常 → `ERROR`。
2. **转发续期**：新增 `touchSessionOccupancy(sessionId)`；`forwardWebToCLI` 成功 `send` 后调用，刷新 `occupancy.lastActivity`。
3. **响应细分**：`handleOccupySession` 输出 `OCCUPY_SESSION_RESPONSE.payload` 增加 `reason` 字段，并按 reason 映射可读 `error`（`OCCUPIED_BY_OTHERS`→`'Session已被其他用户占用'` 等）。向后兼容：旧客户端仍可只读 `success`/`error`。

**对 Android 的契约影响**：重连恢复链路无需对 OCCUPY 失败做退避重试——半开连接场景下重占会直接 `TAKEOVER` 成功；仍应处理 `OCCUPIED_BY_OTHERS`（他人占用，提示用户）。
