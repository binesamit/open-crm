// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useRouterState } from '@tanstack/react-router';
import { type MessageKey, t } from '@bines/shared';
import { cn } from '@bines/ui';
import type { MyAccount } from '../../lib/api';
import { Icon } from '../../lib/icons';
import { usePlanGate } from '../../lib/plan-gate';
import { AssistantPanel } from './AssistantPanel';

/**
 * The AI panel from anywhere: a button in the shell (the sidebar's quick row, the rail, the phone
 * header) and the quick search's "ask the agent" row open one panel about where the person is — an item, a board, a
 * document, a dashboard, or the whole account — to chat with the assistant or one of the account's agents. No
 * shortcut of its own (product decision: Ctrl+K is the browser's address-bar search; Ctrl+B stays quick search).
 */
const OPEN_EVENT = 'bines:assistant-open';

/** Opens the shell's AI panel (the launcher buttons, quick search); `prefill`: a first message ready to send. */
export const openAssistant = (prefill?: string) =>
  window.dispatchEvent(new CustomEvent<string | undefined>(OPEN_EVENT, { detail: prefill }));

type Place = { boardId?: string; itemId?: string; docId?: string; dashboardId?: string };

/** Where the person is: the ids in the current route (the deepest match wins). */
const usePlace = (): Place =>
  useRouterState({
    select: (s) => {
      const params = Object.assign({}, ...s.matches.map((m) => m.params)) as Record<string, string | undefined>;
      return {
        boardId: params.boardId,
        itemId: params.itemId,
        docId: params.docId,
        dashboardId: params.dashboardId,
      };
    },
    structuralSharing: true,
  });

const nameIn = (data: unknown): string | null => {
  const d = data as { name?: unknown; doc?: { name?: unknown }; dashboard?: { name?: unknown } } | undefined;
  const name = d?.name ?? d?.doc?.name ?? d?.dashboard?.name;
  return typeof name === 'string' && name ? name : null;
};

/** The panel's subtitle: the place's name when it is already loaded on the page, else what kind of place it is. */
const usePlaceTitle = (accountId: string, p: Place) => {
  const qc = useQueryClient();
  const [kind, key]: [MessageKey, readonly unknown[] | null] = p.itemId
    ? ['ai2.place.item', ['account', accountId, 'item', p.itemId]]
    : p.boardId
      ? ['ai2.place.board', ['account', accountId, 'board', p.boardId]]
      : p.docId
        ? ['ai2.place.doc', ['account', accountId, 'doc', p.docId]]
        : p.dashboardId
          ? ['ai2.place.dashboard', ['account', accountId, 'dashboard', p.dashboardId]]
          : ['ai2.place.account', null];
  const name = key ? nameIn(qc.getQueryData(key)) : null;
  return name ? `${t(kind)}: ${name}` : t(kind);
};

/** The one panel of the shell, opened by `openAssistant()` (never while the plan has no AI). */
export const AssistantHost = ({ account }: { account: MyAccount }) => {
  // `prefill` (from quick search) opens a new conversation with that text ready; `n` remounts the panel for it.
  const [open, setOpen] = useState<{ prefill?: string; n: number } | null>(null);
  const gate = usePlanGate(account.id, 'ai');
  const place = usePlace();
  const title = usePlaceTitle(account.id, place);
  const show = useCallback(
    (e: Event) => setOpen((o) => ({ prefill: (e as CustomEvent<string | undefined>).detail, n: (o?.n ?? 0) + 1 })),
    [],
  );
  useEffect(() => {
    window.addEventListener(OPEN_EVENT, show);
    return () => window.removeEventListener(OPEN_EVENT, show);
  }, [show]);
  if (!open || !gate.allowed) return null;
  return (
    <AssistantPanel
      // A new place is a new panel (its own conversations); so is a question sent from quick search.
      key={`${place.itemId}${place.boardId}${place.docId}${place.dashboardId}${open.prefill ? open.n : ''}`}
      accountId={account.id}
      slug={account.slug}
      {...place}
      title={title}
      {...(open.prefill ? { prefill: open.prefill } : {})}
      onClose={() => setOpen(null)}
    />
  );
};

/** The launcher, in the shell's styles (like quick search): the sidebar's icon row, the rail, the phone header. */
export const AssistantLauncher = ({
  account,
  variant,
  className,
}: {
  account: MyAccount;
  variant: 'icon' | 'rail' | 'header';
  /** Overrides the button's size (the top bar and the sidebar header). */
  className?: string;
}) => {
  const gate = usePlanGate(account.id, 'ai');
  if (!gate.allowed) return null;
  return (
    <button
      type="button"
      data-testid="assistant-open"
      aria-label={t('ai2.assistant.open')}
      title={t('ai2.assistant.open')}
      onClick={() => openAssistant()}
      className={cn(
        'text-shell-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]',
        variant === 'rail' &&
          'grid size-12 place-items-center rounded-[14px] hover:bg-[var(--shell-hover)] hover:text-white',
        variant === 'icon' &&
          'grid size-10 place-items-center rounded-[10px] hover:bg-[var(--shell-hover)] hover:text-white',
        variant === 'header' && 'grid size-9 place-items-center rounded-[10px] hover:bg-[var(--shell-hover)]',
        className,
      )}
    >
      <Icon name="sparkle" size={variant === 'rail' ? 24 : variant === 'icon' ? 19 : 18} />
    </button>
  );
};
