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
 */

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

  if (!update || !update.supported) return null;
  const { phase, info, progress, skipped, snoozed } = update;

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
