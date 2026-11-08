// SPDX-License-Identifier: AGPL-3.0-only
import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from 'react';
import { useRouter, type ErrorComponentProps } from '@tanstack/react-router';
import { t, msgKey } from '@bines/shared';
import { Button, cn } from '@bines/ui';
import { Icon, type IconName } from './icons';
import { reportError } from './monitoring';
import { classifyError, reloadForNewVersion, type ErrorKind } from './errors';

/**
 * Round 12 (product owner: "sometimes the system just shows an empty page with an error"). Before, a crash in any page
 * fell through to TanStack Router's built-in "Something went wrong! / Show Error" over the whole app, in English —
 * and that catch-all boundary reports nothing in production, so GlitchTip never saw these crashes.
 *
 * Now every crash lands on this screen: what happened in plain Hebrew (by kind — a new version, no connection, a
 * bug…), "נסו שוב" (re-render + reload the route's data), "חזרה לדף הבית", the technical details collapsed, and the
 * error is sent to GlitchTip. `page` = a whole route; `panel` = one area (the item card, a view, a widget, a doc)
 * — the rest of the app keeps working around it (`AreaBoundary`).
 */
const ICON: Record<ErrorKind, IconName> = {
  chunk: 'restore',
  offline: 'warn',
  server: 'warn',
  not_found: 'search',
  forbidden: 'lock',
  app: 'warn',
};

export const ErrorScreen = ({
  error,
  onRetry,
  variant = 'page',
  area,
  homeHref,
  extra,
}: {
  error: unknown;
  /** "נסו שוב": re-render (and refetch). A new version's error reloads the page instead. */
  onRetry?: () => void;
  variant?: 'page' | 'panel';
  /** Tag for GlitchTip (`area`) and `data-area` for tests. */
  area?: string;
  /** Where "חזרה לדף הבית" goes; default `/` (the account picker sends to the last account). */
  homeHref?: string;
  /** More actions (the item card's "close"). */
  extra?: ReactNode;
}) => {
  const kind = classifyError(error);
  const [details, setDetails] = useState(false);
  useEffect(() => {
    // Only bugs are worth a report; a blip or a deleted item is not.
    if (kind === 'app' || kind === 'chunk') reportError(error, area);
  }, [error, kind, area]);
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const retry = () => {
    if (kind === 'chunk') reloadForNewVersion(null);
    else onRetry?.();
  };
  const page = variant === 'page';
  return (
    <div
      role="alert"
      data-testid="error-screen"
      data-kind={kind}
      data-area={area}
      className={cn(
        'flex w-full justify-center',
        page ? 'min-h-[60dvh] items-center px-4 py-10' : 'items-start px-3 py-6',
      )}
    >
      <div
        className={cn(
          'w-full space-y-4 rounded-[var(--radius-lg)] border border-line bg-surface text-start',
          page ? 'max-w-md p-6 shadow-[var(--shadow-pop)]' : 'max-w-sm p-4',
        )}
      >
        <div className="flex items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-full bg-danger-soft text-danger-fg">
            <Icon name={ICON[kind]} size={20} />
          </span>
          <div className="min-w-0 space-y-1">
            <h2 className="font-display text-[1.0625rem] font-bold text-heading" data-testid="error-title">
              {t(msgKey(`r12.error.${kind}.title`))}
            </h2>
            <p className="text-sm text-fg-2">{t(msgKey(`r12.error.${kind}.body`))}</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {onRetry || kind === 'chunk' ? (
            <Button data-testid="error-retry" onClick={retry}>
              <Icon name="restore" size={14} />
              {t(msgKey(kind === 'chunk' ? 'r12.error.reload' : 'r12.error.retry'))}
            </Button>
          ) : null}
          <Button variant="secondary" data-testid="error-home" onClick={() => window.location.assign(homeHref ?? '/')}>
            <Icon name="home" size={14} />
            {t('r12.error.home')}
          </Button>
          {extra}
        </div>
        <div className="border-t border-line-soft pt-2">
          <button
            type="button"
            data-testid="error-details-toggle"
            aria-expanded={details}
            onClick={() => setDetails((d) => !d)}
            className="flex items-center gap-1 rounded-[6px] text-xs text-muted hover:text-fg"
          >
            <Icon name={details ? 'chevronDown' : 'chevronStart'} size={12} />
            {t('r12.error.details')}
          </button>
          {details ? (
            <pre
              dir="ltr"
              data-testid="error-details"
              className="mt-2 max-h-48 overflow-auto rounded-[8px] bg-surface-2 p-2 text-start text-[0.6875rem] whitespace-pre-wrap text-fg-2"
            >
              {message}
            </pre>
          ) : null}
        </div>
      </div>
    </div>
  );
};

/**
 * The routes' error component (`defaultErrorComponent`): "נסו שוב" resets the boundary and re-runs the route's
 * loaders (`router.invalidate`) — a request that failed while the server restarted succeeds the second time.
 */
export const RouteErrorScreen = ({ error, reset }: ErrorComponentProps) => {
  const router = useRouter();
  return (
    <ErrorScreen
      error={error}
      area="route"
      onRetry={() => {
        reset();
        void router.invalidate();
      }}
    />
  );
};

type BoundaryProps = {
  children: ReactNode;
  /** GlitchTip tag + `data-area` (item, view, widget, doc…). */
  area: string;
  /** A change (another item / view / widget) clears the error. */
  resetKey?: unknown;
  /** Replaces the default panel (e.g. inside the item card's frame, so it can still be closed). */
  fallback?: (props: { error: unknown; retry: () => void }) => ReactNode;
  className?: string;
};

/**
 * One area's error boundary: a crash in it shows the panel error screen in its place, and only there — the
 * board, the sidebar and the other widgets keep working. "נסו שוב" re-renders the area.
 */
export class AreaBoundary extends Component<BoundaryProps, { error: unknown; key: unknown; tries: number }> {
  override state = { error: null as unknown, key: this.props.resetKey, tries: 0 };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  static getDerivedStateFromProps(props: BoundaryProps, state: { error: unknown; key: unknown; tries: number }) {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }

  override componentDidCatch(error: unknown, _info: ErrorInfo) {
    // The screen reports bugs itself (once per error); a custom fallback may not render it.
    if (this.props.fallback && classifyError(error) === 'app') reportError(error, this.props.area);
  }

  retry = () => this.setState((s) => ({ error: null, tries: s.tries + 1 }));

  override render() {
    const { error, tries } = this.state;
    if (error) {
      return this.props.fallback ? (
        this.props.fallback({ error, retry: this.retry })
      ) : (
        <div className={this.props.className}>
          <ErrorScreen error={error} variant="panel" area={this.props.area} onRetry={this.retry} />
        </div>
      );
    }
    // `tries` remounts the area on "נסו שוב" (fresh state, its queries re-run on mount).
    return <AreaChildren key={tries}>{this.props.children}</AreaChildren>;
  }
}

const AreaChildren = ({ children }: { children: ReactNode }) => <>{children}</>;

/** The app's last boundary (outside the router): the page error screen, "נסו שוב" reloads. */
export class AppErrorBoundary extends Component<{ children: ReactNode }, { error: unknown }> {
  override state = { error: null as unknown };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  override render() {
    if (this.state.error)
      return (
        <div className="min-h-dvh bg-bg">
          <ErrorScreen error={this.state.error} area="app" onRetry={() => window.location.reload()} />
        </div>
      );
    return this.props.children;
  }
}
