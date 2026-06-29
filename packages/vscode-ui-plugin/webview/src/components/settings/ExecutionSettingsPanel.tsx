/**
 * Execution Settings Panel Component
 * 执行设置面板组件
 *
 * @license Apache-2.0
 * Copyright 2025 Easy Code
 */

import React from 'react';
import { useTranslation } from '../../hooks/useTranslation';
import { BooleanSettingItem, SelectSettingItem } from './SettingItem';
import './SettingItem.css';
import './SettingsPanel.css';

// =============================================================================
// 执行设置面板
// =============================================================================

interface ExecutionSettingsPanelProps {
  /** YOLO模式状态 */
  yoloMode: boolean;
  /** YOLO模式状态更新回调 */
  onYoloModeChange: (value: boolean) => void;
  /** 默认模型 */
  preferredModel: string;
  /** 默认模型更新回调 */
  onPreferredModelChange: (value: string) => void;
  /** 健康使用提醒 */
  healthyUse: boolean;
  /** 健康使用提醒更新回调 */
  onHealthyUseChange: (value: boolean) => void;
  /** 可用模型列表 */
  availableModels: any[];
  /** 内部场景/子代理模型覆盖 */
  modelOverrides: { compression?: string; codeExpert?: string; verification?: string };
  /** 模型覆盖更新回调 */
  onModelOverridesChange: (overrides: { compression?: string; codeExpert?: string; verification?: string }) => void;
}

export const ExecutionSettingsPanel: React.FC<ExecutionSettingsPanelProps> = ({
  yoloMode,
  onYoloModeChange,
  preferredModel,
  onPreferredModelChange,
  healthyUse,
  onHealthyUseChange,
  availableModels,
  modelOverrides,
  onModelOverridesChange
}) => {
  const { t } = useTranslation();

  // 构造模型选项，确保 Auto 在第一位且不重复，其余按字母排序
  const otherModels = availableModels
    .filter(m => m.name !== 'auto')
    .sort((a, b) => (a.displayName || a.name).localeCompare(b.displayName || b.name));

  const modelOptions = [
    { label: t('settings.general.autoModel'), value: 'auto', description: t('settings.general.autoModelDesc') },
    ...otherModels.map(model => ({
      label: model.displayName || model.name,
      value: model.name,
      description: model.description
    }))
  ];

  // 模型覆盖选择项：第一项为空值=恢复默认（压缩→内置默认，子代理→继承会话模型）。
  const overrideOptions = (defaultLabel: string) => [
    { label: defaultLabel, value: '', description: '' },
    ...otherModels.map(model => ({
      label: model.displayName || model.name,
      value: model.name,
      description: model.description
    }))
  ];

  // 单个覆盖字段更新：合并进现有覆盖对象。
  const setOverride = (
    key: 'compression' | 'codeExpert' | 'verification',
    value: string
  ) => {
    onModelOverridesChange({ ...modelOverrides, [key]: value });
  };

  const overrideFields: Array<{
    key: 'compression' | 'codeExpert' | 'verification';
    label: string;
    description: string;
    defaultLabel: string;
  }> = [
    {
      key: 'compression',
      label: t('settings.general.overrideCompressionLabel'),
      description: t('settings.general.overrideCompressionDesc'),
      defaultLabel: t('settings.general.overrideAutoDefault'),
    },
    {
      key: 'codeExpert',
      label: t('settings.general.overrideCodeExpertLabel'),
      description: t('settings.general.overrideCodeExpertDesc'),
      defaultLabel: t('settings.general.overrideInherit'),
    },
    {
      key: 'verification',
      label: t('settings.general.overrideVerificationLabel'),
      description: t('settings.general.overrideVerificationDesc'),
      defaultLabel: t('settings.general.overrideInherit'),
    },
  ];

  return (
    <div className="execution-settings-panel">
      {/* YOLO模式开关 - 直接生效，不需要Save按钮 */}
      <div className="execution-settings-panel__yolo-section">
        <BooleanSettingItem
          id="yolo-mode"
          label={t('settings.general.yoloLabel')}
          description={t('settings.general.yoloDesc')}
          value={yoloMode}
          onChange={(value) => {
            console.log('[YOLO] Toggle changed, immediately updating:', value);
            onYoloModeChange(value);
          }}
        />
      </div>

      {/* 健康使用提醒开关 */}
      <div className="execution-settings-panel__healthy-section" style={{ marginTop: '20px' }}>
        <BooleanSettingItem
          id="healthy-use"
          label={t('settings.general.healthyUseLabel') || '健康使用提醒'}
          description={t('settings.general.healthyUseDesc') || '开启深夜（22:00 - 06:00）用眼健康提醒'}
          value={healthyUse}
          onChange={(value) => {
            onHealthyUseChange(value);
          }}
        />
      </div>

      {/* 默认模型选择 */}
      <div className="execution-settings-panel__model-section" style={{ marginTop: '20px' }}>
        <SelectSettingItem
          id="preferred-model"
          label={t('settings.general.modelLabel')}
          description={t('settings.general.modelDesc')}
          value={preferredModel}
          onChange={(value) => onPreferredModelChange(value)}
          options={modelOptions}
        />
      </div>

      {/* 高级模型覆盖：压缩 / Code Expert / Verification 子代理 */}
      {overrideFields.map((f) => (
        <div
          key={f.key}
          className="execution-settings-panel__model-section"
          style={{ marginTop: '20px' }}
        >
          <SelectSettingItem
            id={`model-override-${f.key}`}
            label={f.label}
            description={f.description}
            value={modelOverrides[f.key] ?? ''}
            onChange={(value) => setOverride(f.key, value)}
            options={overrideOptions(f.defaultLabel)}
          />
        </div>
      ))}
    </div>
  );
};