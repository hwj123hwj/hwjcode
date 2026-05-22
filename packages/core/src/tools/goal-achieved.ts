/**
 * @license
 * Copyright 2026 DeepV Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Type } from '@google/genai';
import { BaseTool, Icon, ToolResult } from './tools.js';
import { Config } from '../config/config.js';
import { SchemaValidator } from '../utils/schemaValidator.js';

/**
 * Parameters for the GoalAchievedTool.
 */
export interface GoalAchievedParams {
  /**
   * Required justification for declaring the goal achieved. This is the
   * model's structured commitment — it must articulate WHY the criteria
   * are objectively met. The reason becomes part of the conversation
   * record so the user can audit the decision after the fact.
   *
   * No length floor is enforced (per design discussion: a length floor
   * doesn't guarantee quality and adds friction); content is trusted.
   */
  reason: string;
}

/**
 * GoalAchievedTool — explicit "I'm done" signal for /goal mode.
 *
 * Why this tool exists:
 *   /goal mode is governed by a contract: the model must keep working
 *   until criteria are objectively met (or the minimum-hours floor is
 *   reached, whichever finish-condition applies). Without a structured
 *   way to declare completion, two failure modes appear:
 *
 *     1. The model says "task done" in prose but the bottom-bar goal
 *        indicator keeps ticking — the user can't tell whether the
 *        agent really finished or just paused. (See user issue
 *        2026-05-22 about indicator state during stalls/completions.)
 *
 *     2. Tempted by "context anxiety", the model wraps up early with
 *        vague phrasing — exactly the failure /goal was built to prevent.
 *
 *   A tool call is the cleanest fix: it's structured (not a phrase to
 *   keyword-match), it's auditable (the reason is recorded), and it
 *   forces the model to *commit* to a justification before the system
 *   accepts the completion signal. If the model can't articulate why
 *   criteria are met, it shouldn't be calling this tool.
 *
 * Behavior:
 *   - Side effect: clears `GeminiClient.activeGoalContext`. Subsequent
 *     compressions will not re-inject the original goal prompt.
 *     The bottom-bar goal indicator (CLI) flips off within ~1s
 *     (useGoalActive heartbeat).
 *
 *   - Idempotent / forgiving: if no active goal context exists (the
 *     user already ran `/goal clear`, or the model called this without
 *     ever being in goal mode), the tool returns a polite
 *     "no active goal" notice rather than erroring. This avoids
 *     destabilizing tool-loop machinery on misuse.
 *
 *   - Allowed any time: the user-confirmed design lets the model call
 *     this even if elapsed < hours floor. Original contract clause A
 *     ("early completion when criteria met") already permitted this;
 *     forcing the model to fake-work until the timer runs would be
 *     worse than trusting its reasoned `reason`.
 *
 *   - No need for a "/goal cancel" twin: by user decision, this tool
 *     only signals positive completion. If the model judges the task
 *     impossible, it should report the obstacle to the user (per
 *     /goal contract clause "遇阻立即换路线、绝不停摆") and let the
 *     user decide whether to `/goal clear`.
 *
 * Display:
 *   - llmContent: structured echo back to the model so it knows the
 *     contract is released and may now switch into normal-conversation
 *     posture. Avoids the model continuing to push the goal agenda.
 *   - returnDisplay: human-readable "✓ Goal achieved — {reason}" line
 *     for the chat history.
 *   - summary: short label for the tool-call status row.
 */
export class GoalAchievedTool extends BaseTool<GoalAchievedParams, ToolResult> {
  static readonly Name: string = 'goal_achieved';

  constructor(private readonly config: Config) {
    super(
      GoalAchievedTool.Name,
      'GoalAchieved',
      'Declare that the current /goal-mode task is complete and exit goal mode. Call this tool ONLY after the goal\'s "达标特征 / completion criteria" are objectively satisfied. The required `reason` parameter must articulate WHY each criterion is met — be specific (cite files, test results, behaviors observed); vague reasons like "done" or "looks good" defeat the purpose. After this tool returns, the goal contract is released: the minimum-hours floor and no-stop discipline no longer apply, and subsequent context compressions will not re-inject the original goal prompt. System safety rails (no rm -rf, no PowerShell, etc.) remain in effect — those are independent of goal mode. If you are NOT currently in /goal mode, do not call this tool. If the task seems impossible to complete, do NOT call this tool either; instead, report the obstacle to the user per the contract\'s "遇阻立即换路线" discipline and let the user decide whether to /goal clear.',
      Icon.Info,
      {
        type: Type.OBJECT,
        properties: {
          reason: {
            type: Type.STRING,
            description:
              'Required justification. Explain concretely why each completion criterion from the original /goal prompt is now objectively satisfied (cite files changed, tests passing, behaviors observed, etc.). This text is recorded in the conversation history for user audit. Vague reasons like "done", "complete", or "looks good" are insufficient and indicate you should NOT be calling this tool yet.',
          },
        },
        required: ['reason'],
      },
    );
  }

