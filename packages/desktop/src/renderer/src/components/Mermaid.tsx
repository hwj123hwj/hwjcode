/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Renders a ```mermaid fenced block as an SVG diagram. Mermaid is a large
 * library, so it's loaded lazily on first use (Vite code-splits the dynamic
 * import) — chats without diagrams never pay for it.
 *
 * Theming: the diagram is drawn with mermaid's `base` theme, whose colors are
 * pulled live from the app's CSS custom properties (`--bg`, `--text`, …). That
 * makes diagrams match whichever palette is active and re-render automatically
 * when the user flips the theme or the OS color scheme changes.
 *
 * Streaming-safe: agent transcripts stream token-by-token, so the fenced block
 * is frequently incomplete (and unparseable) mid-stream. We debounce renders,
 * keep the last good SVG on failure, and only fall back to the raw source when
 * nothing has rendered yet — so the diagram doesn't flash errors while typing.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { MermaidConfig } from 'mermaid';
import { Icon } from './Icon';
import { useT, type TFunc } from '../i18n/useT';

/* ── lazy mermaid loader ─────────────────────────────────────────────────── */

let mermaidPromise: Promise<typeof import('mermaid').default> | null = null;
function getMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => m.default);
  }
  return mermaidPromise;
}

/** Map the design-system CSS variables onto mermaid's `base` theme variables. */
function themeConfig(): MermaidConfig {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback = '') => cs.getPropertyValue(name).trim() || fallback;
  const sans = v('--sans', 'sans-serif');
  return {
    startOnLoad: false,
    theme: 'base',
    // The model output is untrusted; 'strict' disables embedded HTML/scripts.
    securityLevel: 'strict',
    fontFamily: sans,
    themeVariables: {
      background: v('--bg-sunken'),
      primaryColor: v('--bg-raised'),
      primaryTextColor: v('--text'),
      primaryBorderColor: v('--border-strong'),
      secondaryColor: v('--bg-elev'),
      tertiaryColor: v('--bg-elev'),
      secondaryBorderColor: v('--border'),
      tertiaryBorderColor: v('--border'),
      lineColor: v('--text-faint'),
      textColor: v('--text'),
      mainBkg: v('--bg-raised'),
      nodeBorder: v('--border-strong'),
      nodeTextColor: v('--text'),
      clusterBkg: v('--bg-elev'),
      clusterBorder: v('--border'),
      titleColor: v('--text'),
      edgeLabelBackground: v('--bg-sunken'),
      labelBoxBkgColor: v('--bg-elev'),
      labelBoxBorderColor: v('--border'),
      noteBkgColor: v('--amber-weak'),
      noteTextColor: v('--text'),
      noteBorderColor: v('--amber'),
      fontFamily: sans,
      fontSize: '13px',
    },
  };
}

let renderSeq = 0;
// mermaid's `render()` mutates shared/module-level state (theme config, an
// internal DOM counter, temporary measuring nodes) and isn't safe to call
// concurrently. New chats stream diagrams in one at a time, so this never
// mattered — but resuming a session replays the *entire* prior transcript at
// once, mounting every Mermaid block together and firing their renders in
// the same tick. Serialize them through one queue so restores render exactly
// like a live chat did.
let renderQueue: Promise<unknown> = Promise.resolve();
/** Render `code` to an SVG string, cleaning up any stray nodes mermaid leaves. */
function renderToSvg(code: string): Promise<string> {
  const run = async (): Promise<string> => {
    const mermaid = await getMermaid();
    mermaid.initialize(themeConfig());
    const id = `mmd-${++renderSeq}`;
    try {
      const { svg } = await mermaid.render(id, code);
      return svg;
    } finally {
      // mermaid appends a temporary measuring node to <body>; remove it (and the
      // `d…` error node it may leave on a parse failure) so they don't accumulate.
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
    }
  };
  const result = renderQueue.then(run, run);
  // Keep the queue alive even if this render fails, but never let it carry a
  // rejection forward (that would poison every later render in the chain).
  renderQueue = result.catch(() => undefined);
  return result;
}

/* ── SVG export helpers ──────────────────────────────────────────────────── */

/** Base64-encode a UTF-8 string (`btoa` alone only handles latin1). */
function utf8ToBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/**
 * Rasterize an SVG string to a base64 PNG via an offscreen canvas (2× for
 * crispness), filling the diagram background so the export isn't transparent.
 * Rejects if the browser taints the canvas (can happen for SVGs with embedded
 * HTML labels) — callers fall back to saving the raw vector SVG.
 */
async function svgToPngBase64(svgMarkup: string): Promise<string> {
  const el = new DOMParser().parseFromString(svgMarkup, 'image/svg+xml')
    .documentElement;
  let w = parseFloat(el.getAttribute('width') || '');
  let h = parseFloat(el.getAttribute('height') || '');
  if (!w || !h) {
    const vb = (el.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
    if (vb.length === 4) {
      w = w || vb[2];
      h = h || vb[3];
    }
  }
  w = w || 800;
  h = h || 600;
  const scale = 2;
  const url = URL.createObjectURL(
    new Blob([svgMarkup], { type: 'image/svg+xml;charset=utf-8' }),
  );
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('svg load failed'));
      im.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    const bg = getComputedStyle(document.documentElement)
      .getPropertyValue('--bg-sunken')
      .trim();
    ctx.fillStyle = bg || '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    // `toDataURL` throws (SecurityError) if the canvas got tainted — the caller
    // catches it and saves the SVG instead.
    return canvas.toDataURL('image/png').split(',')[1] ?? '';
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* ── theme-change subscription (shared across all diagrams) ──────────────── */

let themeVersion = 0;
const themeListeners = new Set<() => void>();
function bumpTheme() {
  themeVersion += 1;
  themeListeners.forEach((l) => l());
}
if (typeof window !== 'undefined' && typeof MutationObserver !== 'undefined') {
  new MutationObserver(bumpTheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
  window
    .matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', bumpTheme);
}
function useThemeVersion(): number {
  return useSyncExternalStore(
    (cb) => {
      themeListeners.add(cb);
      return () => themeListeners.delete(cb);
    },
    () => themeVersion,
  );
}

/* ── component ───────────────────────────────────────────────────────────── */

export function Mermaid({ code }: { code: string }) {
  const t = useT();
  const themeVersion = useThemeVersion();
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const downloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const trimmed = code.trim();
    if (!trimmed) {
      setSvg(null);
      setError(null);
      return;
    }
    // Debounce so streaming updates coalesce into one render.
    const timer = setTimeout(() => {
      void renderToSvg(trimmed)
        .then((out) => {
          if (cancelled) return;
          setSvg(out);
          setError(null);
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          // Keep the last good SVG (if any) — only record the error message.
          setError(e instanceof Error ? e.message : String(e));
        });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [code, themeVersion]);

  const copy = () => {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1400);
    });
  };

  // Export the rendered diagram via a native "Save As" dialog. Prefer a PNG
  // raster; if the canvas can't be exported (tainted), fall back to the vector
  // SVG, which always works. A brief check confirms a successful save.
  const download = async () => {
    if (!svg) return;
    let mimeType = 'image/png';
    let name = 'diagram.png';
    let data: string;
    try {
      data = await svgToPngBase64(svg);
      if (!data) throw new Error('empty png');
    } catch {
      mimeType = 'image/svg+xml';
      name = 'diagram.svg';
      data = utf8ToBase64(svg);
    }
    const saved = await window.easycode.workspace.saveImageAs(name, mimeType, data);
    if (!saved) return;
    setDownloaded(true);
    if (downloadTimer.current) clearTimeout(downloadTimer.current);
    downloadTimer.current = setTimeout(() => setDownloaded(false), 1400);
  };

  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
      if (downloadTimer.current) clearTimeout(downloadTimer.current);
    },
    [],
  );

  // Nothing has rendered yet → show the raw source as a graceful fallback.
  const hasDiagram = svg !== null;

  return (
    <div className="mermaid-block">
      <div className="mermaid-toolbar">
        {hasDiagram && (
          <button
            type="button"
            className="mermaid-tool-btn"
            title={showSource ? t('mermaid.viewDiagram') : t('mermaid.viewSource')}
            aria-label={showSource ? t('mermaid.viewDiagram') : t('mermaid.viewSource')}
            onClick={() => setShowSource((s) => !s)}
          >
            <Icon name="code" size={14} />
          </button>
        )}
        {hasDiagram && !showSource && (
          <button
            type="button"
            className="mermaid-tool-btn"
            title={t('mermaid.zoom')}
            aria-label={t('mermaid.zoom')}
            onClick={() => setZoomed(true)}
          >
            <Icon name="maximize" size={14} />
          </button>
        )}
        {hasDiagram && !showSource && (
          <button
            type="button"
            className="mermaid-tool-btn"
            title={downloaded ? t('mermaid.downloaded') : t('mermaid.download')}
            aria-label={downloaded ? t('mermaid.downloaded') : t('mermaid.download')}
            onClick={() => void download()}
          >
            <Icon name={downloaded ? 'check' : 'download'} size={14} />
          </button>
        )}
        <button
          type="button"
          className="mermaid-tool-btn"
          title={copied ? t('mermaid.copied') : t('mermaid.copy')}
          aria-label={copied ? t('mermaid.copied') : t('mermaid.copy')}
          onClick={copy}
        >
          <Icon name={copied ? 'check' : 'copy'} size={14} />
        </button>
      </div>

      {hasDiagram && !showSource ? (
        <div
          className="mermaid-svg"
          role="img"
          onClick={() => setZoomed(true)}
          dangerouslySetInnerHTML={{ __html: svg! }}
        />
      ) : hasDiagram && showSource ? (
        <pre className="mermaid-source">
          <code>{code}</code>
        </pre>
      ) : (
        <>
          <pre className="mermaid-source">
            <code>{code}</code>
          </pre>
          <div className="mermaid-status">
            {error ? (
              <>
                <Icon name="alert" size={13} />
                <span>{t('mermaid.error')}</span>
              </>
            ) : (
              <>
                <Icon name="loader" size={13} spin />
                <span>{t('mermaid.rendering')}</span>
              </>
            )}
          </div>
        </>
      )}

      {zoomed && svg && (
        <MermaidZoom
          svg={svg}
          onClose={() => setZoomed(false)}
          onDownload={download}
          downloaded={downloaded}
          t={t}
        />
      )}
    </div>
  );
}

/* ── zoom overlay: wheel to scale, drag to pan ───────────────────────────── */

function MermaidZoom({
  svg,
  onClose,
  onDownload,
  downloaded,
  t,
}: {
  svg: string;
  onClose: () => void;
  onDownload: () => void;
  downloaded: boolean;
  t: TFunc;
}) {
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    setScale((s) => Math.min(8, Math.max(0.25, s * (e.deltaY < 0 ? 1.12 : 0.89))));
  };
  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    setPan({
      x: drag.current.px + (e.clientX - drag.current.x),
      y: drag.current.py + (e.clientY - drag.current.y),
    });
  };
  const endDrag = () => {
    drag.current = null;
  };

  return (
    <div className="mermaid-zoom-backdrop" onClick={onClose}>
      <div className="mermaid-zoom-actions">
        <button
          type="button"
          className="mermaid-zoom-btn"
          title={downloaded ? t('mermaid.downloaded') : t('mermaid.download')}
          aria-label={downloaded ? t('mermaid.downloaded') : t('mermaid.download')}
          onClick={(e) => {
            e.stopPropagation();
            onDownload();
          }}
        >
          <Icon name={downloaded ? 'check' : 'download'} size={18} />
        </button>
        <button
          type="button"
          className="mermaid-zoom-btn"
          title={t('common.close')}
          aria-label={t('common.close')}
          onClick={onClose}
        >
          <Icon name="x" size={18} />
        </button>
      </div>
      <div
        className="mermaid-zoom-stage"
        onClick={(e) => e.stopPropagation()}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
      >
        <div
          className="mermaid-zoom-svg"
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})` }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
    </div>
  );
}
