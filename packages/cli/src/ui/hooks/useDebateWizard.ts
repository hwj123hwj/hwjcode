/**
 * @license
 * Copyright 2026 DeepV Code team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * useDebateWizard — Host-side glue for the /debate command.
 *
 * Responsibilities:
 * - Own the wizard open/closed state
 * - Enumerate available models (built-in + custom + cached cloud)
 * - On wizard complete: save preset, start runtime debate, switch to the
 *   first model, and submit the opening phrase via submitQuery
 * - On wizard cancel: close silently
 */

import { useCallback, useState, type MutableRefObject } from 'react';
import process from 'node:process';
import { Config, isCustomModel, generateCustomModelId } from 'deepv-code-core';
import type { PartListUnion } from '@google/genai';
import { MessageType } from '../types.js';
import type { HistoryItem } from '../types.js';
import type { LoadedSettings } from '../../config/settings.js';
import { appEvents, AppEvent } from '../../utils/events.js';
import {
  DebateWizardAvailableModel,
  DebateWizardResult,
} from '../components/DebateWizard.js';
import {
  startDebate,
  getActiveDebate,
  advanceCursor,
  endDebate,
  resumeDebate,
  pauseDebate,
} from '../utils/debateState.js';
import { pickOpening, pickFollowup } from '../utils/debatePhrases.js';
import { loadPresets, savePreset, DebatePreset } from '../utils/debateStorage.js';
import { loadCustomModels } from '../../config/customModelsStorage.js';

interface UseDebateWizardReturn {
  isDebateWizardOpen: boolean;
  debateWizardModels: DebateWizardAvailableModel[];
  debateWizardPresets: DebatePreset[];
  openDebateWizard: () => void;
  handleDebateWizardComplete: (result: DebateWizardResult) => void;
  handleDebateWizardCancel: () => void;
  /** Resume a paused debate: switch to next speaker, submit followup. */
  handleResumeDebate: () => void;
}

/**
 * Enumerate all models the user can pick from in the debate wizard.
 *
 * Strategy:
 * - Start from the `cloudModels` cached in settings (populated by /model).
 *   These are the "official" models available on the proxy server.
 * - Append custom models from custom-models.json.
 * - Filter out anything disabled.
 * - Deduplicate by ID (shouldn't happen in practice but safe).
 */
function enumerateAvailableModels(
  settings: LoadedSettings,
  config: Config | null,
): DebateWizardAvailableModel[] {
  const out: DebateWizardAvailableModel[] = [];
  const seen = new Set<string>();

  // Built-in / cloud models from settings cache (typed via LoadedSettings.merged).
  const cloudModels = settings.merged.cloudModels;
  if (Array.isArray(cloudModels)) {
    for (const m of cloudModels) {
      if (!m || m.available === false) continue;
      const id = m.name;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        label: m.displayName || id,
        description: undefined,
      });
    }
  }

  // Custom models.
  try {
    const customs = loadCustomModels();
    for (const cm of customs) {
      if (cm.enabled === false) continue;
      const id = generateCustomModelId(cm);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        label: cm.displayName || id,
        description: `${cm.provider} · ${cm.baseUrl}`,
      });
    }
  } catch {
    // ignore — custom model enumeration is best-effort
  }

  // Fallback: if nothing found, at least surface the currently active model.
  if (out.length === 0 && config) {
    const current = config.getModel();
    if (current) {
      out.push({
        id: current,
        label: isCustomModel(current) ? `${current} (custom)` : current,
      });
    }
  }

  return out;
}

