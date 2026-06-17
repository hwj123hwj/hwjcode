/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Version-update manager (main process).
 *
 * The desktop has no electron-updater feed: `electron-builder.yml` declares no
 * `publish` target, so there is no `latest.yml`/`latest-mac.yml`, and the server
 * advertises updates as a plain JSON document with direct installer URLs:
 *
 *   GET https://api-code.deepvlab.ai/api/desktop/version
 *   { "success": true,
 *     "data": {
 *       "mac":     { "version": "1.2.3", "url": "https://…/DeepVCode-1.2.3-mac.dmg" },
 *       "windows": { "version": "1.2.3", "url": "https://…/DeepVCode-1.2.3-win.exe" }
 *     } }
 *
 * So we implement the flow by hand: compare semver against `app.getVersion()`,
 * stream-download the platform installer with progress, then LAUNCH it — there
 * is no in-place patch. macOS mounts the DMG for a manual drag-to-Applications;
 * Windows runs the NSIS installer and quits so it can overwrite the files.
 *
 * "Skip this version" is persisted in `userData/update-state.json` (a
 * desktop-only concern, deliberately NOT the CLI-shared `~/.easycode-user/`).
 * "Later" (snooze) is in-memory only — it lasts until the next launch.
 */

import { app, net, shell } from 'electron';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Readable } from 'node:stream';
import type {
  UpdateCheckResult,
  UpdateInfo,
  UpdatePlatform,
  UpdateState,
} from '../shared/ipc.js';

/** Version manifest endpoint. Overridable via env for staging/QA. */
const VERSION_API =
  process.env['EASYCODE_UPDATE_URL'] ??
  'https://api-code.deepvlab.ai/api/desktop/version';

/** How often to re-check while the app is running (4h). */
const POLL_INTERVAL_MS = 4 * 60 * 60 * 1000;
/** Delay the first check after launch so it never competes with boot. */
const STARTUP_DELAY_MS = 6_000;

export interface UpdaterDeps {
  /** Push the full snapshot to the renderer (debounced state changes). */
  onStatus: (state: UpdateState) => void;
  /** Push streamed download progress to the renderer. */
  onProgress: (state: UpdateState) => void;
}

/** Shape of the version manifest's per-platform entry. */
interface PlatformRelease {
  version: string;
  url: string;
  notes?: string;
}

/** Map the running OS onto the manifest key, or null where we can't self-update. */
function platformKey(): UpdatePlatform | null {
  if (process.platform === 'darwin') return 'mac';
  if (process.platform === 'win32') return 'windows';
  return null; // Linux ships via AppImage; no installer feed here.
}

/**
 * True when `latest` is strictly newer than `current`. Compares the numeric
 * release components only (a `-beta` suffix is ignored), degrading gracefully on
 * malformed input rather than throwing.
 */
export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string) =>
    v
      .trim()
      .replace(/^v/i, '')
      .split('-')[0]
      .split('.')
      .map((n) => parseInt(n, 10) || 0);
  const a = parse(latest);
  const b = parse(current);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

/** Best-effort filename for the downloaded installer, derived from the URL. */
function installerFileName(url: string, version: string): string {
  try {
    const base = path.basename(new URL(url).pathname);
    if (base && /\.(dmg|exe|zip|pkg)$/i.test(base)) return base;
  } catch {
    /* fall through to a synthesized name */
  }
  const ext = process.platform === 'win32' ? 'exe' : 'dmg';
  return `EasyCode-${version}.${ext}`;
}

export class UpdateManager {
  private state: UpdateState;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  /** The in-flight download request, kept so `cancelDownload` can abort it. */
  private activeRequest: ReturnType<typeof net.request> | null = null;
  /** Persisted "skip this version" marker. */
  private skippedVersion: string | undefined;

  constructor(private readonly deps: UpdaterDeps) {
    const supported = platformKey() != null;
    this.skippedVersion = this.readSkipped();
    this.state = {
      phase: 'idle',
      currentVersion: app.getVersion(),
      supported,
    };
  }

  /** Current snapshot (for `update:get-state`). */
  getState(): UpdateState {
    return this.state;
  }

  /** Schedule the startup check + periodic polling. No-op on Linux. */
  start(): void {
    if (!this.state.supported) return;
    setTimeout(() => void this.check(false), STARTUP_DELAY_MS);
    this.pollTimer = setInterval(() => void this.check(false), POLL_INTERVAL_MS);
  }

  dispose(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.activeRequest?.abort();
    this.activeRequest = null;
  }

