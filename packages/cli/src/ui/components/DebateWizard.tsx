/**
 * @license
 * Copyright 2026 DeepV Code team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * DebateWizard — interactive wizard for configuring a /debate session.
 *
 * Flow:
 *   Step 0 (PICK_PRESET)  - shown only if project has saved presets.
 *                           User picks one -> jumps straight to CONFIRM with
 *                           that preset's fields. Or picks "New debate" -> MODELS.
 *   Step 1 (MODELS)       - multi-select 2-4 models.
 *   Step 2 (ROUNDS)       - single-select rounds per model (1/2/3).
 *   Step 3 (TOPIC)        - free-text topic input.
 *   Step 4 (CONFIRM)      - review summary, start or go back.
 *
 * Design notes:
 * - We intentionally mirror the look of CustomModelWizard (bordered box, step
 *   counter, description line) so users get a consistent wizard feel.
 * - Model list is provided by the caller (debateCommand) so this component
 *   stays pure/testable — it doesn't know how to enumerate models.
 */

import React, { useState, useCallback } from 'react';
import { Box, Text } from 'ink';
import { Colors } from '../colors.js';
import { SimpleTextInput } from './shared/SimpleTextInput.js';
import { RadioButtonSelect } from './shared/RadioButtonSelect.js';
import { SelectMulti } from './shared/SelectMulti.js';
import { useKeypress, Key } from '../hooks/useKeypress.js';
import type { DebatePreset } from '../utils/debateStorage.js';

export interface DebateWizardResult {
  topic: string;
  models: string[];
  rounds: number;
}

export interface DebateWizardAvailableModel {
  /** Model ID used for switchModel() calls. */
  id: string;
  /** Human-readable label shown in the picker. */
  label: string;
  /** Optional secondary text (e.g. provider). */
  description?: string;
}

export interface DebateWizardProps {
  /** All models available for selection, in display order. */
  availableModels: DebateWizardAvailableModel[];
  /** Previously saved presets for this project, newest first. May be empty. */
  presets: DebatePreset[];
  /** User accepted final config — host should start the debate. */
  onComplete: (result: DebateWizardResult) => void;
  /** User escaped out — no debate starts. */
  onCancel: () => void;
}

enum Step {
  PICK_PRESET = 'pickPreset',
  MODELS = 'models',
  ROUNDS = 'rounds',
  TOPIC = 'topic',
  CONFIRM = 'confirm',
}

const ROUND_OPTIONS = [
  { label: '1 轮（每人各自陈述）', value: 1 },
  { label: '2 轮（推荐：陈述 + 反驳）', value: 2 },
  { label: '3 轮（深度辩论）', value: 3 },
];

const MIN_MODELS = 2;
const MAX_MODELS = 4;

function formatPresetLabel(p: DebatePreset): string {
  const ago = relativeTime(p.savedAt);
  const modelsStr = p.models.join(' + ');
  return `${p.topic}  ·  ${modelsStr}, ${p.rounds}轮  ·  ${ago}`;
}

