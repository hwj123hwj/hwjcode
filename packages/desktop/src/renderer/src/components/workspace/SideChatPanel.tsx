/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Side chat — a directory-less scratch conversation living in the right sidebar,
 * independent of the main session. It lazily mints a `chat` session on first
 * open and reuses the existing ChatPane + PromptBar against it, so the full
 * streaming/transcript machinery is shared with the main view.
 */

import { useEffect } from 'react';
import { useStore } from '../../store';
import { ChatPane } from '../panes/ChatPane';
import { PromptBar } from '../PromptBar';
import { Icon } from '../Icon';
import { useT } from '../../i18n/useT';

export function SideChatPanel() {
  const sideChatId = useStore((s) => s.workspace.sideChatId);
  const view = useStore((s) => (sideChatId ? s.sessions[sideChatId] : undefined));
  const createChatSession = useStore((s) => s.createChatSession);
  const setSideChatId = useStore((s) => s.setSideChatId);
  const setActive = useStore((s) => s.setActive);
  const focusSession = useStore((s) => s.focusSession);
  const t = useT();

  // Mint (or re-attach) the backing chat session the first time the panel opens.
  // createChatSession makes the new session active (the main-view convention);
  // the side chat must NOT steal the foreground, so we restore whatever was
  // active before. We render the side session directly from its id regardless.
  useEffect(() => {
    if (sideChatId) return;
    let alive = true;
    const prevActive = useStore.getState().activeSessionId;
    void createChatSession()
      .then((id) => {
        if (!alive) return;
        setSideChatId(id);
        if (prevActive) setActive(prevActive);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!sideChatId || !view) {
    return (
      <div className="ws-panel">
        <div className="ws-panel-head">
          <Icon name="split" size={15} />
          <span>{t('sidechat.title')}</span>
        </div>
        <div className="empty">{t('sidechat.starting')}</div>
      </div>
    );
  }

  return (
    <div className="ws-panel sidechat-panel">
      <div className="ws-panel-head">
        <Icon name="split" size={15} />
        <span>{t('sidechat.title')}</span>
        <span className="grow" />
        <button
          className="icon-btn"
          title={t('common.edit')}
          onClick={() => focusSession(view.meta.id)}
        >
          <Icon name="external-link" size={15} />
        </button>
      </div>
      <div className="sidechat-body">
        <ChatPane view={view} />
      </div>
      <PromptBar view={view} />
    </div>
  );
}
