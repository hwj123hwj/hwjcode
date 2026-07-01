/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type Config,
  AuthType,
  SessionSelector,
  SessionManager as CoreSessionManager,
  convertSessionToClientHistory,
  PolicyEngine,
  MessageBus,
  createPolicyUpdater,
} from 'deepv-code-core';
import * as acp from '@agentclientprotocol/sdk';
import { randomUUID } from 'node:crypto';
import type { LoadedSettings } from '../config/settings.js';
import type { CliArgs } from '../config/config.js';
import { Session } from './acpSession.js';
import { AcpFileSystemService } from './acpFileSystemService.js';
import { getAcpErrorMessage } from './acpErrors.js';
import {
  buildAvailableModels,
  buildAvailableModes,
  buildConfigOptionsSnapshot,
  refreshCloudModelsForAcp,
} from './acpUtils.js';

/** Optional auth overrides carried in `authenticate` / `newSession` `_meta`. */
export interface AuthDetails {
  apiKey?: string;
  baseUrl?: string;
  customHeaders?: Record<string, string>;
}

/**
 * Tracks live ACP sessions.
 *
 * DeepCode currently runs a single `Config` per process; every ACP session
 * shares that config but gets its own `Session` (which owns a `GeminiChat`
 * and AbortController). This differs from gemini-cli's design where each
 * session rebuilds a `Config` via `loadCliConfig` — DeepCode's config
 * construction is heavier and not safely re-entrant, so we reuse instead.
 */
export class AcpSessionManager {
  private readonly sessions = new Map<string, Session>();
  private clientCapabilities?: acp.ClientCapabilities;
  private readonly policyEngine = new PolicyEngine();
  private readonly messageBus = new MessageBus();
  private policyUnsubscribe?: () => void;

  constructor(
    private readonly config: Config,
    private readonly settings: LoadedSettings,
    private readonly argv: CliArgs,
    private readonly connection: acp.AgentSideConnection,
  ) {
    this.policyUnsubscribe = createPolicyUpdater(
      this.policyEngine,
      this.messageBus,
    );
  }

  setClientCapabilities(capabilities: acp.ClientCapabilities): void {
    this.clientCapabilities = capabilities;
  }

  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  dispose(): void {
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
    this.policyUnsubscribe?.();
    this.messageBus.dispose();
  }

  /**
   * Handle `session/new`.
   *
   * Steps:
   *   1. Authenticate (honors auth details from the `authenticate` call).
   *   2. Install the ACP-backed FileSystemService if the client supports it.
   *   3. Start a fresh `GeminiChat` via `GeminiClient.startChat()`.
   *   4. Register the session and push the initial command list.
   */
  async newSession(
    req: acp.NewSessionRequest,
    authDetails: AuthDetails,
  ): Promise<acp.NewSessionResponse> {
    const sessionId = randomUUID();
    const cwd = req.cwd ?? process.cwd();

    await this.authenticate(authDetails);
    this.installFileSystemServiceIfSupported(sessionId, cwd);

    const geminiClient = this.config.getGeminiClient();
    // IMPORTANT: we deliberately share `GeminiClient.chat` with this session
    // instead of building an independent one. `GeminiClient.switchModel`,
    // `updateSystemPromptWithMcpPrompts`, compression, etc. all target
    // `this.chat` via `getChat()`. If we held a separate chat here, every
    // subsequent `set_config_option(model)` would update the client's chat
    // but the session would keep sending prompts to a stale chat that knows
    // neither the new model nor the `[Model switched from X to Y]` marker.
    //
    // ACP spec allows concurrent sessions, but OpenClaw / acpx spawn one
    // dvcode process per session, so one-chat-per-process is safe in
    // practice. If we ever need true per-session isolation we'd have to
    // teach `GeminiClient` about a session id and route switchModel
    // accordingly; for now the shared model/tool config is a feature.
    const chat = geminiClient.getChat();

    const session = new Session(
      sessionId,
      chat,
      this.config,
      this.connection,
      this.settings,
      cwd,
    );
    this.sessions.set(sessionId, session);

    // Fire-and-forget — /commands discovery is a UX niceety, failure is non-fatal.
    setTimeout(() => {
      void session.sendAvailableCommands();
    }, 0);

    const { availableModels, currentModelId } = buildAvailableModels(
      this.config,
      this.settings,
    );
    return {
      sessionId,
      modes: {
        availableModes: buildAvailableModes(),
        currentModeId: this.config.getApprovalMode(),
      },
      models: {
        availableModels,
        currentModelId,
      },
      configOptions: buildConfigOptionsSnapshot(
        this.config,
        session.getAllConfigValues(),
      ),
      // Echo the sessionId inside `_meta` as well. ACP's top-level
      // `sessionId` field is the canonical source, but OpenClaw / acpx
      // runtime adapters read the agent/backend session identifiers via
      // `_meta` projections (they scan for `agentSessionId` /
      // `backendSessionId` to populate `SessionAcpIdentity`). Without this
      // echo the adapter leaves those IDs empty, which breaks
      // `sessions_spawn` + `resumeSessionId` matching later.
      _meta: {
        agentSessionId: sessionId,
        backendSessionId: sessionId,
      },
    };
  }

