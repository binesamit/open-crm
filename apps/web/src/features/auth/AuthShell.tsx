// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from 'react';
import { cn } from '@bines/ui';
import { useBranding } from '../../lib/branding';
import { LegalLinks } from '../legal/legal-links';
import { SourceLink } from '../legal/source-link';

/** The F4 auth inputs (`.input.lg`): 44px, radius 12, 14px text. */
export const AUTH_INPUT = 'h-11 rounded-[12px] text-[0.875rem]';

/**
 * Login / invitation screens (F4): the brand on the shell with a soft amber glow, the form in a floating panel,
 * and an optional line under the panel.
 */
export const AuthShell = ({
  title,
  subtitle,
  eyebrow,
  footer,
  icon,
  centered,
  wide,
  testId,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  /** A chip above the title (e.g. "הזמנה"). */
  eyebrow?: ReactNode;
  /** A small line below the panel, on the shell. */
  footer?: ReactNode;
  /** A 64px icon tile above the title (the sign-up status screens: check your email, under review, closed). */
  icon?: ReactNode;
  /** The panel's content centred (a status screen, not a form). */
  centered?: boolean;
  /** A 460px panel (the sign-up form) instead of 420px. */
  wide?: boolean;
  testId?: string;
  children: ReactNode;
}) => {
  const { productName } = useBranding();
  return (
    <main
      className="flex min-h-dvh items-center justify-center bg-shell bg-[radial-gradient(1200px_600px_at_80%_-10%,rgba(255,176,32,0.10),transparent_60%)] px-4 py-8"
      data-testid={testId}
    >
      <div className={cn('flex w-full flex-col gap-5', wide ? 'max-w-[460px]' : 'max-w-[420px]')}>
        <p className="flex items-center justify-center gap-2.5 text-white">
          <span className="grid size-10 place-items-center rounded-full bg-accent font-display text-xl font-extrabold text-on-accent">
            {productName.trim().charAt(0).toUpperCase()}
          </span>
          <span className="font-display text-[1.375rem] font-extrabold" data-testid="auth-product-name">
            {productName}
          </span>
        </p>
        <div
          className={cn(
            'app-panel flex flex-col gap-[1.125rem] p-7 max-md:p-5',
            centered && 'items-center text-center',
          )}
        >
          {icon ?? null}
          <div className={cn('flex flex-col gap-1', centered && 'items-center')}>
            {eyebrow ? <span className={cn('mb-0.5', centered ? 'self-center' : 'self-start')}>{eyebrow}</span> : null}
            <h1 className="font-display text-[1.625rem] leading-[1.15] font-extrabold tracking-[-0.4px] text-heading">
              {title}
            </h1>
            {subtitle ? <p className="text-sm text-muted">{subtitle}</p> : null}
          </div>
          {children}
        </div>
        {footer ? <p className="text-center text-xs text-shell-muted">{footer}</p> : null}
        {/*: terms, privacy … on every sign-in screen (what the platform published; nothing when none). */}
        <LegalLinks className="text-xs text-shell-muted" />
        {/* AGPL section 13: the source of the running code, on every sign-in screen. */}
        <SourceLink />
      </div>
    </main>
  );
};

export const Divider = ({ label }: { label: string }) => (
  <div className="flex items-center gap-2.5 text-xs text-muted">
    <span className="h-px flex-1 bg-[var(--line)]" />
    {label}
    <span className="h-px flex-1 bg-[var(--line)]" />
  </div>
);

/** Google's "G" mark in its own colours (brand mark — not themable). */
export const GoogleMark = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden className="shrink-0">
    <path
      fill="#4285F4"
      d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z"
    />
    <path
      fill="#34A853"
      d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09C3.26 21.3 7.31 24 12 24z"
    />
    <path
      fill="#FBBC05"
      d="M5.27 14.29c-.25-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.98-3.09z"
    />
    <path
      fill="#EA4335"
      d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75z"
    />
  </svg>
);

/** Microsoft's four squares (the sign-in button's mark, as Microsoft's branding guidelines ask). */
export const MicrosoftMark = () => (
  <svg width="16" height="16" viewBox="0 0 21 21" aria-hidden className="shrink-0">
    <rect x="1" y="1" width="9" height="9" fill="#f25022" />
    <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
    <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
    <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
  </svg>
);
