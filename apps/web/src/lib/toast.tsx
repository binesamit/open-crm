// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState, useSyncExternalStore } from 'react';
import { t } from '@bines/shared';
import { cn, useExitRef } from '@bines/ui';

/**
 * Toasts at the top of the screen (07 §5.3): a line of text and optionally one action ("ביטול").
 * `<ToastHost />` is mounted once at the app root; at most three show, the newest on top.
 */
export type Toast = {
  id: number;
  message: string;
  tone: 'default' | 'error';
  action?: { label: string; run: () => unknown };
  /** Seconds before it closes by itself. */
  seconds: number;
  /** When it was shown (ms). */
  at: number;
};

let toasts: Toast[] = [];
let nextId = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const dismissToast = (id: number) => {
  toasts = toasts.filter((x) => x.id !== id);
  emit();
};

export const showToast = (opts: {
  message: string;
  tone?: Toast['tone'];
  action?: Toast['action'];
  seconds?: number;
}) => {
  // The same message twice at once (a global handler and the screen's own, e.g. a plan limit) shows once — the
  // first one, which may carry the action.
  const twin = toasts.find((x) => x.message === opts.message && Date.now() - x.at < 2000);
  if (twin) return twin.id;
  const toast: Toast = { id: ++nextId, tone: 'default', seconds: 5, at: Date.now(), ...opts };
  toasts = [toast, ...toasts].slice(0, 3);
  emit();
  return toast.id;
};

/**
 * Closes by itself after `seconds`; the pointer resting on it holds it open. r16motion: on its way out (by itself or
 * closed) it fades and lifts a little — a ghost copy (`useExitRef`), so it leaves the list at once.
 */
const ToastRow = ({ toast }: { toast: Toast }) => {
  const [hovered, setHovered] = useState(false);
  const exitRef = useExitRef<HTMLDivElement>();
  useEffect(() => {
    if (hovered) return;
    const close = setTimeout(() => dismissToast(toast.id), toast.seconds * 1000);
    return () => clearTimeout(close);
  }, [toast.id, toast.seconds, hovered]);
  return (
    <div
      ref={exitRef}
      role={toast.tone === 'error' ? 'alert' : 'status'}
      data-testid="toast"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={cn(
        'anim-toast pointer-events-auto flex min-w-72 max-w-[min(32rem,calc(100vw-2rem))] items-center gap-3 rounded-[14px] py-2.5 ps-4 pe-3 text-[0.8125rem] shadow-[var(--shadow-pop)]',
        // F4: dark ink in light mode, inverted (light) in dark mode.
        toast.tone === 'error' ? 'bg-danger text-white' : 'bg-[var(--toast-bg)] text-[var(--toast-fg)]',
      )}
    >
      <span className="min-w-0 flex-1 truncate">{toast.message}</span>
      {toast.action ? (
        <button
          type="button"
          data-testid="toast-action"
          onClick={() => {
            dismissToast(toast.id);
            void toast.action!.run();
          }}
          className="shrink-0 rounded-[var(--radius-sm)] px-2 py-0.5 font-semibold text-[var(--toast-action)] hover:bg-current/10"
        >
          {toast.action.label}
        </button>
      ) : null}
      <button
        type="button"
        aria-label={t('common.close')}
        onClick={() => dismissToast(toast.id)}
        className="grid size-6 shrink-0 place-items-center rounded-[var(--radius-sm)] opacity-70 hover:bg-current/10 hover:opacity-100"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden
        >
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  );
};

export const ToastHost = () => {
  const list = useSyncExternalStore(subscribe, () => toasts);
  if (!list.length) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-14 z-toast flex flex-col items-center gap-2 px-4">
      {list.map((toast) => (
        <ToastRow key={toast.id} toast={toast} />
      ))}
    </div>
  );
};
