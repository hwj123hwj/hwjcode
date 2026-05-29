/**
 * @license
 * Copyright 2026 DeepV Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { Colors } from '../colors.js';

export interface EffortWizardProps {
  currentEffort?: string;
  onSelect: (level: string | undefined) => void;
  terminalWidth?: number;
}

export function EffortWizard({
  currentEffort = 'auto',
  onSelect,
  terminalWidth = 80,
}: EffortWizardProps): React.JSX.Element {
  const options = [
    { level: 'low', label: 'low', desc: 'minimal thinking / low cost' },
    { level: 'medium', label: 'medium', desc: 'balanced speed & intelligence' },
    { level: 'high', label: 'high', desc: 'deep reasoning for complex problems' },
    { level: 'xhigh', label: 'xhigh', desc: 'extended reasoning for hard bugs' },
    { level: 'max', label: 'max', desc: 'maximum reasoning capacity' },
    { level: 'ultracode', label: 'ultracode', desc: 'xhigh & workflows' },
  ];

  // 寻找初始选中的索引
  const initialIndex = options.findIndex((opt) => opt.level === currentEffort);
  const [selectedIndex, setSelectedIndex] = useState(initialIndex >= 0 ? initialIndex : 1); // 默认中强度

  // 键盘事件处理
  useInput((input, key) => {
    if (key.leftArrow || input === 'h' || input === '<') {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
    } else if (key.rightArrow || input === 'l' || input === '>') {
      setSelectedIndex((prev) => Math.min(options.length - 1, prev + 1));
    } else if (key.return) {
      onSelect(options[selectedIndex].level);
    } else if (key.escape) {
      onSelect(undefined);
    }
  });

  const labelCenters = [2, 11, 22, 33, 44, 51];

  // 渲染 Slider 轨道
  const renderTrack = () => {
    const trackElements: React.JSX.Element[] = [];
    trackElements.push(
      <Text key="left" color={Colors.Gray}>
        &lt;
      </Text>,
    );

    for (let i = 1; i <= 53; i++) {
      const isSelectedCenter = i === labelCenters[selectedIndex];
      const isCenter = labelCenters.includes(i);
      const isPassed = i < labelCenters[selectedIndex];

      if (isSelectedCenter) {
        trackElements.push(
          <Text key={i} color={Colors.AccentPurple} bold>
            ●
          </Text>,
        );
      } else if (isCenter) {
        trackElements.push(
          <Text key={i} color={isPassed ? Colors.AccentPurple : Colors.Gray}>
            ┼
          </Text>,
        );
      } else {
        trackElements.push(
          <Text key={i} color={isPassed ? Colors.AccentPurple : Colors.Gray}>
            ─
          </Text>,
        );
      }
    }

    trackElements.push(
      <Text key="right" color={Colors.Gray}>
        &gt;
      </Text>,
    );
    return trackElements;
  };

  // 渲染对齐的文本标签（选中项带紫色背景）
  const renderLabels = () => {
    const labelRow: Array<{ char: string; isSelected: boolean } | null> = Array(55).fill(null);

    options.forEach((opt, idx) => {
      const center = labelCenters[idx];
      const start = center - Math.floor(opt.label.length / 2);
      for (let i = 0; i < opt.label.length; i++) {
        const targetIdx = start + i;
        if (targetIdx >= 0 && targetIdx < 55) {
          labelRow[targetIdx] = {
            char: opt.label[i],
            isSelected: idx === selectedIndex,
          };
        }
      }
    });

    return (
      <Box flexDirection="row" width={55}>
        {labelRow.map((item, idx) => {
          if (!item) {
            return <Text key={idx}> </Text>;
          }
          if (item.isSelected) {
            return (
              <Text key={idx} backgroundColor={Colors.AccentPurple} color="#ffffff" bold>
                {item.char}
              </Text>
            );
          }
          return (
            <Text key={idx} color={Colors.Gray}>
              {item.char}
            </Text>
          );
        })}
      </Box>
    );
  };

  // 渲染对齐的描述
  const renderDescription = () => {
    const descText = options[selectedIndex].desc;
    const center = labelCenters[selectedIndex];
    const leftPadding = Math.max(
      0,
      Math.min(55 - descText.length, center - Math.floor(descText.length / 2)),
    );
    return (
      <Box width={55}>
        <Text color={Colors.AccentPurple} bold>
          {' '.repeat(leftPadding) + descText}
        </Text>
      </Box>
    );
  };

  return (
    <Box flexDirection="column" marginY={1} paddingX={2}>
      <Box marginBottom={1}>
        <Text bold color={Colors.Foreground}>
          Effort
        </Text>
      </Box>

      <Box width={55} justifyContent="space-between" marginBottom={1}>
        <Text color={Colors.Gray}>Faster</Text>
        <Text color={Colors.Gray}>Smarter</Text>
      </Box>

      <Box flexDirection="row" width={55} marginBottom={1}>
        {renderTrack()}
      </Box>

      <Box marginBottom={1}>{renderLabels()}</Box>

      <Box marginBottom={1}>{renderDescription()}</Box>

      <Box marginTop={1}>
        <Text color={Colors.Gray}>
          &lt;/&gt; to adjust · Enter to confirm · Esc to cancel
        </Text>
      </Box>
    </Box>
  );
}
