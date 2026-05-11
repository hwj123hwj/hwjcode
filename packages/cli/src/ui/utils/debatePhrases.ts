/**
 * @license
 * Copyright 2026 DeepV Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Debate mediator phrases.
 *
 * The mediator is injected as a user-role message between rounds. Its job is
 * to mimic the human host nudging the next model to speak. Since the system
 * already injects `[Model switched from X to Y]` into history on each switch,
 * the mediator phrases deliberately do NOT name models — keeping them short,
 * natural, and close to how a real user would nudge ("换你了，刚才那个说的对吗").
 */

const OPENING_PHRASES: string[] = [
  '咱们聊个事：{topic}。你先说说看。',
  '有个问题想让你看看：{topic}',
  '{topic}。你怎么看？',
  '来帮我分析下：{topic}',
  '{topic}，你先表个态。',
];

const FOLLOWUP_PHRASES: string[] = [
  '刚才那个模型说的对吗？',
  '现在换你了，你同意上面的说法吗？',
  '换你了，你觉得刚才说的对吗？',
  '你同意吗？说说你的看法。',
  '你怎么看刚才那段？',
  '换你说说，刚才那个说得对不对？',
  '接着说，你觉得上面说的有道理吗？',
  '现在轮到你了，刚才那个你认可吗？',
  '该你了，上面说得对吗？',
  '你呢？刚才那位的观点你买账吗？',
];

function pickRandom<T>(pool: readonly T[]): T {
  return pool[Math.floor(Math.random() * pool.length)]!;
}

/**
 * Pick an opening phrase for the first speaker of a debate.
 * The placeholder `{topic}` is replaced with the provided topic string.
 */
export function pickOpening(topic: string): string {
  const template = pickRandom(OPENING_PHRASES);
  return template.replace('{topic}', topic);
}

/**
 * Pick a follow-up phrase for any speaker after the first.
 * Does not reference the previous model by name — the system-injected
 * `[Model switched from X to Y]` message already provides that context.
 */
export function pickFollowup(): string {
  return pickRandom(FOLLOWUP_PHRASES);
}
