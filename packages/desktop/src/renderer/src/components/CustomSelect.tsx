import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';

/**
 * A bottom toggle switch shown under a divider inside a {@link SelectSubmenu}.
 * Generic — the caller decides what it controls.
 */
export interface SelectToggle {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

/**
 * A flyout panel anchored beside an option row. Holds radio-style sub-options
 * (the one matching `value` shows a check) plus an optional toggle. Stays
 * intentionally generic so it can host an "effort" picker, a sub-mode list, or
 * anything else — it knows nothing about thinking specifically.
 */
export interface SelectSubmenu {
  /** Helper text shown at the top of the flyout. */
  header?: string;
  options: SelectOption[];
  /** Currently-selected sub-option value (drives the check mark). */
  value?: string;
  onChange?: (value: string) => void;
  /** Optional switch row rendered under a divider at the bottom. */
  toggle?: SelectToggle;
}

export interface SelectOption {
  value: string;
  label: string;
  /** Secondary muted line under the label (e.g. a model tagline). */
  description?: string;
  /** Right-aligned muted text (e.g. a current value summary). */
  hint?: string;
  /** Small badge rendered next to the label (e.g. "Default"). */
  badge?: string;
  /** Native title tooltip. */
  title?: string;
  /** Render a divider line directly under this row (group separator). */
  dividerAfter?: boolean;
  /**
   * When present, the row does NOT select on click — it opens this flyout to
   * the side instead, and shows a chevron affordance.
   */
  submenu?: SelectSubmenu;
}

/** Width of the main menu; the flyout is offset by this so it sits beside it. */
const MENU_WIDTH = 248;
const FLYOUT_WIDTH = 260;
const FLYOUT_GAP = 6;
/** Gap between the trigger chip and the popup, and padding from the viewport edge. */
const TRIGGER_GAP = 6;
const VIEWPORT_PAD = 8;
/** Hard ceiling on the popup height; the real cap is the room on screen. */
const MENU_MAX_HEIGHT = 420;

/** Resolved fixed-position coordinates for the portal popup (top-anchored). */
interface PopCoords {
  left: number;
  top: number;
  maxHeight: number;
}

/** Small Claude-style on/off switch. */
function Switch({ checked, onClick }: { checked: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className="cs-switch"
      data-on={checked ? 'true' : 'false'}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      <span className="cs-switch-knob" />
    </button>
  );
}

/** One selectable / submenu-opening row, shared by the menu and its flyouts. */
function Row({
  option,
  selected,
  hovered,
  hasSubmenu,
  onHover,
  onClick,
}: {
  option: SelectOption;
  selected: boolean;
  hovered: boolean;
  hasSubmenu: boolean;
  onHover: () => void;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="cs-row"
      style={{ background: hovered ? 'var(--bg-hover)' : 'transparent' }}
      title={option.title ?? option.hint}
      onMouseEnter={onHover}
      onClick={onClick}
    >
      <span className="cs-row-main">
        <span className="cs-row-label-line">
          <span className="cs-row-label">{option.label}</span>
          {option.badge && <span className="cs-row-badge">{option.badge}</span>}
        </span>
        {option.description && <span className="cs-row-desc">{option.description}</span>}
      </span>
      {option.hint && <span className="cs-row-hint">{option.hint}</span>}
      {selected && (
        <span className="cs-row-check">
          <Icon name="check" size={13} />
        </span>
      )}
      {hasSubmenu && (
        <span className="cs-row-chevron">
          <Icon name="chevron-right" size={13} />
        </span>
      )}
    </button>
  );
}

export function CustomSelect({
  value,
  options,
  placeholder,
  icon,
  accent,
  preferUp,
  onChange,
}: {
  value: string;
  options: SelectOption[];
  placeholder?: string;
  icon?: string;
  accent?: boolean;
  /** When true, the popup opens above the trigger by default (unless viewport
   *  constraints force it downward). Useful for controls near the bottom of the
   *  viewport (e.g. a prompt bar). */
  preferUp?: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // value of the option whose flyout is currently shown, or null.
  const [activeSubmenu, setActiveSubmenu] = useState<string | null>(null);
  // hovered row values, tracked separately for the main list and the flyout so
  // the highlight follows the pointer in either pane.
  const [hovered, setHovered] = useState<string | null>(null);
  const [hoveredSub, setHoveredSub] = useState<string | null>(null);
  // Resolved fixed-position coordinates for the portal popup, recomputed from the
  // trigger's on-screen rect each time the menu opens (and on scroll/resize).
  const [coords, setCoords] = useState<PopCoords | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // The portal popup lives outside this component's DOM subtree, so we keep a
  // ref to it for the outside-click check.
  const popRef = useRef<HTMLDivElement>(null);

  // Place the popup. Renders into document.body with position:fixed so no
  // ancestor `overflow` clips it. We measure the popup's ACTUAL rendered height
  // (when available) and always anchor with `top`, flipping above the trigger
  // when it wouldn't fit below — then clamp into the viewport. This self-corrects
  // regardless of pre-render height guesses, so the menu can never be cut off.
  const place = () => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    // Real height once the popup is mounted; before that, assume the max so the
    // first pass already biases toward the side that fits. A second pass (rAF)
    // re-runs with the measured height for a pixel-accurate position.
    const popH = popRef.current?.offsetHeight || MENU_MAX_HEIGHT;
    const spaceAbove = r.top - TRIGGER_GAP - VIEWPORT_PAD;
    const spaceBelow = vh - r.bottom - TRIGGER_GAP - VIEWPORT_PAD;
    // Open downward by default; flip up when the popup doesn't fit below but
    // there's more room above.
    const openUp = preferUp
      ? spaceAbove > popH + VIEWPORT_PAD
      : popH > spaceBelow && spaceAbove > spaceBelow;
    const maxHeight = Math.max(
      120,
      Math.min(MENU_MAX_HEIGHT, openUp ? spaceAbove : spaceBelow),
    );
    const h = Math.min(popH, maxHeight);
    let top = openUp ? r.top - TRIGGER_GAP - h : r.bottom + TRIGGER_GAP;
    // Final clamp so the box stays fully within the viewport either way.
    top = Math.max(VIEWPORT_PAD, Math.min(top, vh - VIEWPORT_PAD - h));
    // Keep the menu (and ideally the flyout to its right) horizontally on screen.
    const totalWidth = MENU_WIDTH + FLYOUT_GAP + FLYOUT_WIDTH;
    let left = r.left;
    if (left + totalWidth > vw - VIEWPORT_PAD) {
      left = Math.max(VIEWPORT_PAD, vw - VIEWPORT_PAD - totalWidth);
    }
    setCoords({ left, top, maxHeight });
  };

  useLayoutEffect(() => {
    if (!open) return;
    place(); // first pass (height estimated)
    const raf = requestAnimationFrame(place); // second pass (measured height)
    const reflow = () => place();
    window.addEventListener('resize', reflow);
    // capture:true also catches scrolls inside nested scroll containers.
    window.addEventListener('scroll', reflow, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', reflow);
      window.removeEventListener('scroll', reflow, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Re-measure when the flyout opens/closes (it can change the popup height).
  useLayoutEffect(() => {
    if (open) place();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSubmenu]);

  // Close on click outside the trigger AND the portal popup.
  useEffect(() => {
    if (!open) return;
    const handleClose = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (popRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handleClose);
    return () => document.removeEventListener('mousedown', handleClose);
  }, [open]);

  // Reset transient hover/submenu state whenever the menu closes.
  useEffect(() => {
    if (!open) {
      setActiveSubmenu(null);
      setHovered(null);
      setHoveredSub(null);
    }
  }, [open]);

  const selected = options.find((o) => o.value === value);
  const active = activeSubmenu ? options.find((o) => o.value === activeSubmenu) : undefined;
  const submenu = active?.submenu;

  return (
    <div className="custom-select-wrapper" style={{ display: 'inline-block' }}>
      <button
        ref={triggerRef}
        className={`chip ${accent ? 'accent' : ''} interactive`}
        style={{ gap: '4px', paddingRight: '22px', position: 'relative' }}
        onClick={() => setOpen((o) => !o)}
      >
        {icon && <Icon name={icon as never} size={14} />}
        <span>{selected ? selected.label : placeholder}</span>
        <span
          style={{
            position: 'absolute',
            right: '8px',
            top: '52%',
            transform: 'translateY(-50%)',
            display: 'inline-grid',
            placeItems: 'center',
            lineHeight: '0',
            color: 'var(--text-faint)',
            pointerEvents: 'none',
          }}
        >
          <Icon name="chevron-down" size={10} />
        </span>
      </button>

      {open &&
        coords &&
        createPortal(
          <div
            ref={popRef}
            className="cs-pop-row"
            style={{
              position: 'fixed',
              left: coords.left,
              top: coords.top,
              zIndex: 99999,
              display: 'flex',
              alignItems: 'flex-start',
              gap: `${FLYOUT_GAP}px`,
            }}
            onMouseLeave={() => {
              setActiveSubmenu(null);
              setHovered(null);
            }}
          >
            <div
              className="menu-pop cs-menu"
              style={{
                width: `${MENU_WIDTH}px`,
                maxHeight: coords.maxHeight,
                overflowY: 'auto',
              }}
            >
              {options.map((o) => {
                const hasSub = !!o.submenu;
                return (
                  <div key={o.value}>
                    <Row
                      option={o}
                      selected={!hasSub && o.value === value}
                      hovered={hovered === o.value || activeSubmenu === o.value}
                      hasSubmenu={hasSub}
                      onHover={() => {
                        setHovered(o.value);
                        setActiveSubmenu(hasSub ? o.value : null);
                      }}
                      onClick={() => {
                        if (hasSub) {
                          setActiveSubmenu((s) => (s === o.value ? null : o.value));
                          return;
                        }
                        onChange(o.value);
                        setOpen(false);
                      }}
                    />
                    {o.dividerAfter && <div className="cs-divider" />}
                  </div>
                );
              })}
            </div>

            {submenu && (
              <div
                className="menu-pop cs-menu cs-flyout"
                style={{ width: `${FLYOUT_WIDTH}px`, maxHeight: coords.maxHeight, overflowY: 'auto' }}
                onMouseEnter={() => setHovered(activeSubmenu)}
              >
                {submenu.header && <div className="cs-flyout-header">{submenu.header}</div>}
                {submenu.options.map((s) => (
                  <Row
                    key={s.value}
                    option={s}
                    selected={s.value === submenu.value}
                    hovered={hoveredSub === s.value}
                    hasSubmenu={false}
                    onHover={() => setHoveredSub(s.value)}
                    onClick={() => submenu.onChange?.(s.value)}
                  />
                ))}
                {submenu.toggle && (
                  <>
                    <div className="cs-divider" />
                    <div className="cs-toggle-row">
                      <span className="cs-row-main">
                        <span className="cs-row-label">{submenu.toggle.label}</span>
                        {submenu.toggle.description && (
                          <span className="cs-row-desc">{submenu.toggle.description}</span>
                        )}
                      </span>
                      <Switch
                        checked={submenu.toggle.checked}
                        onClick={() => submenu.toggle!.onChange(!submenu.toggle!.checked)}
                      />
                    </div>
                  </>
                )}
              </div>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
