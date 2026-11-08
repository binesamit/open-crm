// SPDX-License-Identifier: AGPL-3.0-only
import { useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn, floatingBoundary, useFloating } from '@bines/ui';

/**
 * A list at the text caret — the @mention list of updates and docs, the doc's "/" block list (round 12). In a
 * portal on <body> (no transformed ancestor can shift it), placed by the shared rule (`useFloating`): below the
 * caret, above it when there is no room, lined up with the caret on the inline-start side (RTL: its right edge
 * at the caret) and pushed back inside the screen — and inside the item card / side panel the editor sits in.
 */
export const CaretPopup = ({
  rect,
  host,
  children,
  className,
  label,
  testId,
}: {
  /** The caret's box (Tiptap's `clientRect()`). */
  rect: DOMRect;
  /** The editor's element (read when placing): its dialog / panel is the boundary. */
  host?: () => Element | null | undefined;
  children: ReactNode;
  className?: string;
  label: string;
  testId?: string;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const { style, placement } = useFloating({
    open: true,
    floating: ref,
    anchor: () => rect,
    boundary: () => floatingBoundary(host?.()),
    rtl: document.documentElement.dir === 'rtl',
    gap: 6,
    key: `${rect.left},${rect.top},${rect.bottom}`,
  });
  return createPortal(
    <div
      ref={ref}
      role="listbox"
      aria-label={label}
      data-testid={testId}
      data-side={placement?.side}
      dir={document.documentElement.dir || undefined}
      style={style}
      className={cn(
        'fixed z-popover overflow-y-auto rounded-[var(--radius)] border border-line bg-surface p-1 shadow-[var(--shadow-pop)]',
        className,
      )}
    >
      {children}
    </div>,
    document.body,
  );
};