  validateToolParams(params: GoalAchievedParams): string | null {
    const errors = SchemaValidator.validate(
      this.schema.parameters,
      params,
      GoalAchievedTool.Name,
    );
    if (errors) {
      return errors;
    }
    if (
      typeof params.reason !== 'string' ||
      params.reason.trim() === ''
    ) {
      return 'Parameter "reason" must be a non-empty string explaining why the goal is complete.';
    }
    return null;
  }

  getDescription(params: GoalAchievedParams): string {
    // Truncate the reason for the tool-call status row to keep the UI tidy;
    // the full reason is preserved in returnDisplay below.
    const r = (params.reason ?? '').trim();
    const short = r.length > 60 ? `${r.slice(0, 60)}…` : r;
    return `Mark goal achieved: ${short}`;
  }

  async execute(
    params: GoalAchievedParams,
    _signal: AbortSignal,
  ): Promise<ToolResult> {
    const validationError = this.validateToolParams(params);
    if (validationError) {
      return {
        llmContent: `Error: Invalid parameters provided. Reason: ${validationError}`,
        returnDisplay: `Parameter validation failed: ${validationError}`,
      };
    }

    const reason = params.reason.trim();

    // Side effect — clear the goal context. Wrap defensively: a
    // completion signal MUST NOT fail just because we couldn't reach
    // the client (which would leave the indicator ticking forever
    // and re-trigger compression injection). Worst case, log and proceed.
    let hadActiveGoal = false;
    try {
      const client = this.config.getGeminiClient();
      if (client) {
        hadActiveGoal = !!client.getGoalContext();
        if (hadActiveGoal) {
          client.clearGoalContext();
        }
      }
    } catch {
      // Swallow — clearing is a best-effort cleanup. The model already
      // declared completion; surfacing this as an error to the model
      // would just confuse it.
    }

    // Build response. Two distinct messages:
    //   - llmContent: machine-readable, tells the model what just happened
    //     and how it should behave next. Strongly worded "you are no
    //     longer under contract" prevents it from continuing to push
    //     the goal agenda.
    //   - returnDisplay: human-readable confirmation.
    if (!hadActiveGoal) {
      // Model called this without an active goal — graceful no-op so we
      // don't destabilize the tool loop. Tell the model not to do this
      // again, but keep the response structure consistent.
      const noGoalMsg =
        '[goal_achieved] No active /goal mode was detected; this tool has no effect outside goal mode. ' +
        'Continue normal operation. If you intended to declare some other kind of task complete, ' +
        'simply state it in prose — the goal_achieved tool is exclusively for /goal-mode contracts.';
      return {
        llmContent: noGoalMsg,
        returnDisplay: '⚠ goal_achieved called outside /goal mode — ignored.',
        summary: 'no active goal',
      };
    }

    const llmAck =
      `[goal_achieved] Goal contract released. Reason recorded: ${reason}\n\n` +
      `From this point onward:\n` +
      `- The minimum-hours floor no longer applies.\n` +
      `- The "no-stop" discipline no longer applies.\n` +
      `- Subsequent context compressions will not re-inject the original goal prompt.\n` +
      `- System safety rails (no rm -rf, no PowerShell, no batch-kill of node processes, etc.) STAY ON — those are independent of goal mode.\n\n` +
      `Switch into normal conversational posture. Do not produce an unrequested wrap-up summary; the user can ask for one if they want it. Wait for the user's next instruction.`;

    return {
      llmContent: llmAck,
      // Structured display: both CLI and webview special-case this `type`
      // discriminator to render a readable bordered card (reason preserved
      // as multi-line text). Pattern: same as TodoDisplay / SubAgentDisplay.
      // The "no active goal" branch above intentionally stays a plain
      // warning string — it's a misuse signal, not a celebration.
      returnDisplay: { type: 'goal_achieved_display', reason },
      summary: 'goal achieved',
    };
  }
}
