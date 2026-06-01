/**
 * @license
 * Copyright 2025 DeepV Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { MessageType } from '../types.js';
import { type CommandContext, type SlashCommand, CommandKind } from './types.js';

/**
 * In-memory store for the current session's workflow runs.
 * Keyed by workflow ID (timestamp-based).
 */
interface WorkflowRunRecord {
  id: string;
  description: string;
  status: 'running' | 'completed' | 'failed';
  startTime: number;
  endTime?: number;
  tokenUsage?: { inputTokens: number; outputTokens: number; totalTokens: number };
}

const workflowHistory: WorkflowRunRecord[] = [];

/**
 * Register a workflow run start. Called externally from WorkflowTool if needed,
 * but primarily serves the /workflow command's status display.
 */
export function recordWorkflowStart(id: string, description: string): void {
  workflowHistory.push({ id, description, status: 'running', startTime: Date.now() });
}

export function recordWorkflowEnd(
  id: string,
  status: 'completed' | 'failed',
  tokenUsage?: WorkflowRunRecord['tokenUsage'],
): void {
  const record = workflowHistory.find(r => r.id === id);
  if (record) {
    record.status = status;
    record.endTime = Date.now();
    record.tokenUsage = tokenUsage;
  }
}

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds % 60}s`;
}

function buildStatusText(records: WorkflowRunRecord[]): string {
  if (records.length === 0) {
    return 'No workflows have run in this session.';
  }

  const lines: string[] = ['**Workflow runs this session:**', ''];
  for (const r of records) {
    const icon = r.status === 'completed' ? '✅' : r.status === 'failed' ? '❌' : '⏳';
    const duration = r.endTime
      ? formatDurationMs(r.endTime - r.startTime)
      : `running for ${formatDurationMs(Date.now() - r.startTime)}`;
    const tokens = r.tokenUsage ? ` · ${r.tokenUsage.totalTokens.toLocaleString()} tokens` : '';
    lines.push(`${icon} **${r.description}** — ${r.status} (${duration}${tokens})`);
  }
  return lines.join('\n');
}

export const workflowCommand: SlashCommand = {
  name: 'workflow',
  altNames: ['wf'],
  description: 'Show workflow run status for this session. Workflows are triggered by including "workflow" in your prompt.',
  kind: CommandKind.BUILT_IN,
  action: (context: CommandContext, args?: string) => {
    const sub = args?.trim().toLowerCase();

    if (!sub || sub === 'status' || sub === 'list') {
      const text = buildStatusText(workflowHistory);
      context.ui.addItem({ type: MessageType.INFO, text }, Date.now());
      return;
    }

    if (sub === 'clear') {
      workflowHistory.length = 0;
      context.ui.addItem(
        { type: MessageType.INFO, text: 'Workflow history cleared.' },
        Date.now(),
      );
      return;
    }

    if (sub === 'help') {
      context.ui.addItem(
        {
          type: MessageType.INFO,
          text: [
            '**`/workflow` — Dynamic Workflow Tracker**',
            '',
            'Subcommands:',
            '  `/workflow` or `/workflow status` — show all workflow runs this session',
            '  `/workflow clear`                 — clear run history',
            '  `/workflow help`                  — show this help',
            '',
            '**How to trigger a workflow:**',
            'Include "workflow" in your prompt, e.g.:',
            '  *"Run a workflow to audit all authentication code for vulnerabilities"*',
            '',
            'The AI will generate a JavaScript orchestration script that coordinates',
            'multiple parallel sub-agents to complete the task.',
          ].join('\n'),
        },
        Date.now(),
      );
      return;
    }

    context.ui.addItem(
      {
        type: MessageType.ERROR,
        text: `Unknown subcommand: "${sub}". Try \`/workflow help\`.`,
      },
      Date.now(),
    );
  },
  subCommands: [
    {
      name: 'status',
      description: 'Show workflow run history for this session',
      kind: CommandKind.BUILT_IN,
      action: (context: CommandContext) => {
        context.ui.addItem({ type: MessageType.INFO, text: buildStatusText(workflowHistory) }, Date.now());
      },
    },
    {
      name: 'clear',
      description: 'Clear workflow run history',
      kind: CommandKind.BUILT_IN,
      action: (context: CommandContext) => {
        workflowHistory.length = 0;
        context.ui.addItem({ type: MessageType.INFO, text: 'Workflow history cleared.' }, Date.now());
      },
    },
    {
      name: 'help',
      description: 'Show workflow command help',
      kind: CommandKind.BUILT_IN,
      action: (context: CommandContext) => {
        context.ui.addItem(
          {
            type: MessageType.INFO,
            text: [
              '**`/workflow` — Dynamic Workflow Tracker**',
              '',
              'Subcommands:',
              '  `/workflow` or `/workflow status` — show all workflow runs this session',
              '  `/workflow clear`                 — clear run history',
              '  `/workflow help`                  — show this help',
              '',
              '**How to trigger a workflow:**',
              'Include "workflow" in your prompt, e.g.:',
              '  *"Run a workflow to audit all authentication code for vulnerabilities"*',
              '',
              'The AI will generate a JavaScript orchestration script that coordinates',
              'multiple parallel sub-agents to complete the task.',
            ].join('\n'),
          },
          Date.now(),
        );
      },
    },
  ],
};
