/**
 * @license
 * Copyright 2026 DeepV Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Debate mediator phrases — multilingual support.
 *
 * The mediator is injected as a user-role message between rounds. Its job is
 * to mimic the human host nudging the next model to speak. Since the system
 * already injects `[Model switched from X to Y]` into history on each switch,
 * the mediator phrases deliberately do NOT name models — keeping them short,
 * natural, and close to how a real user would nudge.
 */

// ============================================================================
// CHINESE PHRASES
// ============================================================================

const CHINESE_OPENING_PHRASES: string[] = [
  '咱们聊个事：{topic}。请先调用工具把相关代码读一遍，以你自己的阅读为准，言简意赅说结论，不要来回纠结。',
  '有个问题想让你看看：{topic}。请先读代码，不要凭印象推断，读完直接说你的判断，保持简练。',
  '{topic}。请先用工具读一下相关代码，确认实现细节后给出结论，不准长篇大论。',
  '来帮我分析下：{topic}。必须先调用工具读代码，以实际代码为依据说结论，不要绕圈子。',
  '{topic}，请先把代码读一遍，以你自己的阅读结果为准，言简意赅地说出你的看法。',
];

const CHINESE_FOLLOWUP_PHRASES: string[] = [
  '换你了。不要直接评价上面的说法——先自己调用工具把代码读一遍，以你的阅读为准，言简意赅说结论，不要来回纠结。',
  '现在换你了。请先用工具读代码，确认实现后直接评论对错，不要绕圈子。',
  '该你了。先读代码，不要凭印象推断，读完直接说你同不同意上面的观点，保持简练。',
  '轮到你了。请先独立阅读相关代码，以你自己读到的为准，言简意赅地给出判断。',
  '换你说说。先调用工具看看代码实际怎么写的，再简要评价刚才那段说得对不对。',
  '你来看看。别只依赖上面的描述，自己读一遍代码，然后直接给出结论，不要纠结。',
  '接着说。先用工具读代码，以实际代码为依据，言简意赅地说明你是否同意上面的分析。',
  '现在轮到你了。请先独立阅读代码，不要直接沿用上面的结论，读完后直奔重点。',
  '该你了。调用工具把代码读一遍，以你自己的阅读结果为准，言简意赅地评价。',
  '你呢？先自己读代码，不要被上面的说法带偏，以你读到的实现为准，直接给结论。',
];

// ============================================================================
// ENGLISH PHRASES
// ============================================================================

const ENGLISH_OPENING_PHRASES: string[] = [
  'Let\'s discuss: {topic}. Please call tools to read the relevant code thoroughly. Base your conclusion on your own reading, and keep it concise. Don\'t go in circles.',
  'I have a question for you: {topic}. Read the code first—don\'t speculate. After reading, state your judgment directly and keep it brief.',
  '{topic}. Use tools to read the relevant code and confirm the implementation details before drawing a conclusion. No lengthy explanations.',
  'Help me analyze this: {topic}. You must call tools to read the code first. Base your conclusion on the actual code, not assumptions. Be concise.',
  '{topic}. Read the code thoroughly first, base your response on your own reading, and state your view concisely.',
];

const ENGLISH_FOLLOWUP_PHRASES: string[] = [
  'Your turn. Don\'t just evaluate the previous statement—call tools and read the code independently first. Base your conclusion on your own reading. Keep it concise.',
  'Now it\'s your turn. Read the code with tools first, confirm the implementation, then comment directly on what\'s right or wrong. No rambling.',
  'Your turn. Read the code first—don\'t speculate. After reading, state directly whether you agree with the previous point of view. Stay concise.',
  'Your turn now. Please read the relevant code independently. Base your judgment on what you actually read, and state it concisely.',
  'Go ahead and share. Call tools to see how the code is actually written, then briefly comment on whether the previous statement is correct.',
  'Take a look. Don\'t just rely on the description above—read the code yourself, then state your conclusion directly. No hesitation.',
  'Continue. Use tools to read the code, and base your analysis on the actual code to state concisely whether you agree with the above.',
  'Your turn now. Please read the code independently first. Don\'t just echo the previous conclusion. Get to the point after reading.',
  'Your turn. Call tools and read the code. Base your assessment on your own reading, and comment concisely.',
  'What do you think? Read the code yourself first. Don\'t be swayed by the previous statement. Base your answer on the implementation you actually see, and give a direct conclusion.',
];

// ============================================================================
// PHRASE POOLS BY LANGUAGE
// ============================================================================

interface DebatePhrasesPool {
  opening: readonly string[];
  followup: readonly string[];
}

function getPhrasesPool(language: string): DebatePhrasesPool {
  if (language === 'zh' || language === '中文') {
    return {
      opening: CHINESE_OPENING_PHRASES,
      followup: CHINESE_FOLLOWUP_PHRASES,
    };
  }
  // Default to English for 'en', 'en-US', or any other language
  return {
    opening: ENGLISH_OPENING_PHRASES,
    followup: ENGLISH_FOLLOWUP_PHRASES,
  };
}

function pickRandom<T>(pool: readonly T[]): T {
  return pool[Math.floor(Math.random() * pool.length)]!;
}

/**
 * Pick an opening phrase for the first speaker of a debate.
 * The placeholder `{topic}` is replaced with the provided topic string.
 * Language determines which phrase pool to use.
 */
export function pickOpening(topic: string, language: string = 'en'): string {
  const pool = getPhrasesPool(language);
  const template = pickRandom(pool.opening);
  return template.replace('{topic}', topic);
}

/**
 * Pick a follow-up phrase for any speaker after the first.
 * Does not reference the previous model by name — the system-injected
 * `[Model switched from X to Y]` message already provides that context.
 * Language determines which phrase pool to use.
 */
export function pickFollowup(language: string = 'en'): string {
  const pool = getPhrasesPool(language);
  return pickRandom(pool.followup);
}
