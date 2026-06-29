/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { RadioButtonSelect, type RadioSelectItem } from './shared/RadioButtonSelect.js';
import { SettingScope, type LoadedSettings } from '../../config/settings.js';
import { Config, ApprovalMode, getCoreSystemPrompt, AgentStyle, ModelOverrides } from 'deepv-code-core';
import { Colors } from '../colors.js';
import { t, tp } from '../utils/i18n.js';
import { getModelDisplayName } from '../../utils/modelUtils.js';
import { getAvailableModels } from '../commands/modelCommand.js';

type ModelOverrideKey = keyof ModelOverrides;

interface SettingsMenuDialogProps {
  onClose: () => void;
  settings: LoadedSettings;
  config: Config;
  terminalWidth: number;
  availableTerminalHeight?: number;
  // 回调函数用于打开其他对话框
  onOpenTheme: () => void;
  onOpenEditor: () => void;
  onOpenModel: () => void;
  onReloadMemory?: () => Promise<void>;
}

/**
 * 交互式设置菜单面板
 * 使用键盘上下移动、回车进入子菜单
 */
export const SettingsMenuDialog = React.memo(function SettingsMenuDialog({
  onClose,
  settings,
  config,
  terminalWidth,
  availableTerminalHeight,
  onOpenTheme,
  onOpenEditor,
  onOpenModel,
  onReloadMemory,
}: SettingsMenuDialogProps) {

  // Calculate display values
  const themeValue = settings.merged.theme || t('config.value.default');
  const editorValue = settings.merged.preferredEditor || t('config.value.auto');
  const modelValue = settings.merged.preferredModel
    ? getModelDisplayName(settings.merged.preferredModel, config)
    : t('config.value.auto');

  // Project memory mode display value
  const projectMemoryMode = settings.merged.projectMemoryMode || 'all';
  const projectMemoryDisplayValue = (() => {
    switch (projectMemoryMode) {
      case 'deepv-only': return t('config.value.project.memory.deepvOnly');
      case 'none': return t('config.value.project.memory.none');
      default: return t('config.value.project.memory.all');
    }
  })();

  // 当前模型覆盖（压缩 & 子代理），本地状态以便修改后立即刷新展示
  const [overrides, setOverrides] = useState<ModelOverrides>(
    settings.merged.modelOverrides ?? {}
  );

  // 计算某个覆盖项的展示值：已设置 → 模型显示名；未设置 → 默认/继承
  const overrideDisplayValue = useCallback(
    (key: ModelOverrideKey): string => {
      const value = overrides[key];
      if (value) {
        return getModelDisplayName(value, config);
      }
      return key === 'compression'
        ? t('config.value.modelOverrides.default')
        : t('config.value.modelOverrides.inherit');
    },
    [overrides, config]
  );

  // 主菜单选项 - 按使用频率排序
  const menuItems: RadioSelectItem<string>[] = [
    { label: t('config.menu.model'), value: 'model', rightText: `(${modelValue})` },
    {
      label: `${(function () {
        switch (config.getAgentStyle()) {
          case 'codex': return '⚡';
          case 'cursor': return '↗️';
          case 'augment': return '🚀';
          case 'claude-code': return '✳️';
          case 'antigravity': return '🌈';
          case 'windsurf': return '🌊';
          default: return '𝓥';
        }
      })()} ${t('config.menu.agent.style')}`,
      value: 'agent-style',
      rightText: `(${t(`agentStyle.style.${config.getAgentStyle()}.label` as any)})`
    },
    { label: `${config.getApprovalMode() === ApprovalMode.YOLO ? '🚀' : '🛡️'} ${t('config.menu.yolo')}`, value: 'yolo', rightText: config.getApprovalMode() === ApprovalMode.YOLO ? `(${t('config.value.on')})` : `(${t('config.value.off')})` },
    { label: t('config.menu.theme'), value: 'theme', rightText: `(${themeValue})` },
    { label: t('config.menu.language'), value: 'language', rightText: settings.merged.preferredLanguage ? `(${settings.merged.preferredLanguage})` : `(${t('config.value.default')})` },
    { label: t('config.menu.editor'), value: 'editor', rightText: `(${editorValue})` },
    { label: t('config.menu.modelOverrides'), value: 'model-overrides' },
    { label: t('config.menu.project.memory'), value: 'project-memory', rightText: `(${projectMemoryDisplayValue})` },
    { label: `${settings.merged.vimMode ? '✅' : '❌'} ${t('config.menu.vim')}`, value: 'vim', rightText: settings.merged.vimMode ? `(${t('config.value.on')})` : `(${t('config.value.off')})` },
    { label: `${config.getHealthyUseEnabled() ? '✅' : '❌'} ${t('config.menu.healthy.use')}`, value: 'healthy-use', rightText: config.getHealthyUseEnabled() ? `(${t('config.value.on')})` : `(${t('config.value.off')})` },
  ];

  // YOLO 模式选项
  const yoloModeItems: RadioSelectItem<string>[] = [
    { label: t('config.option.yolo.enable'), value: 'on' },
    { label: t('config.option.yolo.disable'), value: 'off' },
  ];

  // Agent Style 选项
  const agentStyleItems: RadioSelectItem<string>[] = [
    { label: t('config.option.agent.style.default'), value: 'default' },
    { label: t('config.option.agent.style.codex'), value: 'codex' },
    { label: t('config.option.agent.style.cursor'), value: 'cursor' },
    { label: t('config.option.agent.style.augment'), value: 'augment' },
    { label: t('config.option.agent.style.claudeCode'), value: 'claude-code' },
    { label: t('config.option.agent.style.antigravity'), value: 'antigravity' },
    { label: t('config.option.agent.style.windsurf'), value: 'windsurf' },
  ];

  // Healthy Use 选项
  const healthyUseItems: RadioSelectItem<string>[] = [
    { label: t('config.option.healthy.use.enable'), value: 'on' },
    { label: t('config.option.healthy.use.disable'), value: 'off' },
  ];

  // Project Memory Mode 选项
  const projectMemoryItems: RadioSelectItem<string>[] = [
    { label: t('config.option.project.memory.all'), value: 'all' },
    { label: t('config.option.project.memory.deepvOnly'), value: 'deepv-only' },
    { label: t('config.option.project.memory.none'), value: 'none' },
  ];

  // 模型覆盖目标列表（压缩 / Code Expert / Verification）
  const overrideTargetItems: RadioSelectItem<string>[] = [
    { label: t('config.option.modelOverrides.compression'), value: 'compression', rightText: `(${overrideDisplayValue('compression')})` },
    { label: t('config.option.modelOverrides.codeExpert'), value: 'codeExpert', rightText: `(${overrideDisplayValue('codeExpert')})` },
    { label: t('config.option.modelOverrides.verification'), value: 'verification', rightText: `(${overrideDisplayValue('verification')})` },
  ];

  // 菜单状态
  type MenuView = 'main' | 'yolo' | 'agent-style' | 'healthy-use' | 'language' | 'project-memory' | 'model-overrides' | 'model-override-picker';
  const [currentView, setCurrentView] = useState<MenuView>('main');
  const [selectedMain, setSelectedMain] = useState<string>('model');

  // 模型覆盖：当前正在编辑的目标项 & 可选模型列表（异步加载）
  const [selectedOverrideTarget, setSelectedOverrideTarget] = useState<ModelOverrideKey>('compression');
  const [overrideModelItems, setOverrideModelItems] = useState<RadioSelectItem<string>[]>([]);
  const [overrideModelsLoading, setOverrideModelsLoading] = useState(false);

  const [languageInput, setLanguageInput] = useState(settings.merged.preferredLanguage || '');

  // 🆕 当进入子菜单前记录当前选择，返回时恢复
  const handleEnterSubMenu = (subMenu: MenuView, selectedValue: string) => {
    setLastSelectedBeforeSubMenu(selectedValue);
    setCurrentView(subMenu);
  };
  const [lastSelectedBeforeSubMenu, setLastSelectedBeforeSubMenu] = useState<string>('model');
  const [selectedYolo, setSelectedYolo] = useState<string>(
    config.getApprovalMode() === ApprovalMode.YOLO ? 'on' : 'off'
  );
  const [selectedAgentStyle, setSelectedAgentStyle] = useState<string>(
    config.getAgentStyle()
  );
  const [selectedHealthyUse, setSelectedHealthyUse] = useState<string>(
    config.getHealthyUseEnabled() ? 'on' : 'off'
  );
  const [selectedProjectMemory, setSelectedProjectMemory] = useState<string>(
    settings.merged.projectMemoryMode || 'all'
  );

  const [statusMessage, setStatusMessage] = useState<string>('');

  // 处理主菜单选择
  const handleMainMenuSelect = useCallback(
    async (value: string) => {
      // 🆕 更新 selectedMain 状态，这样菜单光标会跟踪到正确位置
      setSelectedMain(value);

      if (value === 'theme') {
        onOpenTheme();
      } else if (value === 'editor') {
        onOpenEditor();
      } else if (value === 'model') {
        onOpenModel();
      } else if (value === 'vim') {
        // Toggle vim mode
        const newValue = !settings.merged.vimMode;
        settings.setValue(SettingScope.User, 'vimMode', newValue);
        setStatusMessage(newValue ? t('config.status.vim.enabled') : t('config.status.vim.disabled'));
        // 重新渲染主菜单
        setTimeout(() => setStatusMessage(''), 1500);
      } else if (value === 'yolo') {
        handleEnterSubMenu('yolo', value);
      } else if (value === 'agent-style') {
        handleEnterSubMenu('agent-style', value);
      } else if (value === 'healthy-use') {
        handleEnterSubMenu('healthy-use', value);
      } else if (value === 'project-memory') {
        handleEnterSubMenu('project-memory', value);
      } else if (value === 'model-overrides') {
        handleEnterSubMenu('model-overrides', value);
      } else if (value === 'language') {
        setLanguageInput(settings.merged.preferredLanguage || '');
        handleEnterSubMenu('language', value);
      }
    },
    [settings, onOpenTheme, onOpenEditor, onOpenModel, handleEnterSubMenu]
  );

  // 处理 YOLO 模式选择
  const handleYoloSelect = useCallback(
    async (value: string) => {
      setSelectedYolo(value);
      const newMode = value === 'on' ? ApprovalMode.YOLO : ApprovalMode.DEFAULT;
      config.setApprovalModeWithProjectSync(newMode, true);
      setStatusMessage(
        value === 'on'
          ? t('config.status.yolo.enabled')
          : t('config.status.yolo.disabled')
      );
      setTimeout(() => {
        setCurrentView('main');
        setStatusMessage('');
      }, 1000);
    },
    [config]
  );

  // 处理 Agent Style 选择
  const handleAgentStyleSelect = useCallback(
    async (value: string) => {
      setSelectedAgentStyle(value);
      const newStyle = value as AgentStyle;
      config.setAgentStyle(newStyle);

      // Codex 模式自动启用 YOLO
      if (newStyle === 'codex') {
        config.setApprovalModeWithProjectSync(ApprovalMode.YOLO, true);
      }

      const { getCoreSystemPrompt } = await import('deepv-code-core');
      const geminiClient = await config.getGeminiClient();
      if (geminiClient) {
        const chat = geminiClient.getChat();
        if (chat) {
          const isVSCode = config.getVsCodePluginMode();
          const userMemory = config.getUserMemory();
          const updatedSystemPrompt = getCoreSystemPrompt(
            userMemory,
            isVSCode,
            undefined,
            newStyle,
            undefined, // modelId
            config.getPreferredLanguage()
          );
          chat.setSystemInstruction(updatedSystemPrompt);
        }
      }

      const yoloNote = newStyle === 'codex' ? t('config.status.agent.style.yolo.note') : '';
      setStatusMessage(
        `${tp('config.status.agent.style.switched', { style: t(`agentStyle.style.${newStyle}.label` as any) })}${yoloNote}`
      );
      setTimeout(() => {
        setCurrentView('main');
        setStatusMessage('');
      }, 1000);
    },
    [config]
  );

  // 处理 Healthy Use 选择
  const handleHealthyUseSelect = useCallback(
    async (value: string) => {
      setSelectedHealthyUse(value);
      settings.setValue(SettingScope.User, 'healthyUse', value === 'on');
      (config as any).healthyUse = value === 'on';

      setStatusMessage(
        value === 'on'
          ? t('config.status.healthy.use.enabled')
          : t('config.status.healthy.use.disabled')
      );
      setTimeout(() => {
        setCurrentView('main');
        setStatusMessage('');
      }, 1000);
    },
    [settings, config]
  );

  // 处理 Project Memory Mode 选择
  const handleProjectMemorySelect = useCallback(
    async (value: string) => {
      setSelectedProjectMemory(value);
      const newMode = value as 'all' | 'deepv-only' | 'none';
      settings.setValue(SettingScope.Workspace, 'projectMemoryMode', newMode);

      const modeLabel = (() => {
        switch (newMode) {
          case 'deepv-only': return t('config.value.project.memory.deepvOnly');
          case 'none': return t('config.value.project.memory.none');
          default: return t('config.value.project.memory.all');
        }
      })();
      setStatusMessage(tp('config.status.project.memory.updated', { mode: modeLabel }));

      // Reload memory to apply the new mode immediately
      if (onReloadMemory) {
        await onReloadMemory();
      }

      setTimeout(() => {
        setCurrentView('main');
        setStatusMessage('');
      }, 1000);
    },
    [settings, onReloadMemory]
  );

  // 进入某个模型覆盖目标的选择器：异步加载可选模型列表
  const handleSelectOverrideTarget = useCallback(
    async (value: string) => {
      const targetKey = value as ModelOverrideKey;
      setSelectedOverrideTarget(targetKey);
      setCurrentView('model-override-picker');
      setOverrideModelsLoading(true);
      setOverrideModelItems([]);

      try {
        const { modelNames } = await getAvailableModels(settings, config);

        // 首项：恢复默认（压缩 → 自动管理，子代理 → 继承会话模型）
        const defaultItem: RadioSelectItem<string> = {
          label:
            targetKey === 'compression'
              ? t('config.option.modelOverrides.useDefault')
              : t('config.option.modelOverrides.inherit'),
          value: '__default__',
        };

        const modelItems: RadioSelectItem<string>[] = modelNames.map((name) => ({
          label: getModelDisplayName(name, config),
          value: name,
        }));

        setOverrideModelItems([defaultItem, ...modelItems]);
      } catch (_error) {
        // 加载失败：仅保留"恢复默认"选项
        setOverrideModelItems([
          {
            label:
              targetKey === 'compression'
                ? t('config.option.modelOverrides.useDefault')
                : t('config.option.modelOverrides.inherit'),
            value: '__default__',
          },
        ]);
      } finally {
        setOverrideModelsLoading(false);
      }
    },
    [settings, config]
  );

  // 处理模型覆盖选择（含恢复默认）
  const handleOverrideModelSelect = useCallback(
    async (value: string) => {
      const targetKey = selectedOverrideTarget;
      const next: ModelOverrides = { ...overrides };

      if (value === '__default__') {
        delete next[targetKey];
      } else {
        next[targetKey] = value;
      }

      setOverrides(next);
      // 持久化到用户级 settings.json，并同步到运行中的 Config 立即生效
      settings.setValue(SettingScope.User, 'modelOverrides', next);
      config.setModelOverrides(next);

      const targetLabel = t(`config.option.modelOverrides.${targetKey}` as any);
      setStatusMessage(
        value === '__default__'
          ? tp('config.status.modelOverrides.cleared', { target: targetLabel })
          : tp('config.status.modelOverrides.updated', {
              target: targetLabel,
              model: getModelDisplayName(value, config),
            })
      );

      setTimeout(() => {
        setCurrentView('model-overrides');
        setStatusMessage('');
      }, 1000);
    },
    [selectedOverrideTarget, overrides, settings, config]
  );

  // 处理语言提交
  const handleLanguageSubmit = useCallback(
    async (value: string) => {
      const normalizedValue = value.trim();
      settings.setValue(SettingScope.User, 'preferredLanguage', normalizedValue || undefined);

      // 刷新 system prompt 以立即生效
      const geminiClient = await config.getGeminiClient();
      if (geminiClient) {
        const chat = geminiClient.getChat();
        if (chat) {
          const isVSCode = config.getVsCodePluginMode();
          const userMemory = config.getUserMemory();
          const agentStyle = config.getAgentStyle();
          const updatedSystemPrompt = getCoreSystemPrompt(
            userMemory,
            isVSCode,
            undefined,
            agentStyle,
            undefined,
            normalizedValue || undefined
          );
          chat.setSystemInstruction(updatedSystemPrompt);
        }
      }

      setStatusMessage(
        normalizedValue
          ? tp('config.status.language.updated', { language: normalizedValue })
          : t('config.status.language.cleared')
      );

      setTimeout(() => {
        setCurrentView('main');
        setStatusMessage('');
      }, 1000);
    },
    [settings, config]
  );

  // 处理键盘输入
  useInput((input, key) => {
    if (currentView === 'language') {
      if (key.return) {
        handleLanguageSubmit(languageInput);
        return;
      }
      if (key.backspace || key.delete) {
        setLanguageInput(prev => prev.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta && !key.escape && !key.tab) {
        setLanguageInput(prev => prev + input);
        return;
      }
    }

    // Only handle ESC here, let RadioButtonSelect handle Enter/Return/Arrows
    if (key.escape) {
      if (currentView === 'main') {
        onClose();
      } else if (currentView === 'model-override-picker') {
        // 从模型选择器返回到覆盖项列表
        setCurrentView('model-overrides');
      } else {
        // Return to main menu and restore selection
        setSelectedMain(lastSelectedBeforeSubMenu);
        setCurrentView('main');
      }
    }
  });

  const dialogWidth = Math.min(terminalWidth - 4, 60);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={Colors.Gray} padding={1} width={dialogWidth}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold color={Colors.AccentBlue}>
          {t('config.menu.title')}
        </Text>
      </Box>

      {/* Main Menu */}
      {currentView === 'main' && (
        <Box flexDirection="column" marginBottom={1}>
          <RadioButtonSelect<string>
            items={menuItems}
            onSelect={handleMainMenuSelect}
            isFocused
            initialIndex={menuItems.findIndex(item => item.value === selectedMain)}
          />
        </Box>
      )}

      {/* YOLO Mode Menu */}
      {currentView === 'yolo' && (
        <Box flexDirection="column" marginBottom={1}>
          <Box marginBottom={1}>
            <Text color={Colors.AccentCyan}>
              {t('config.submenu.yolo.title')}
            </Text>
          </Box>
          <RadioButtonSelect<string>
            items={yoloModeItems}
            onSelect={handleYoloSelect}
            isFocused
            initialIndex={yoloModeItems.findIndex(item => item.value === selectedYolo)}
          />
          <Box marginTop={1}>
            <Text color={Colors.Foreground}>
              {t('config.hint.press.esc')}
            </Text>
          </Box>
        </Box>
      )}

      {/* Agent Style Menu */}
      {currentView === 'agent-style' && (
        <Box flexDirection="column" marginBottom={1}>
          <Box marginBottom={1}>
            <Text color={Colors.AccentCyan}>
              {t('config.submenu.agent.style.title')}
            </Text>
          </Box>
          <RadioButtonSelect<string>
            items={agentStyleItems}
            onSelect={handleAgentStyleSelect}
            isFocused
            initialIndex={agentStyleItems.findIndex(item => item.value === selectedAgentStyle)}
          />
          <Box marginTop={1}>
            <Text color={Colors.Foreground}>
              {t('config.hint.press.esc')}
            </Text>
          </Box>
        </Box>
      )}

      {/* Healthy Use Menu */}
      {currentView === 'healthy-use' && (
        <Box flexDirection="column" marginBottom={1}>
          <Box marginBottom={1}>
            <Text color={Colors.AccentCyan}>
              {t('config.submenu.healthy.use.title')}
            </Text>
          </Box>
          <RadioButtonSelect<string>
            items={healthyUseItems}
            onSelect={handleHealthyUseSelect}
            isFocused
            initialIndex={healthyUseItems.findIndex(item => item.value === selectedHealthyUse)}
          />
          <Box marginTop={1}>
            <Text color={Colors.Foreground}>
              {t('config.hint.press.esc')}
            </Text>
          </Box>
        </Box>
      )}

      {/* Project Memory Mode Menu */}
      {currentView === 'project-memory' && (
        <Box flexDirection="column" marginBottom={1}>
          <Box marginBottom={1}>
            <Text color={Colors.AccentCyan}>
              {t('config.submenu.project.memory.title')}
            </Text>
          </Box>
          <RadioButtonSelect<string>
            items={projectMemoryItems}
            onSelect={handleProjectMemorySelect}
            isFocused
            initialIndex={projectMemoryItems.findIndex(item => item.value === selectedProjectMemory)}
          />
          <Box marginTop={1}>
            <Text color={Colors.Foreground}>
              {t('config.hint.press.esc')}
            </Text>
          </Box>
        </Box>
      )}

      {/* Model Overrides - target list */}
      {currentView === 'model-overrides' && (
        <Box flexDirection="column" marginBottom={1}>
          <Box marginBottom={1}>
            <Text color={Colors.AccentCyan}>
              {t('config.submenu.modelOverrides.title')}
            </Text>
          </Box>
          <RadioButtonSelect<string>
            items={overrideTargetItems}
            onSelect={handleSelectOverrideTarget}
            isFocused
            initialIndex={overrideTargetItems.findIndex(item => item.value === selectedOverrideTarget)}
          />
          <Box marginTop={1}>
            <Text color={Colors.Foreground}>
              {t('config.hint.press.esc')}
            </Text>
          </Box>
        </Box>
      )}

      {/* Model Overrides - model picker */}
      {currentView === 'model-override-picker' && (
        <Box flexDirection="column" marginBottom={1}>
          <Box marginBottom={1}>
            <Text color={Colors.AccentCyan}>
              {t(`config.submenu.modelOverrides.pick.${selectedOverrideTarget}` as any)}
            </Text>
          </Box>
          {overrideModelsLoading ? (
            <Text color={Colors.Gray}>{t('config.hint.modelOverrides.loading')}</Text>
          ) : overrideModelItems.length === 0 ? (
            <Text color={Colors.Gray}>{t('config.hint.modelOverrides.empty')}</Text>
          ) : (
            <RadioButtonSelect<string>
              items={overrideModelItems}
              onSelect={handleOverrideModelSelect}
              isFocused
              initialIndex={Math.max(
                0,
                overrideModelItems.findIndex(
                  item => item.value === (overrides[selectedOverrideTarget] ?? '__default__')
                )
              )}
            />
          )}
          <Box marginTop={1}>
            <Text color={Colors.Foreground}>
              {t('config.hint.press.esc')}
            </Text>
          </Box>
        </Box>
      )}

      {/* Language Input View */}
      {currentView === 'language' && (
        <Box flexDirection="column" marginBottom={1}>
          <Box marginBottom={1}>
            <Text bold color={Colors.AccentCyan}>
              {t('config.submenu.language.title')}
            </Text>
          </Box>

          <Box flexDirection="row" marginBottom={1}>
            <Text color={Colors.AccentCyan}>{'> '}</Text>
            {languageInput ? (
              <Text color={Colors.Foreground}>{languageInput}</Text>
            ) : (
              <Text color={Colors.Gray}>{t('config.hint.language.placeholder')}</Text>
            )}
            <Text backgroundColor={Colors.Gray} color={Colors.Foreground}> </Text>
          </Box>

          <Box flexDirection="column" marginTop={1}>
            <Text color={Colors.Gray}>
              {t('config.hint.language.help')}
            </Text>
            <Text color={Colors.Gray}>
              {t('config.hint.confirm.cancel')}
            </Text>
          </Box>
        </Box>
      )}

      {/* Status Message */}
      {statusMessage && (
        <Box marginTop={1}>
          <Text color={Colors.AccentGreen}>{statusMessage}</Text>
        </Box>
      )}

      {/* Footer */}
      <Box marginTop={1} justifyContent="space-between">
        <Text color={Colors.Gray}>
          {currentView === 'main'
            ? t('config.hint.navigate')
            : t('config.hint.back')}
        </Text>
      </Box>
    </Box>
  );
});
