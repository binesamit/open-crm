// SPDX-License-Identifier: AGPL-3.0-only
import {
  forwardRef,
  useEffect,
  useId,
  useMemo,
  useRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SyntheticEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { twMerge } from 'tailwind-merge';
import { t } from '@bines/shared';
import { closedALayer, layersAbove, nextLayerSeq, panelOverDialog, panelOverModalOpen } from './layers';
import { fieldDir, isTextInputType, useTextDir } from './text-dir';
import { useExitRef } from './motion';
import { autoFocusSearch } from './touch';

/** Inputs a tap toggles or picks without the on-screen keyboard. */
const NO_KEYBOARD_INPUTS = new Set(['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'color', 'file']);

/** Minimal primitives on the 11-UI-DESIGN tokens. Logical properties only (RTL-first). */
/** Joins class names; later Tailwind classes win over earlier ones (h-8 after h-9), so call sites can resize. */
export const cn = (...parts: (string | false | null | undefined)[]) => twMerge(parts.filter(Boolean).join(' '));

/**
 * Button (F4 canvas `.btn`). `primary` = the brand ink (dark green; near-white in dark mode) for save / close /
 * send; `accent` = amber, only for the one main action of a screen; `danger` = filled red for destructive
 * confirmations; `dashed` = "add another". Sizes: sm 32, md 36, lg 44 (full-width forms).
 */
type ButtonVariant = 'primary' | 'accent' | 'secondary' | 'ghost' | 'danger' | 'danger-outline' | 'dashed';
type ButtonSize = 'sm' | 'md' | 'lg';

const buttonVariants: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-on-primary font-semibold hover:opacity-90',
  accent: 'bg-accent text-on-accent font-bold text-sm hover:brightness-105',
  secondary: 'bg-surface text-heading border border-line-strong hover:bg-surface-2',
  ghost: 'bg-transparent text-fg-2 hover:bg-surface-2 hover:text-fg',
  danger: 'bg-danger text-white font-semibold hover:brightness-95',
  'danger-outline': 'bg-surface text-danger-fg border border-line-strong hover:bg-danger-soft',
  dashed: 'bg-transparent text-fg-2 border border-dashed border-line-strong hover:bg-surface-2 hover:text-fg',
};
const buttonSizes: Record<ButtonSize, string> = {
  sm: 'h-8 rounded-[10px] px-2.5',
  md: 'h-9 rounded-[var(--radius)] px-3.5',
  lg: 'h-11 rounded-[var(--radius)] px-4 text-sm',
};

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize; busy?: boolean }
>(({ variant = 'primary', size = 'md', busy, className, children, disabled, type = 'button', ...props }, ref) => (
  // `type` defaults to "button": inside a <form> a type-less button is a submit button, so Enter in a field would
  // "click" the first one (often Cancel/Clear). A form's submit button passes type="submit" explicitly.
  <button
    ref={ref}
    type={type}
    disabled={disabled || busy}
    className={cn(
      'press inline-flex items-center justify-center gap-1.5 text-[0.8125rem] whitespace-nowrap',
      'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]',
      'disabled:cursor-not-allowed disabled:opacity-45',
      buttonSizes[size],
      buttonVariants[variant],
      className,
    )}
    {...props}
  >
    {busy ? <span className="size-3 animate-spin rounded-full border-2 border-current border-e-transparent" /> : null}
    {children}
  </button>
));
Button.displayName = 'Button';

const fieldBase =
  'h-9 w-full rounded-[10px] border border-[var(--control-line)] bg-surface px-2.5 text-sm text-fg placeholder:text-muted focus:border-primary focus:outline-none focus:ring-3 focus:ring-[var(--accent-soft)]';

/**
 * A text field. Typing direction (rtltype): a free-text field (text / search, no fixed `dir` or `dir="auto"`)
 * with a controlled `value` gets the direction of its first strong letter, else the UI's base direction — so an
 * empty field has its caret on the right in Hebrew. Uncontrolled ones get the same from `installTypingDir`.
 */
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, dir, ...props }, ref) => {
    const base = useTextDir();
    const free = (!dir || dir === 'auto') && isTextInputType(props.type);
    const shown = free && props.value !== undefined ? fieldDir(props.value, base) : dir;
    return <input ref={ref} className={cn(fieldBase, className)} dir={shown} {...props} />;
  },
);
Input.displayName = 'Input';