  /**
   * Handle `session/load`.
   *
   * The IDE supplies a `sessionId` that DeepCode persisted previously. We
   * locate the backing `SessionData`, convert its client history to Gemini
   * chat history, call `GeminiClient.resumeChat`, and wrap it in a new
   * {@link Session}.
   */
  async loadSession(
    req: acp.LoadSessionRequest,
    authDetails: AuthDetails,
  ): Promise<acp.LoadSessionResponse> {
    const cwd = req.cwd ?? process.cwd();

    await this.authenticate(authDetails);
    this.installFileSystemServiceIfSupported(req.sessionId, cwd);

    const selector = new SessionSelector(new CoreSessionManager(cwd));
    const { data } = await selector.resolveSession(req.sessionId);

    // DeepCode persists `clientHistory` in the shape `{role, parts}[]` that
    // our `convertSessionToClientHistory` just passes through. Fall back to
    // the structured `history` array if a legacy save is encountered.
    const hydrated = convertSessionToClientHistory(
      (data.clientHistory as unknown as Array<Record<string, unknown>>) ??
        (data.history as unknown as Array<Record<string, unknown>>) ??
        [],
    );

    const geminiClient = this.config.getGeminiClient();
    await geminiClient.resumeChat(hydrated);

    const chat = geminiClient.getChat();
    const session = new Session(
      req.sessionId,
      chat,
      this.config,
      this.connection,
      this.settings,
      cwd,
    );

    // A resumed session already carries the title it was named with on first
    // use — don't let the next prompt re-trigger auto-titling.
    session.markTitleGenerated();

    // Replace any prior in-memory session with the same id.
    const previous = this.sessions.get(req.sessionId);
    if (previous) previous.dispose();
    this.sessions.set(req.sessionId, session);

    // Replay history to the IDE so it can rehydrate its UI.
    void session.streamHistory(
      (data.history as unknown as Array<Record<string, unknown>>) ?? [],
    );
    setTimeout(() => {
      void session.sendAvailableCommands();
    }, 0);

    const { availableModels, currentModelId } = buildAvailableModels(
      this.config,
      this.settings,
    );
    return {
      modes: {
        availableModes: buildAvailableModes(),
        currentModeId: this.config.getApprovalMode(),
      },
      models: {
        availableModels,
        currentModelId,
      },
      configOptions: buildConfigOptionsSnapshot(
        this.config,
        session.getAllConfigValues(),
      ),
      // Mirror the sessionId in `_meta` so acpx-style runtime adapters that
      // scan meta projections can populate their `SessionAcpIdentity`. See
      // `newSession` above for the full rationale.
      _meta: {
        agentSessionId: req.sessionId,
        backendSessionId: req.sessionId,
      },
    };
  }

  private async authenticate(authDetails: AuthDetails): Promise<void> {
    try {
      await this.config.refreshAuth(AuthType.USE_PROXY_AUTH, {
        apiKey: authDetails.apiKey,
        baseUrl: authDetails.baseUrl,
        customHeaders: authDetails.customHeaders,
      });
    } catch (e) {
      throw new acp.RequestError(
        -32000,
        getAcpErrorMessage(e) || 'Authentication required.',
      );
    }

    // Once auth is fresh, prime `Config.cloudModels` from the proxy's
    // `/web-api/models` endpoint so that `buildAvailableModels` /
    // `buildConfigOptionsSnapshot` advertise real, server-accepted ids to
    // the IDE. Without this, the IDE picks from a stale fallback list and
    // the server rejects switches with a 500 "不支持的模型".
    //
    // The desktop / IDE reads the model list straight out of the
    // `session/new` | `session/load` response exactly ONCE and never re-reads
    // it (see packages/desktop/src/main/acpSession.ts `modelsOf`). So when the
    // local cache is COLD — a desktop-only user who never ran the interactive
    // CLI, hence has no `cloudModels` in settings.json — we MUST await the
    // fetch here, otherwise the first (and only) response advertises an empty
    // list and the picker shows nothing. `refreshCloudModelsForAcp` also
    // persists the result to settings.json, so subsequent launches start warm.
    //
    // With a WARM cache (CLI veteran, or a prior ACP launch) we refresh in the
    // background: the snapshot already has a usable list and a slow/broken
    // network must not block session creation. The refresh still picks up
    // server-side model rollbacks for the next snapshot / launch. It's
    // best-effort and never throws, so neither path can fail session creation.
    const refresh = refreshCloudModelsForAcp(this.config, this.settings);
    const hasCachedModels = (this.config.getCloudModels?.()?.length ?? 0) > 0;
    if (hasCachedModels) {
      void refresh;
    } else {
      await refresh;
    }
  }

  private installFileSystemServiceIfSupported(
    sessionId: string,
    cwd: string,
  ): void {
    if (!this.clientCapabilities?.fs) return;
    const acpFs = new AcpFileSystemService(
      this.connection,
      sessionId,
      this.clientCapabilities.fs,
      this.config.getFileSystemService(),
      cwd,
    );
    this.config.setFileSystemService(acpFs);
  }
}