function relativeTime(iso: string): string {
  try {
    const then = new Date(iso).getTime();
    const delta = Date.now() - then;
    const m = Math.floor(delta / 60000);
    if (m < 1) return '刚刚';
    if (m < 60) return `${m} 分钟前`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} 小时前`;
    const d = Math.floor(h / 24);
    return `${d} 天前`;
  } catch {
    return iso;
  }
}

function stepTitle(step: Step): string {
  switch (step) {
    case Step.PICK_PRESET:
      return '选择历史设定';
    case Step.MODELS:
      return '选择参赛模型';
    case Step.ROUNDS:
      return '每人发言轮数';
    case Step.TOPIC:
      return '辩论话题';
    case Step.CONFIRM:
      return '确认开始';
    default:
      return '';
  }
}

function stepDescription(step: Step): string {
  switch (step) {
    case Step.PICK_PRESET:
      return '你之前保存过辩论设定，可以直接复用，或新建一次。';
    case Step.MODELS:
      return `至少 ${MIN_MODELS} 个，最多 ${MAX_MODELS} 个。按空格勾选，回车确认。`;
    case Step.ROUNDS:
      return '每个模型在整场辩论中最多发言的次数。';
    case Step.TOPIC:
      return '一句话描述你想辩论什么。例如：这段压缩修复的代码是否健壮。';
    case Step.CONFIRM:
      return '再看一眼就开始。辩论会按显示顺序轮流发言。';
    default:
      return '';
  }
}

export function DebateWizard({
  availableModels,
  presets,
  onComplete,
  onCancel,
}: DebateWizardProps): React.JSX.Element {
  // Initial step: if we have presets, let the user pick one first.
  const [step, setStep] = useState<Step>(
    presets.length > 0 ? Step.PICK_PRESET : Step.MODELS,
  );
  const [chosenModels, setChosenModels] = useState<string[]>([]);
  const [chosenRounds, setChosenRounds] = useState<number>(2);
  const [topic, setTopic] = useState<string>('');
  const [topicInput, setTopicInput] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  // ---------- Step: PICK_PRESET ----------

  const presetItems = [
    ...presets.map((p, i) => ({
      label: formatPresetLabel(p),
      value: `preset:${i}`,
    })),
    { label: '➕ 新建辩论', value: 'new' },
  ];

  const handlePresetSelect = useCallback(
    (value: string) => {
      if (value === 'new') {
        setStep(Step.MODELS);
        return;
      }
      const idx = Number(value.replace('preset:', ''));
      const p = presets[idx];
      if (!p) {
        setStep(Step.MODELS);
        return;
      }
      // Load preset into state and jump straight to CONFIRM.
      setChosenModels([...p.models]);
      setChosenRounds(p.rounds);
      setTopic(p.topic);
      setTopicInput(p.topic);
      setStep(Step.CONFIRM);
    },
    [presets],
  );

  // ESC on certain steps cancels the whole wizard.
  // Models and Topic steps are handled by their respective input components.
  useKeypress(
    (key: Key) => {
      if (key.name === 'escape') onCancel();
    },
    { isActive: step === Step.PICK_PRESET || step === Step.ROUNDS || step === Step.CONFIRM },
  );

  // ---------- Step: MODELS ----------

  const modelItems = availableModels.map((m) => ({
    label: m.label,
    value: m.id,
    description: m.description,
  }));

  const handleModelsSubmit = useCallback((values: string[]) => {
    if (values.length < MIN_MODELS) {
      setError(`至少选 ${MIN_MODELS} 个模型`);
      return;
    }
    if (values.length > MAX_MODELS) {
      setError(`最多选 ${MAX_MODELS} 个模型`);
      return;
    }
    setError(null);
    setChosenModels(values);
    setStep(Step.ROUNDS);
  }, []);

  // ---------- Step: ROUNDS ----------

  const handleRoundsSelect = useCallback((value: number) => {
    setChosenRounds(value);
    setStep(Step.TOPIC);
  }, []);

  // ---------- Step: TOPIC ----------

  const handleTopicSubmit = useCallback((value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      setError('话题不能为空');
      return;
    }
    setError(null);
    setTopic(trimmed);
    setStep(Step.CONFIRM);
  }, []);

  // ESC in text-input step cancels.
  const handleTopicCancel = useCallback(() => {
    onCancel();
  }, [onCancel]);

  // ---------- Step: CONFIRM ----------

  const confirmItems = [
    { label: '✓ 开始辩论', value: 'start' },
    { label: '↩ 返回修改', value: 'back' },
    { label: '✗ 取消', value: 'cancel' },
  ];

  const handleConfirm = useCallback(
    (value: string) => {
      if (value === 'start') {
        onComplete({
          topic,
          models: chosenModels,
          rounds: chosenRounds,
        });
      } else if (value === 'back') {
        // "Back" from confirm sends the user to MODELS (start of edit flow).
        setStep(Step.MODELS);
      } else {
        onCancel();
      }
    },
    [chosenModels, chosenRounds, topic, onComplete, onCancel],
  );

  // ---------- Rendering ----------

  // Total logical steps depends on whether we show the preset picker.
  // 1. Pick Preset (optional)
  // 2. Models
  // 3. Rounds
  // 4. Topic
  // 5. Confirm
  const stepsOrder = presets.length > 0
    ? [Step.PICK_PRESET, Step.MODELS, Step.ROUNDS, Step.TOPIC, Step.CONFIRM]
    : [Step.MODELS, Step.ROUNDS, Step.TOPIC, Step.CONFIRM];

  const totalSteps = stepsOrder.length;
  const currentStepIdx = stepsOrder.indexOf(step);
  const displayStepNumber = currentStepIdx + 1;

  return (
    <Box
      borderStyle="round"
      borderColor={Colors.AccentCyan}
      flexDirection="column"
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
    >
      <Box marginBottom={1}>
        <Text color={Colors.AccentCyan} bold>
          🎭 辩论模式配置
        </Text>
      </Box>
      <Box marginBottom={1}>
        <Text color={Colors.Gray}>
          Step {displayStepNumber}/{totalSteps}: {stepTitle(step)}
        </Text>
      </Box>
      <Box marginBottom={1}>
        <Text color={Colors.Comment}>{stepDescription(step)}</Text>
      </Box>

      <Box
        borderStyle="single"
        borderColor={Colors.Gray}
        paddingX={1}
        paddingY={1}
        flexDirection="column"
      >
        {step === Step.PICK_PRESET && (
          <RadioButtonSelect
            items={presetItems}
            initialIndex={0}
            onSelect={handlePresetSelect}
            onHighlight={() => {}}
            isFocused
          />
        )}

        {step === Step.MODELS && (
          <Box flexDirection="column">
            {modelItems.length < MIN_MODELS ? (
              <Box flexDirection="column">
                <Text color={Colors.AccentRed}>
                  ✗ 当前可用模型不足 {MIN_MODELS} 个，无法进行辩论。
                </Text>
                <Text color={Colors.Gray}>请先通过 /model 或 /add-model 配置更多模型。</Text>
                <Box marginTop={1}>
                  <Text color={Colors.Gray}>按 Esc 退出</Text>
                </Box>
              </Box>
            ) : (
              <>
                <SelectMulti
                  items={modelItems}
                  onSubmit={handleModelsSubmit}
                  onCancel={onCancel}
                  isFocused
                />
                {error && (
                  <Box marginTop={1}>
                    <Text color={Colors.AccentRed}>✗ {error}</Text>
                  </Box>
                )}
              </>
            )}
          </Box>
        )}

        {step === Step.ROUNDS && (
          <RadioButtonSelect
            items={ROUND_OPTIONS.map((o) => ({
              label: o.label,
              value: String(o.value),
            }))}
            initialIndex={ROUND_OPTIONS.findIndex((o) => o.value === chosenRounds)}
            onSelect={(v) => handleRoundsSelect(Number(v))}
            onHighlight={() => {}}
            isFocused
          />
        )}

        {step === Step.TOPIC && (
          <Box flexDirection="column">
            <SimpleTextInput
              value={topicInput}
              onChange={setTopicInput}
              onSubmit={handleTopicSubmit}
              onCancel={handleTopicCancel}
              isActive
            />
            {error && (
              <Box marginTop={1}>
                <Text color={Colors.AccentRed}>✗ {error}</Text>
              </Box>
            )}
            <Box marginTop={1}>
              <Text color={Colors.Gray}>回车确认，Esc 取消</Text>
            </Box>
          </Box>
        )}

        {step === Step.CONFIRM && (
          <Box flexDirection="column">
            <Box flexDirection="column" marginBottom={1}>
              <Text>
                <Text color={Colors.AccentCyan} bold>话题：</Text>
                <Text>{topic}</Text>
              </Text>
              <Text>
                <Text color={Colors.AccentCyan} bold>模型：</Text>
                <Text>{chosenModels.join(' → ')}</Text>
              </Text>
              <Text>
                <Text color={Colors.AccentCyan} bold>每人轮数：</Text>
                <Text>{chosenRounds}</Text>
              </Text>
              <Text>
                <Text color={Colors.AccentCyan} bold>总发言次数：</Text>
                <Text>{chosenModels.length * chosenRounds}</Text>
              </Text>
            </Box>
            <RadioButtonSelect
              items={confirmItems}
              initialIndex={0}
              onSelect={handleConfirm}
              onHighlight={() => {}}
              isFocused
            />
          </Box>
        )}
      </Box>
    </Box>
  );
}
