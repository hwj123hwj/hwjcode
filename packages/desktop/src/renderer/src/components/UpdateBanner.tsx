/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Non-intrusive version-update toast, anchored bottom-right. It renders only
 * when there is something actionable (an available / downloading / downloaded
 * update, or an error from a *manual* check). The whole flow lives here:
 * available → download (with progress + cancel) → install. The user can always
 * snooze ("later", this run) or permanently skip the version.
 *
 * While downloading, the user can *minimize* the card into a small floating
 * progress pill (bottom-right) so the corner stays out of the way and they can
 * keep working — the download keeps running in the background. We auto-expand
 * again the moment something needs the user's attention (download finished and
 * ready to install, install/restart starting, or an error).
 */

import { useEffect, useState, type CSSProperties } from 'react';
import { useStore } from '../store';
import { Icon } from './Icon';
import { useT } from '../i18n/useT';

/** Human-readable byte size, e.g. 12.3 MB. */
function fmtBytes(n: number): string {
  if (!n || n < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function UpdateBanner() {
  const t = useT();
  const update = useStore((s) => s.update);
  const check = useStore((s) => s.checkUpdate);
  const download = useStore((s) => s.downloadUpdate);
  const cancel = useStore((s) => s.cancelUpdateDownload);
  const install = useStore((s) => s.installUpdate);
  const skip = useStore((s) => s.skipUpdate);
  const snooze = useStore((s) => s.snoozeUpdate);

  // UI-only: collapsed into the floating progress pill. Minimizing is offered
  // only while downloading; any later phase needs attention, so we expand back.
  const [minimized, setMinimized] = useState(false);
  const phase = update?.phase;
  useEffect(() => {
    if (phase !== 'downloading') setMinimized(false);
  }, [phase]);

  if (!update || !update.supported) return null;
  const { info, progress, skipped, snoozed } = update;

  // Nothing to show while idle/checking, or once the user dismissed this version.
  const errorFromManual = phase === 'error' && !!update.error;
  const actionable =
    phase === 'available' ||
    phase === 'downloading' ||
    phase === 'downloaded' ||
    phase === 'installing' ||
    errorFromManual;
  if (!actionable || skipped || snoozed) return null;
  if (phase !== 'error' && !info) return null;

  const version = info?.version ?? '';

  // Minimized: a tiny floating pill that keeps showing download progress and
  // expands back to the full card on click. Only reachable while downloading.
  if (minimized && phase === 'downloading') {
    const pct = progress && progress.percent >= 0 ? progress.percent : -1;
    return (
      <button
        className="update-pill"
        title={t('update.expand')}
        aria-label={t('update.expand')}
        onClick={() => setMinimized(false)}
      >
        <span
          className={`update-pill-ring${pct < 0 ? ' indeterminate' : ''}`}
          style={pct >= 0 ? ({ ['--p']: pct } as CSSProperties) : undefined}
        >
          <Icon name={pct < 0 ? 'loader' : 'sparkle'} size={12} />
        </span>
        <span className="update-pill-pct">{pct >= 0 ? `${pct}%` : t('update.downloading')}</span>
      </button>
    );
  }

  return (
    <div className="update-toast" role="status">
      <div className="update-toast-head">
        <span className="update-toast-icon">
          <Icon name={phase === 'error' ? 'alert' : 'sparkle'} size={15} />
        </span>
        <div className="update-toast-titles">
          <div className="update-toast-title">
            {phase === 'error'
              ? t('update.failed')
              : phase === 'downloading'
                ? t('update.downloading')
                : phase === 'downloaded'
                  ? t('update.downloaded')
                  : phase === 'installing'
                    ? t('update.installingTitle')
                    : t('update.available', { version })}
          </div>
          <div className="update-toast-sub">
            {phase === 'error'
              ? update.error
              : phase === 'installing'
                ? t(
                    navigator.userAgent.includes('Windows')
                      ? 'update.installingWin'
                      : 'update.installingMac',
                  )
                : t('update.currentVersion', { version: update.currentVersion })}
          </div>
        </div>
        {/* While downloading, offer minimize (keep going in the background). */}
        {phase === 'downloading' && (
          <button
            className="icon-btn update-toast-x"
            title={t('update.minimize')}
            aria-label={t('update.minimize')}
            onClick={() => setMinimized(true)}
          >
            <Icon name="minimize" size={14} />
          </button>
        )}
        {/* Snooze (this run) is always the lightweight dismiss affordance. */}
        {phase !== 'installing' && (
          <button
            className="icon-btn update-toast-x"
            title={t('update.later')}
            onClick={() => void snooze()}
          >
            <Icon name="x" size={14} />
          </button>
        )}
      </div>

      {phase === 'downloading' && (
        <div className="update-progress">
          <div className="update-progress-track">
            <div
              className={`update-progress-fill${progress && progress.percent < 0 ? ' indeterminate' : ''}`}
              style={progress && progress.percent >= 0 ? { width: `${progress.percent}%` } : undefined}
            />
          </div>
          <div className="update-progress-meta">
            <span>
              {progress && progress.percent >= 0 ? `${progress.percent}%` : ''}{' '}
              {progress ? `${fmtBytes(progress.receivedBytes)} / ${fmtBytes(progress.totalBytes)}` : ''}
            </span>
            <span>{progress ? `${fmtBytes(progress.bytesPerSecond)}/s` : ''}</span>
          </div>
        </div>
      )}

      <div className="update-toast-actions">
        {phase === 'available' && (
          <>
            <button className="btn ghost sm" onClick={() => void skip()}>
              {t('update.skip')}
            </button>
            <button className="btn primary sm" onClick={() => void download()}>
              <Icon name="send" size={13} />
              {t('update.updateNow')}
            </button>
          </>
        )}
        {phase === 'downloading' && (
          <button className="btn ghost sm" onClick={() => void cancel()}>
            {t('common.cancel')}
          </button>
        )}
        {phase === 'downloaded' && (
          <button className="btn primary sm" onClick={() => void install()}>
            <Icon name="check" size={13} />
            {t('update.installNow')}
          </button>
        )}
        {phase === 'error' && (
          <button
            className="btn primary sm"
            onClick={() => void (info ? download() : check(true))}
          >
            <Icon name="refresh" size={13} />
            {t('update.retry')}
          </button>
        )}
      </div>
    </div>
  );
}
