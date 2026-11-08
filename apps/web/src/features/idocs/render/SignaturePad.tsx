// SPDX-License-Identifier: AGPL-3.0-only
import { useRef, useState, type PointerEvent } from 'react';
import { IDOC_DRAWING_MAX } from '@bines/shared';

/**
 * A drawn signature (finger, pen or mouse) kept as SVG path data in a 400×120 box — the only form the server takes
 * (`idocDrawingSchema`: path commands and numbers), so nothing but lines can ever come back from it.
 */
export const PAD_W = 400;
export const PAD_H = 120;

export const SignaturePad = ({
  value,
  onChange,
  label,
  clearLabel,
  hint,
  disabled,
}: {
  value: string;
  onChange: (path: string) => void;
  label: string;
  clearLabel: string;
  hint: string;
  disabled?: boolean;
}) => {
  const svg = useRef<SVGSVGElement>(null);
  const drawing = useRef(false);
  const [live, setLive] = useState(value);
  const point = (e: PointerEvent) => {
    const r = svg.current!.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * PAD_W;
    const y = ((e.clientY - r.top) / r.height) * PAD_H;
    return `${Math.max(0, Math.min(PAD_W, x)).toFixed(1)} ${Math.max(0, Math.min(PAD_H, y)).toFixed(1)}`;
  };
  const start = (e: PointerEvent<SVGSVGElement>) => {
    if (disabled) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    setLive((p) => `${p}${p ? ' ' : ''}M${point(e)}`);
  };
  const move = (e: PointerEvent<SVGSVGElement>) => {
    if (!drawing.current) return;
    setLive((p) => (p.length > IDOC_DRAWING_MAX - 40 ? p : `${p} L${point(e)}`));
  };
  const end = () => {
    if (!drawing.current) return;
    drawing.current = false;
    onChange(live);
  };
  return (
    <div className="space-y-1.5">
      <div className="relative h-28 overflow-hidden rounded-[var(--radius)] border border-dashed border-line-strong bg-surface-3">
        <svg
          ref={svg}
          viewBox={`0 0 ${PAD_W} ${PAD_H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={label}
          data-testid="idoc-signature-pad"
          className="absolute inset-0 size-full touch-none text-heading"
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
          onPointerLeave={end}
        >
          <path
            d={live}
            fill="none"
            stroke="currentColor"
            strokeWidth={2.2}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        {!live ? (
          <span className="pointer-events-none absolute inset-0 grid place-items-center text-xs text-muted">
            {hint}
          </span>
        ) : null}
      </div>
      {live && !disabled ? (
        <button
          type="button"
          className="text-xs text-info-fg hover:underline"
          onClick={() => {
            setLive('');
            onChange('');
          }}
        >
          {clearLabel}
        </button>
      ) : null}
    </div>
  );
};