// No `Select`: native pickers are not used (M1.1 #9) — `Picker` (menu.tsx) is the field for one-of-many.

export const Field = ({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) => (
  <label className="block space-y-1.5">
    <span className="text-xs font-semibold text-fg-2">{label}</span>
    {children}
    {hint ? <span className="block text-xs text-muted">{hint}</span> : null}
  </label>
);

/** A card (`.card`): radius 16, padding 16; `soft` = the quiet surface-3 variant. */
export const Card = ({
  className,
  soft,
  children,
  ...rest
}: { className?: string; soft?: boolean; children: ReactNode } & Omit<HTMLAttributes<HTMLDivElement>, 'className'>) => (
  // `rest`: data-testid, aria-*, … reach the element (they were dropped, so `<Card data-testid>` had no test id).
  <div
    {...rest}
    className={cn(
      'rounded-[var(--radius-lg)] border p-4',
      soft ? 'border-line-soft bg-surface-3' : 'border-line bg-surface',
      className,
    )}
  >
    {children}
  </div>
);

const NOTICE_ICON = {
  info: 'M12 11v5M12 8h.01',
  warn: 'M12 9v4M12 16.5h.01',
  error: 'M12 8v5M12 16h.01',
  success: 'M8 12l3 3 5-6',
} as const;

/** A message in the flow (`.notice`): a tone colour and a leading icon. */
export const Notice = ({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warn' | 'error' | 'success';
  children: ReactNode;
}) => (
  <div
    role={tone === 'error' ? 'alert' : 'status'}
    className={cn(
      'flex items-start gap-2.5 rounded-[var(--radius)] px-3 py-2.5 text-[0.8125rem]',
      tone === 'error' && 'bg-danger-soft text-danger-fg',
      tone === 'warn' && 'bg-accent-soft text-accent-fg',
      tone === 'success' && 'bg-ok-soft text-ok-fg',
      tone === 'info' && 'bg-info-soft text-info-fg',
    )}
  >
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="mt-px shrink-0"
    >
      {/* data-icon-part: the main shape, tinted by the app's icon style (styles.css). */}
      {tone === 'warn' ? (
        <path data-icon-part="b" d="M12 3l10 18H2z" />
      ) : (
        <circle data-icon-part="b" cx="12" cy="12" r="9" />
      )}
      <path d={NOTICE_ICON[tone]} />
    </svg>
    <div className="min-w-0 flex-1">{children}</div>
  </div>
);

/** A chip (`.chip`): 24px, tones for state — role, status, kind. */
export const Badge = ({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'info' | 'ok' | 'warn' | 'danger' | 'violet';
}) => (
  <span
    className={cn(
      'inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-[0.5625rem] text-xs font-normal whitespace-nowrap',
      tone === 'neutral' && 'bg-surface-2 text-fg-2',
      tone === 'info' && 'bg-info-soft text-info-fg',
      tone === 'ok' && 'bg-ok-soft text-ok-fg',
      tone === 'warn' && 'bg-accent-soft text-accent-fg',
      tone === 'danger' && 'bg-danger-soft text-danger-fg',
      tone === 'violet' && 'bg-violet-soft text-violet-fg',
    )}
  >
    {children}
  </span>
);

export const Spinner = ({ label }: { label: string }) => (
  <div className="flex items-center gap-2 text-sm text-muted" role="status">
    <span className="size-4 animate-spin rounded-full border-2 border-[var(--line)] border-e-[var(--primary)]" />
    {label}
  </div>
);

/**
 * React events bubble through a portal to the component that rendered it, so selecting text in a
 * dialog opened from a column header dragged the columns behind it (the header's drag listeners), a key typed in
 * it reached the table's keyboard navigation, a click reached the cell that opened it. A dialog is its own world:
 * these stop at its root (native listeners — the dialog's own Esc / Tab, menus — are not React's and still run).
 */
const stop = (e: SyntheticEvent) => e.stopPropagation();
const FENCE = {
  onPointerDown: stop,
  onTouchStart: stop,
  onKeyDown: stop,
  onKeyUp: stop,
  onClick: stop,
  onDoubleClick: stop,
  onContextMenu: stop,
  onDragStart: stop,
};

/** Open dialogs, oldest first: Esc closes only the top one (a dialog opened from another keeps its parent). */
const dialogStack: symbol[] = [];

/**
 * Modal dialog (11-UI-DESIGN: Dialog) — the system's replacement for window.confirm/prompt/alert.
 * Esc and a backdrop click close it; Tab stays inside; focus returns to the opener on close.
 */
export const Dialog = ({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  role = 'dialog',
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  /** A muted line under the title (the board, the column and its type…). */
  subtitle?: string;
  children?: ReactNode;
  footer?: ReactNode;
  role?: 'dialog' | 'alertdialog';
  className?: string;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  // r16motion: the backdrop and the panel fade out (a ghost copy, `motion.ts`) — the dialog itself is gone at once.
  const exitRef = useExitRef<HTMLDivElement>();
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // P1-03: a dialog opened from an item card that sits over another dialog goes over that card.
  const overPanel = useMemo(() => open && panelOverModalOpen(), [open]);
  useEffect(() => {
    if (!open) return;
    const seq = nextLayerSeq();
    const opener = document.activeElement as HTMLElement | null;
    const panel = ref.current;
    const focusables = () =>
      Array.from(
        panel?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
    // r23ui: on a phone the fallback never lands in a text field (its keyboard would slide up unasked).
    const typing = (el: HTMLElement) =>
      el.tagName === 'TEXTAREA' ||
      el.isContentEditable ||
      (el.tagName === 'INPUT' && !NO_KEYBOARD_INPUTS.has((el as HTMLInputElement).type));
    if (!panel?.contains(document.activeElement))
      ((autoFocusSearch() ? focusables()[0] : focusables().find((el) => !typing(el))) ?? panel)?.focus();
    const me = Symbol('dialog');
    dialogStack.push(me);
    const onKey = (e: KeyboardEvent) => {
      // Every open dialog listens on document; only the top one acts (listeners there run oldest first).
      if (dialogStack[dialogStack.length - 1] !== me) return;
      // An item card opened over this dialog has the keys (its Esc closes the card, not this dialog).
      if (panelOverDialog(seq)) return;
      if (e.key === 'Escape') {
        if (layersAbove(ref.current)) return; // the open menu / popover closes first
        e.stopPropagation();
        closeRef.current();
      } else if (e.key === 'Tab') {
        const list = focusables();
        if (!list.length) return;
        const first = list[0]!;
        const last = list[list.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      dialogStack.splice(dialogStack.indexOf(me), 1);
      opener?.focus?.();
    };
  }, [open]);
  if (!open) return null;
  // On <body>: a dialog opened from inside a table row must not be clipped or covered by later rows.
  return createPortal(
    <div
      ref={exitRef}
      data-modal-root
      className={cn(
        'anim-scrim fixed inset-0 flex items-end justify-center bg-[var(--scrim)] md:items-start md:px-4 md:pt-16 md:pb-4',
        overPanel ? 'z-modal-over-panel' : 'z-modal',
      )}
      onMouseDown={(e) => {
        e.stopPropagation();
        if (!layersAbove(ref.current) && !closedALayer(e.nativeEvent)) onClose();
      }}
      {...FENCE}
    >
      <div
        ref={ref}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        className={cn(
          'anim-dialog flex max-h-[92dvh] w-full max-w-[560px] flex-col rounded-t-[var(--radius-panel)] border border-[var(--panel-border)] bg-surface shadow-[var(--shadow-pop)] outline-none max-md:max-w-none md:max-h-[calc(100dvh-5rem)] md:rounded-[var(--radius-panel)]',
          className,
        )}
      >
        {/* F4 canvas: a grip on phones (bottom sheet), title + subtitle with a close button, a divided footer. */}
        <span aria-hidden className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-line-strong md:hidden" />
        <div className="flex shrink-0 items-start justify-between gap-3 px-5 pt-[1.125rem] pb-3">
          <div className="min-w-0">
            <h2 id={titleId} className="font-display text-[1.1875rem] leading-tight font-extrabold text-heading">
              {title}
            </h2>
            {subtitle ? <p className="mt-0.5 text-xs text-muted">{subtitle}</p> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('dialog.close')}
            className="-me-1.5 -mt-1 grid size-9 shrink-0 place-items-center rounded-[10px] text-muted hover:bg-surface-2 hover:text-fg"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              aria-hidden
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        {/* Long content scrolls; the title and the buttons stay in view. */}
        <div className="min-h-0 flex-1 space-y-3.5 overflow-auto px-5 pt-1 pb-4">{children}</div>
        {footer ? (
          <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-line px-5 py-3.5">{footer}</div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
};
