/**
 * @license
 * Copyright 2026 DeepV Code team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * useGoalWizard — Host-side glue for the /goal command.
 *
 * Responsibilities:
 *   - Own the wizard open/closed state.
 *   - On wizard complete:
 *       1. Auto-enable YOLO mode if not already on (with a notice in history).
 *       2. Assemble the goal-driven prompt.
 *       3. Submit the prompt to the model via submitQuery.
 *   - On wizard cancel: close silently with an info message.
 */

import { useCallback, useState } from 'react';
import { ApprovalMode, type Config } from 'deepv-code-core';
import type { PartListUnion } from '@google/genai';
import { MessageType } from '../types.js';
import type { HistoryItem } from '../types.js';
import {
  buildGoalPrompt,
  type GoalWizardResult,
} from '../components/GoalWizard.js';
import { t, tp } from '../utils/i18n.js';

interface UseGoalWizardArgs {
  config: Config | null;
  addItem: (item: Omit<HistoryItem, 'id'>, timestamp: number) => void;
  submitQuery: (
    query: PartListUnion,
    options?: { isContinuation?: boolean; silent?: boolean },
  ) => void;
}

interface UseGoalWizardReturn {
  isGoalWizardOpen: boolean;
  openGoalWizard: () => void;
  handleGoalWizardComplete: (result: GoalWizardResult) => void;
  handleGoalWizardCancel: () => void;
}

export function useGoalWizard(args: UseGoalWizardArgs): UseGoalWizardReturn {
  const { config, addItem, submitQuery } = args;
  const [isOpen, setIsOpen] = useState(false);

  const openGoalWizard = useCallback(() => {
    setIsOpen(true);
  }, []);

  const handleGoalWizardCancel = useCallback(() => {
    setIsOpen(false);
    addItem(
      {
        type: MessageType.INFO,
        text: t('goalWizard.cancelled'),
      },
      Date.now(),
    );
  }, [addItem]);

  const handleGoalWizardComplete = useCallback(
    (result: GoalWizardResult) => {
      setIsOpen(false);

      // 1) Auto-enable YOLO mode if not already on.
      if (config) {
        const currentMode = config.getApprovalMode();
        if (currentMode !== ApprovalMode.YOLO) {
          try {
            config.setApprovalModeWithProjectSync(ApprovalMode.YOLO, true);
            addItem(
              {
                type: MessageType.INFO,
                text: t('goalWizard.yolo_auto_enabled'),
              },
              Date.now(),
            );
          } catch (err) {
            addItem(
              {
                type: MessageType.ERROR,
                text: tp('goalWizard.yolo_enable_failed', {
                  error: err instanceof Error ? err.message : String(err),
                }),
              },
              Date.now(),
            );
            return;
          }
        }
      }

      // 2) Announce.
      const intensityLabel = t(`goalWizard.intensity.${result.intensity}`);
      addItem(
        {
          type: MessageType.INFO,
          text: tp('goalWizard.launched_announce', {
            hours: result.hours,
            intensity: intensityLabel,
          }),
        },
        Date.now(),
      );

      // 3) Assemble prompt and submit silently — the prompt content is
      //    intentionally NOT shown in the chat history (its system rails /
      //    discipline framing is internal). The "info" line above is the
      //    only visible artifact of this turn from the user's perspective.
      const prompt = buildGoalPrompt(result);
      setTimeout(() => {
        submitQuery(prompt, { silent: true });
      }, 50);
    },
    [config, addItem, submitQuery],
  );

  return {
    isGoalWizardOpen: isOpen,
    openGoalWizard,
    handleGoalWizardComplete,
    handleGoalWizardCancel,
  };
}
