/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * A thin draggable divider used to resize a neighbouring panel. It captures the
 * pointer on mousedown, then reports an absolute target size on each move
 * (`startValue + sign * pointerDelta`) so the parent can clamp + persist it. The
 * `sign` lets a handle that sits on the *leading* edge of the resized panel (our
 * right sidebar, bottom terminal and file tree all grow as the pointer moves
 * toward them) feel natural.
 */

import { useCallback } from 'react';

export function Resizer({
  axis,
  getValue,
  onChange,
  sign = -1,
  title,
}: {
  /** 'x' = drag horizontally (resize a width); 'y' = drag vertically (height). */
  axis: 'x' | 'y';
  /** Read the resized panel's current size at the moment the drag starts. */
  getValue: () => number;
  /** Receives the new target size (parent clamps + persists). */
  onChange: (next: number) => void;
  /** +1 if the panel grows as the pointer moves right/down; -1 otherwise. */
  sign?: 1 | -1;
  title?: string;
}) {
  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const startPos = axis === 'x' ? e.clientX : e.clientY;
      const startVal = getValue();
      const onMove = (ev: PointerEvent) => {
        const pos = axis === 'x' ? ev.clientX : ev.clientY;
        onChange(startVal + sign * (pos - startPos));
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        document.body.classList.remove('resizing');
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      document.body.classList.add('resizing');
    },
    [axis, getValue, onChange, sign],
  );

  return (
    <div
      className={`resizer resizer-${axis}`}
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      title={title}
      onPointerDown={onPointerDown}
    />
  );
}