export function useDebateWizard(args: {
  settings: LoadedSettings;
  config: Config | null;
  addItem: (item: Omit<HistoryItem, 'id'>, timestamp: number) => void;
  submitQuery: (
    query: PartListUnion,
    options?: { isContinuation?: boolean; silent?: boolean },
  ) => void;
  /**
   * Shared ref for the AbortController driving debate-related async work
   * (model switching for both the opening turn and subsequent turns). Letting
   * useGeminiStream observe the same ref means ESC / pauseDebate can interrupt
   * a switchModel that's in flight — including the very first switch.
   */
  advanceAbortRef: MutableRefObject<AbortController | null>;
}): UseDebateWizardReturn {
  const { settings, config, addItem, submitQuery, advanceAbortRef } = args;

  const [isOpen, setIsOpen] = useState(false);
  const [models, setModels] = useState<DebateWizardAvailableModel[]>([]);
  const [presets, setPresets] = useState<DebatePreset[]>([]);

  const openDebateWizard = useCallback(() => {
    // Fresh snapshot on each open — users may have added models since last time.
    setModels(enumerateAvailableModels(settings, config));
    const projectRoot = config?.getProjectRoot() || process.cwd();
    setPresets(loadPresets(projectRoot));
    setIsOpen(true);
  }, [settings, config]);

  const handleDebateWizardCancel = useCallback(() => {
    setIsOpen(false);
    addItem(
      {
        type: MessageType.INFO,
        text: 'ℹ️ 辩论配置已取消。',
      },
      Date.now(),
    );
  }, [addItem]);

  const handleDebateWizardComplete = useCallback(
    async (result: DebateWizardResult) => {
      setIsOpen(false);

      // 1) Persist as a preset for future /debate invocations.
      const projectRoot = config?.getProjectRoot() || process.cwd();
      savePreset(projectRoot, {
        topic: result.topic,
        models: result.models,
        rounds: result.rounds,
      });

      // 2) If a debate is already running, prevent double-starting (safety check)
      const existing = getActiveDebate();
      if (existing && existing.status === 'running') {
        addItem(
          {
            type: MessageType.ERROR,
            text: '⚠️ 已经有一场辩论正在进行。',
          },
          Date.now(),
        );
        return;
      }

      // 3) Install runtime state. The cursor points at (round=0, modelIdx=0),
      //    meaning the FIRST model is the one about to speak.
      try {
        startDebate({
          topic: result.topic,
          models: result.models,
          rounds: result.rounds,
        });
      } catch (err) {
        addItem(
          {
            type: MessageType.ERROR,
            text: `❌ 无法启动辩论：${err instanceof Error ? err.message : String(err)}`,
          },
          Date.now(),
        );
        return;
      }

      // 4) Announce the debate.
      addItem(
        {
          type: MessageType.INFO,
          text:
            `🎭 辩论开始\n` +
            `   话题：${result.topic}\n` +
            `   参赛：${result.models.join(' → ')}\n` +
            `   每人 ${result.rounds} 轮，共 ${result.models.length * result.rounds} 轮发言\n` +
            `   按 Esc 可暂停，用 /debate continue 恢复、/debate end 结束`,
        },
        Date.now(),
      );

      // 5) 强制切换到第一个模型并等待完成，然后再发开场白。
      //    不做 currentModel === firstModel 的短路——switchModel 内部会处理
      //    "已是同一模型"的情况（注入历史标记但跳过实际 API 切换）。
      //    这样保证开场白一定在正确的模型下发出。
      //
      //    switchModel 不会 throw——失败时返回 { success:false, error }。必须
      //    显式检查，否则会把开场白发给旧模型。
      const firstModel = result.models[0]!;
      const client = config?.getGeminiClient();

      // 复用 useGeminiStream 暴露的 ref：ESC 路径 abort 这个 controller 就能
      // 打断首启 switchModel，同时 pauseDebate 后也会打断后续推进。
      const abortController = new AbortController();
      advanceAbortRef.current = abortController;

      // UI 提示用户正在切换，避免用户误以为"卡住了"。
      // addItem 后让出一次宏任务，强制 React commit 这条消息，避免与后续
      // addItem / submitQuery 被 React 18 自动 batching 合并导致 UI 看不见。
      addItem(
        {
          type: MessageType.INFO,
          text: `🎭 切换到 ${firstModel}...`,
        },
        Date.now(),
      );
      await new Promise<void>(resolve => setTimeout(resolve, 0));

      try {
        if (!client) throw new Error('GeminiClient 未就绪');
        const switchResult = await client.switchModel(
          firstModel,
          abortController.signal,
        );
        if (!switchResult.success) {
          addItem(
            {
              type: MessageType.ERROR,
              text: `❌ 切换到 ${firstModel} 失败：${switchResult.error ?? '未知错误'}`,
            },
            Date.now(),
          );
          endDebate();
          return;
        }
        // 切换成功后如实汇报：当前模型 + 压缩信息（若有）。
        // emit ModelChanged 让 footer 等 UI 组件更新显示的模型名字。
        appEvents.emit(AppEvent.ModelChanged, firstModel);
        const confirmText = switchResult.compressionInfo
          ? `✓ 已切换到 ${firstModel}（上下文压缩: ${switchResult.compressionInfo.originalTokenCount} → ${switchResult.compressionInfo.newTokenCount} tokens）`
          : `✓ 已切换到 ${firstModel}`;
        addItem(
          {
            type: MessageType.INFO,
            text: confirmText,
          },
          Date.now(),
        );
      } catch (err) {
        // 被 ESC 主动中止：不报错，保留 debate 以便 continue 恢复
        if (abortController.signal.aborted) return;
        addItem(
          {
            type: MessageType.ERROR,
            text: `❌ 切换到 ${firstModel} 失败：${err instanceof Error ? err.message : String(err)}`,
          },
          Date.now(),
        );
        endDebate();
        return;
      } finally {
        // 清掉 ref，避免后续 pauseDebate 误 abort 已完成的 controller
        if (advanceAbortRef.current === abortController) {
          advanceAbortRef.current = null;
        }
      }

      // 6) switchModel 成功 → 发开场白触发模型 0 说话。
      //    注意：此刻 cursor 维持 (0,0)。遵循 "CURRENT speaker" 语义 —
      //    cursor 始终指向刚刚/正在说话的那个人。后续每次 Idle 事件由
      //    useGeminiStream 的推进块决定下一位，switch 成功后再 advanceCursor。
      //
      //    关键：submitQuery 内部会立刻 setIsResponding(true)，与上面的 addItem
      //    会被 React 18 batching 合并，导致"已切换到 xxx"行被流式响应覆盖看
      //    不见。用 setTimeout(50) 把 submitQuery 推到下一帧，保证 confirm 行
      //    先 commit 到终端。
      setTimeout(() => {
        if (getActiveDebate()?.status !== 'running') return;
        submitQuery(pickOpening(result.topic));
      }, 50);
    },
    [config, addItem, submitQuery, advanceAbortRef],
  );

  // Resume a paused debate. Core logic mirrors the auto-advance block in
  // useGeminiStream: compute next speaker -> switchModel -> advanceCursor ->
  // submit followup. Kept here because this hook has stable access to
  // geminiClient and submitQuery.
  const handleResumeDebate = useCallback(async () => {
    const debate = getActiveDebate();
    if (!debate) {
      addItem(
        {
          type: MessageType.INFO,
          text: 'ℹ️ 当前没有辩论可恢复。',
        },
        Date.now(),
      );
      return;
    }
    if (debate.status === 'running') {
      addItem(
        {
          type: MessageType.INFO,
          text: 'ℹ️ 辩论已在运行中。',
        },
        Date.now(),
      );
      return;
    }
    if (debate.status === 'done') {
      addItem(
        {
          type: MessageType.INFO,
          text: 'ℹ️ 辩论已结束。用 /debate 开始新的。',
        },
        Date.now(),
      );
      return;
    }

    const client = config?.getGeminiClient();
    if (!client) {
      addItem(
        {
          type: MessageType.ERROR,
          text: '❌ GeminiClient 未就绪，无法恢复辩论。',
        },
        Date.now(),
      );
      return;
    }

    // 计算下一位说话人（CURRENT 语义：cursor 指向刚刚/正在说话的人，
    // 暂停多半发生在这个人的流式响应期间，当前模型 == cursor 指向的模型）。
    let nextModelIdx = debate.cursor.modelIdx + 1;
    let nextRound = debate.cursor.round;
    if (nextModelIdx >= debate.models.length) {
      nextModelIdx = 0;
      nextRound += 1;
    }
    const isDebateFinished = nextRound >= debate.rounds;

    // 先把状态切回 running 再开始异步工作。失败路径会再 pauseDebate 回去。
    resumeDebate();

    if (isDebateFinished) {
      advanceCursor();
      endDebate();
      addItem(
        {
          type: MessageType.INFO,
          text: '🎭 辩论已是最后一轮，直接结束。',
        },
        Date.now(),
      );
      return;
    }

    const nextModel = debate.models[nextModelIdx]!;
    const abortController = new AbortController();
    advanceAbortRef.current = abortController;

    // UI 提示用户正在切换，addItem 后让出宏任务避免与后续 addItem/submitQuery 被 batch 合并
    addItem(
      {
        type: MessageType.INFO,
        text: `🎭 切换到 ${nextModel}...`,
      },
      Date.now(),
    );
    await new Promise<void>(resolve => setTimeout(resolve, 0));

    try {
      const switchResult = await client.switchModel(
        nextModel,
        abortController.signal,
      );
      if (abortController.signal.aborted) return;
      if (!switchResult.success) {
        pauseDebate();
        addItem(
          {
            type: MessageType.ERROR,
            text: `⚠️ 恢复辩论失败：切换到 ${nextModel} 失败（${switchResult.error ?? '未知错误'}）。再次 /debate continue 可重试。`,
          },
          Date.now(),
        );
        return;
      }
      // 如实汇报切换结果
      appEvents.emit(AppEvent.ModelChanged, nextModel);
      const confirmText = switchResult.compressionInfo
        ? `✓ 已切换到 ${nextModel}（上下文压缩: ${switchResult.compressionInfo.originalTokenCount} → ${switchResult.compressionInfo.newTokenCount} tokens）`
        : `✓ 已切换到 ${nextModel}`;
      addItem(
        {
          type: MessageType.INFO,
          text: confirmText,
        },
        Date.now(),
      );

      // 推进 cursor，然后用 setTimeout 延后 submitQuery，防止被 React batching
      // 合并导致 confirm 行看不见（详见 useGeminiStream 同名注释）
      advanceCursor();
      setTimeout(() => {
        if (getActiveDebate()?.status !== 'running') return;
        submitQuery(pickFollowup());
      }, 50);
    } catch (err) {
      if (abortController.signal.aborted) return;
      pauseDebate();
      addItem(
        {
          type: MessageType.ERROR,
          text: `⚠️ 恢复辩论失败：${err instanceof Error ? err.message : String(err)}。再次 /debate continue 可重试。`,
        },
        Date.now(),
      );
    } finally {
      if (advanceAbortRef.current === abortController) {
        advanceAbortRef.current = null;
      }
    }
  }, [config, addItem, submitQuery, advanceAbortRef]);

  return {
    isDebateWizardOpen: isOpen,
    debateWizardModels: models,
    debateWizardPresets: presets,
    openDebateWizard,
    handleDebateWizardComplete,
    handleDebateWizardCancel,
    handleResumeDebate,
  };
}