  // ── checking ──────────────────────────────────────────────────────────────

  /**
   * Hit the version API and update state. `manual` checks (from Settings) ignore
   * a prior skip so the user always sees the truth; automatic checks respect it.
   */
  async check(manual: boolean): Promise<UpdateCheckResult> {
    if (!this.state.supported) {
      return { updateAvailable: false, state: this.state };
    }
    // Don't clobber an active download with a background poll.
    if (this.state.phase === 'downloading') {
      return { updateAvailable: !!this.state.info, state: this.state };
    }

    this.patch({ phase: 'checking', error: undefined });
    try {
      const release = await this.fetchRelease();
      const newer = release && isNewerVersion(release.version, this.state.currentVersion);
      if (!release || !newer) {
        this.patch({ phase: 'idle', info: undefined, snoozed: false });
        return { updateAvailable: false, state: this.state };
      }

      const info: UpdateInfo = {
        version: release.version,
        url: release.url,
        platform: platformKey() as UpdatePlatform,
        notes: release.notes,
      };
      const skipped = !manual && this.skippedVersion === release.version;
      this.patch({
        phase: 'available',
        info,
        skipped,
        // A manual check (or a brand-new version) clears any earlier snooze.
        snoozed: false,
        downloadedPath: undefined,
        progress: undefined,
      });
      return { updateAvailable: !skipped, state: this.state };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // A failed *background* check shouldn't nag — keep prior state but record
      // the error; a manual check surfaces it.
      if (manual) this.patch({ phase: 'error', error: msg });
      else this.patch({ phase: this.state.info ? 'available' : 'idle' });
      return { updateAvailable: false, state: this.state };
    }
  }

  /** GET + parse the version manifest for THIS platform. */
  private async fetchRelease(): Promise<PlatformRelease | null> {
    const key = platformKey();
    if (!key) return null;
    const res = await net.fetch(VERSION_API, { headers: { 'Cache-Control': 'no-cache' } });
    if (!res.ok) throw new Error(`version API HTTP ${res.status}`);
    const body = (await res.json()) as {
      success?: boolean;
      data?: Partial<Record<UpdatePlatform, PlatformRelease>>;
    };
    if (!body || body.success === false || !body.data) return null;
    const entry = body.data[key];
    if (!entry || typeof entry.version !== 'string' || typeof entry.url !== 'string') {
      return null;
    }
    return { version: entry.version, url: entry.url, notes: entry.notes };
  }

  // ── downloading ─────────────────────────────────────────────────────────

