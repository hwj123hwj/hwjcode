import type { AgentKind } from '@shared/ipc';
import { Icon } from './Icon';
import claudeImg from '../../../public/claude.webp';
import codexImg from '../../../public/codex.webp';
import claudeLoadingVideo from '../../../public/claude-icon-loading-animation.mp4';

/** Brand artwork for the external agents; easy-code falls back to the glyph. */
const AGENT_IMG: Partial<Record<AgentKind, string>> = {
  'claude-code': claudeImg,
  codex: codexImg,
};

/**
 * Animated loading artwork, shown in place of the static brand icon while the
 * agent is working (see `animated` below). Only Claude Code ships one; agents
 * without an entry fall back to their static `AGENT_IMG`.
 */
const AGENT_LOADING_VIDEO: Partial<Record<AgentKind, string>> = {
  'claude-code': claudeLoadingVideo,
};

const ICON_STYLE = {
  borderRadius: 4,
  objectFit: 'contain',
  display: 'inline-block',
  verticalAlign: 'middle',
  flexShrink: 0,
} as const;

/**
 * Renders an agent's brand icon: the supplied .webp for Claude Code / Codex, or
 * the built-in sparkle glyph for the bundled Easy Code backend. Sized to match
 * the surrounding `<Icon>` usages so it drops into chips/badges cleanly.
 *
 * When `animated` is set (e.g. the "waiting for response" indicator), agents
 * with a loading video play it instead of the static icon; others keep the
 * static artwork.
 */
export function AgentIcon({
  agent,
  size = 14,
  className,
  animated = false,
}: {
  agent: AgentKind;
  size?: number;
  className?: string;
  animated?: boolean;
}) {
  const video = animated ? AGENT_LOADING_VIDEO[agent] : undefined;
  if (video) {
    return (
      <video
        src={video}
        width={size}
        height={size}
        autoPlay
        loop
        muted
        playsInline
        className={className}
        style={ICON_STYLE}
      />
    );
  }
  const img = AGENT_IMG[agent];
  if (!img) return <Icon name="sparkle" size={size} className={className} />;
  return (
    <img
      src={img}
      alt=""
      width={size}
      height={size}
      className={className}
      style={ICON_STYLE}
    />
  );
}
