// SPDX-License-Identifier: AGPL-3.0-only
import { useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { t } from '@bines/shared';
import { floatingBoundary, placeFloating, useLayer } from '@bines/ui';


/** Emoji a doc can take as its icon (sidebar, tabs, header). */
export const DOC_ICONS = [
  '📄', '📝', '📋', '📌', '📎', '📚', '📖', '🗂️', '🗒️', '📊',
  '📈', '💡', '🎯', '🚀', '✅', '⭐', '🔥', '❤️', '🧭', '🛠️',
  '💼', '🤝', '📣', '🗓️', '⏰', '💰', '🧾', '🏷️', '🔒', '🌱',
  '🎨', '🧪', '📦', '🏠', '👥', '🙋', '💬', '📞', '✉️', '🌍',
];

/**
 * The doc's icon (M8 ד2 leftover): a click on the header icon opens a grid of emoji, "no icon" first. Its own
 * floating panel on the shared layer stack (outside click / Esc close it) — no native picker.
 */
export const IconPicker = ({
  value,
  disabled,
  onChange,
  children,
}: {
  value: string | null;
  disabled?: boolean;
  onChange: (icon: string | null) => void;
  children: ReactNode;
}) => {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const [placed, setPlaced] = useState<{ left: number; top: number } | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useLayer(panel, !!at, () => setAt(null), undefined, () => button.current);
  const pick = (icon: string | null) => {
    setAt(null);
    if (icon !== value) onChange(icon);
  };
  return (
    <>
      <button
        ref={button}
        type="button"
        disabled={disabled}
        aria-label={t('docs2.icon')}
        title={disabled ? undefined : t('docs2.icon')}
        aria-expanded={!!at}
        data-testid="doc-icon"
        onClick={(e) => {
          if (at) return setAt(null);
          // Round 12: the shared placement rule (flip above / shift inside the screen and the doc's side panel).
          const r = e.currentTarget.getBoundingClientRect();
          const p = placeFloating(
            r,
            { width: 300, height: 260 },
            { width: document.documentElement.clientWidth || window.innerWidth, height: window.innerHeight },
            { rtl: document.documentElement.dir === 'rtl', gap: 6, boundary: floatingBoundary(e.currentTarget) },
          );
          setPlaced({ left: p.left, top: p.top });
          setAt({ x: r.left, y: r.bottom });
        }}
        className="rounded-[14px] enabled:cursor-pointer enabled:hover:ring-2 enabled:hover:ring-line-strong"
      >
        {children}
      </button>
      {at
        ? createPortal(
            <div
              ref={panel}
              role="dialog"
              aria-label={t('docs2.icon')}
              data-testid="doc-icon-picker"
              style={placed ?? { left: at.x, top: at.y }}
              className="fixed z-popover w-[300px] rounded-[var(--radius)] border border-line bg-surface p-2 shadow-[var(--shadow-pop)]"
            >
              <div className="grid grid-cols-8 gap-0.5">
                {DOC_ICONS.map((icon) => (
                  <button
                    key={icon}
                    type="button"
                    data-testid="doc-icon-option"
                    data-icon={icon}
                    aria-pressed={icon === value}
                    onClick={() => pick(icon)}
                    className={
                      icon === value
                        ? 'size-8 rounded-[8px] bg-primary-soft text-lg'
                        : 'size-8 rounded-[8px] text-lg hover:bg-surface-2'
                    }
                  >
                    {icon}
                  </button>
                ))}
              </div>
              {value ? (
                <button
                  type="button"
                  data-testid="doc-icon-remove"
                  onClick={() => pick(null)}
                  className="mt-1.5 w-full rounded-[8px] px-2 py-1.5 text-start text-sm text-muted hover:bg-surface-2 hover:text-fg"
                >
                  {t('docs2.icon.remove')}
                </button>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </>
  );
};