  /** Stream the installer to a temp folder, emitting progress as it lands. */
  download(): Promise<UpdateState> {
    return new Promise((resolve) => {
      const info = this.state.info;
      if (!info) {
        this.patch({ phase: 'error', error: 'No update available to download.' });
        return resolve(this.state);
      }
      if (this.state.phase === 'downloading') return resolve(this.state);

      const dir = path.join(app.getPath('temp'), 'EasyCode-Updates');
      fs.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, installerFileName(info.url, info.version));
      // A leftover from an aborted prior run would corrupt the new download.
      try {
        fs.rmSync(dest, { force: true });
      } catch {
        /* best-effort */
      }

      this.patch({
        phase: 'downloading',
        error: undefined,
        progress: { receivedBytes: 0, totalBytes: 0, percent: -1, bytesPerSecond: 0 },
      });

      const request = net.request({ url: info.url, redirect: 'follow' });
      this.activeRequest = request;
      const started = Date.now();
      let file: fs.WriteStream | null = null;
      // Single-settle guard: 'finish', 'abort', and 'error' can all race; only
      // the first one to fire resolves the promise and patches state.
      let settled = false;

      const settle = (next: Partial<UpdateState>) => {
        if (settled) return;
        settled = true;
        this.activeRequest = null;
        this.patch(next);
        resolve(this.state);
      };
      const fail = (msg: string) => {
        file?.destroy();
        try {
          fs.rmSync(dest, { force: true });
        } catch {
          /* best-effort */
        }
        // An explicit cancel rolls back to `available`; a real error surfaces.
        settle(
          msg === 'cancelled'
            ? { phase: 'available', progress: undefined }
            : { phase: 'error', error: msg, progress: undefined },
        );
      };

      request.on('response', (response) => {
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          response.on('data', () => undefined); // drain so the socket can close
          return fail(`download HTTP ${status}`);
        }
        const lenHeader = response.headers['content-length'];
        const totalBytes = Number(Array.isArray(lenHeader) ? lenHeader[0] : lenHeader) || 0;
        let received = 0;

        file = fs.createWriteStream(dest);
        file.on('error', (e) => fail(e.message));
        // Electron's net IncomingMessage IS a Node Readable at runtime but is
        // under-typed (no pipe/pause). Pipe drives the write WITH backpressure
        // (a ~150MB DMG must not buffer wholesale in memory); the 'data'
        // listener below only meters progress.
        (response as unknown as Readable).pipe(file);

        response.on('data', (chunk: Buffer) => {
          received += chunk.length;
          const secs = Math.max((Date.now() - started) / 1000, 0.001);
          this.patchProgress({
            receivedBytes: received,
            totalBytes,
            percent: totalBytes > 0 ? Math.min(100, Math.round((received / totalBytes) * 100)) : -1,
            bytesPerSecond: Math.round(received / secs),
          });
        });
        // Wait for the file (not just the socket) to flush before declaring done.
        file.on('finish', () =>
          settle({ phase: 'downloaded', downloadedPath: dest, progress: undefined }),
        );
        response.on('error', (e: Error) => fail(e.message));
      });

      // `abort()` (from cancelDownload) surfaces here; a transport failure on
      // 'error'. Both funnel through fail() under the settle guard.
      request.on('abort', () => fail('cancelled'));
      request.on('error', (e) => fail(e.message));
      request.end();
    });
  }

  /** Abort an in-flight download. The request's 'abort' handler rolls back state. */
  cancelDownload(): void {
    try {
      this.activeRequest?.abort();
    } catch {
      /* best-effort */
    }
  }

  // ── installing ────────────────────────────────────────────────────────────

  /**
   * Launch the downloaded installer. There is no in-place replacement:
   *  - macOS  → open (mount) the DMG; the user drags the app to Applications.
   *  - Windows → run the NSIS .exe detached, then quit so it can overwrite files.
   */
  async install(): Promise<void> {
    const file = this.state.downloadedPath;
    if (!file || !fs.existsSync(file)) {
      this.patch({ phase: 'error', error: 'Installer not found — please download again.' });
      return;
    }

    if (process.platform === 'darwin') {
      this.patch({ phase: 'installing' });
      // Mounts the DMG and reveals the drag-to-Applications window in Finder.
      const err = await shell.openPath(file);
      if (err) this.patch({ phase: 'error', error: err });
      return;
    }

    if (process.platform === 'win32') {
      this.patch({ phase: 'installing' });
      try {
        // Detach so the installer outlives our process; we quit right after so
        // the (assisted) NSIS installer isn't blocked by locked, running files.
        const child = spawn(file, [], { detached: true, stdio: 'ignore' });
        child.unref();
      } catch (e) {
        this.patch({ phase: 'error', error: e instanceof Error ? e.message : String(e) });
        return;
      }
      // Give the installer a beat to spin up before we hand it the field.
      setTimeout(() => app.quit(), 800);
      return;
    }

    // Other platforms: just reveal the file.
    void shell.showItemInFolder(file);
  }

  // ── skip / snooze ───────────────────────────────────────────────────────

  skip(version: string): void {
    this.skippedVersion = version;
    this.writeSkipped(version);
    if (this.state.info?.version === version) this.patch({ skipped: true });
  }

  /** Hide the banner for the rest of this run (not persisted). */
  snooze(): void {
    this.patch({ snoozed: true });
  }

  // ── state plumbing ────────────────────────────────────────────────────────

  private patch(partial: Partial<UpdateState>): void {
    this.state = { ...this.state, ...partial };
    this.deps.onStatus(this.state);
  }

  /** Progress updates go on a separate, higher-frequency channel. */
  private patchProgress(progress: UpdateState['progress']): void {
    this.state = { ...this.state, progress };
    this.deps.onProgress(this.state);
  }

  // ── persistence (userData/update-state.json) ──────────────────────────────

  private stateFile(): string {
    return path.join(app.getPath('userData'), 'update-state.json');
  }

  private readSkipped(): string | undefined {
    try {
      const raw = JSON.parse(fs.readFileSync(this.stateFile(), 'utf-8'));
      return typeof raw?.skippedVersion === 'string' ? raw.skippedVersion : undefined;
    } catch {
      return undefined;
    }
  }

  private writeSkipped(version: string): void {
    try {
      fs.writeFileSync(this.stateFile(), JSON.stringify({ skippedVersion: version }, null, 2));
    } catch (err) {
      console.warn('[updater] failed to persist skipped version:', err);
    }
  }
}
