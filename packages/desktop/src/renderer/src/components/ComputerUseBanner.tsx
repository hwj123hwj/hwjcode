/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * In-app banner shown while the agent is controlling the real desktop. It is the
 * primary Stop control (the always-on-top overlay window is informational only):
 * pressing Stop aborts any in-flight on-screen action AND cancels the running
 * session so the agent's turn unwinds instead of immediately retrying.
 */

import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { useT } from '../i18n/useT';
import { Icon } from './Icon';
import type { ComputerUseStatus } from '@shared/ipc';

const api = window.easycode;

export function ComputerUseBanner() {
  const t = useT();
  const [status, setStatus] = useState<ComputerUseStatus | null>(null);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const cancel = useStore((s) => s.cancel);

  const stop = async () => {
    await api.computerUse.stop().catch(() => undefined);
    if (activeSessionId) await cancel(activeSessionId).catch(() => undefined);
  };

  useEffect(() => {
    void api.computerUse.status().then(setStatus).catch(() => undefined);
    const offStatus = api.computerUse.onStatus(setStatus);
    // The global Esc hotkey already aborted on-screen actions in main; unwind the
    // session turn too, exactly like pressing Stop.
    const offStop = api.computerUse.onStopRequested(() => {
      if (activeSessionId) void cancel(activeSessionId).catch(() => undefined);
    });
    return () => {
      offStatus();
      offStop();
    };
  }, [activeSessionId, cancel]);

  if (!status?.active) return null;

  return (
    <div className="cu-banner" role="alert">
      <span className="cu-banner-dot" />
      <div className="cu-banner-text">
        <strong>{t('computerUse.bannerActive')}</strong>
        <span>{t('computerUse.bannerHint')}</span>
      </div>
      <button className="cu-banner-stop" onClick={() => void stop()}>
        <Icon name="x" size={14} />
        {t('computerUse.stop')}
      </button>
    </div>
  );
}
