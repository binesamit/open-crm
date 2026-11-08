// SPDX-License-Identifier: AGPL-3.0-only
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  groupColorHex,
  paint,
  type MessageKey,
  SEARCH_MIN,
  type SearchResult,
  t,
  updateLinkSearch,
} from '@bines/shared';
import { autoFocusSearch, Avatar, Button, ClearSearchButton, cn, SkeletonRows, useLayer } from '@bines/ui';
import { Icon } from '../../lib/icons';
import { isModLetter } from '../../lib/keys';
import { api, type MyAccount } from '../../lib/api';
import { helpHiddenFor } from '../support/kb-page';
import { usePlanGate } from '../../lib/plan-gate';
import { openAssistant } from '../ai2/GlobalAssistant';

/** `>` in the palette: go to a page (07 §9.1). Paths are under /a/<slug>. */
const COMMANDS: { id: string; path: string }[] = [
  { id: 'home', path: '' },
  { id: 'myWork', path: '/my-work' },
  { id: 'inbox', path: '/inbox' },
  { id: 'notifications', path: '/profile?tab=notifications' },
  { id: 'tokens', path: '/profile?tab=tokens' },
  { id: 'automations', path: '/automations' },
  { id: 'archive', path: '/archive' },
  { id: 'trash', path: '/trash' },
  // The knowledge center's page — not for guests nor inside a support grant.
  { id: 'help', path: '/help' },
];

type Row = {
  key: string;
  kind: 'item' | 'board' | 'doc' | 'dashboard' | 'update' | 'person' | 'recent' | 'tag' | 'file' | 'command' | 'ai';
  title: string;
  sub?: string;
  /** Muted text at the end of the row (a board's workspace, a person's email). */
  end?: string;
  /** The group's colour bar (items) or the tag's colour. */
  color?: string;
  /** The author / person shown as a 24px avatar. */
  person?: string;
  go: () => void;
};

/** A group colour key (or a hex) as a colour that follows the theme; nothing for an unknown value. */
const colorOf = (c: string | null | undefined) => (c ? paint(groupColorHex(c, c)) : undefined);

/** The search text in bold inside a result's text (first match, any case). */
const withMatch = (text: string, q: string): ReactNode => {
  const at = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <b className="font-semibold text-heading">{text.slice(at, at + q.length)}</b>
      {text.slice(at + q.length)}
    </>
  );
};

const Kbd = ({ children, className }: { children: ReactNode; className?: string }) => (
  <kbd
    className={cn(
      'rounded-[5px] border border-line bg-surface-2 px-1.5 py-px font-mono text-[0.6875rem] font-medium whitespace-nowrap text-fg-2',
      className,
    )}
  >
    {children}
  </kbd>
);

/**
 * Search everything (07 §9.1): Ctrl+B or the magnifier in the top bar. Items (name or cell text), boards,
 * updates, people, tags and files of this account, as far as I may see them; ↑ ↓ to move, Enter to open, Esc to
 * close. "Include archive" searches archived items too; `>` lists commands. Recent searches are kept on the
 * server (per user and account).
 */
/**
 * `variant`: "field" = a search box in the sidebar, "rail" = an icon in the collapsed rail, "icon" = a round icon
 * (mobile top bar). All open the same palette (also Ctrl+B).
 */
export const SearchPalette = ({
  account,
  variant = 'icon',
  className,
}: {
  account: MyAccount;
  variant?: 'field' | 'rail' | 'icon';
  /** Overrides the trigger's size and margins (the top bar's field, the sidebar's full-width field). */
  className?: string;
}) => {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [active, setActive] = useState(0);
  const [withArchive, setWithArchive] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const aiGate = usePlanGate(account.id, 'ai');
  const qc = useQueryClient();
  const recentKey = ['account', account.id, 'search-recent'];
  const recentQuery = useQuery({
    queryKey: recentKey,
    queryFn: () => api(account.id).get<{ data: string[] }>('/search/recent'),
    enabled: open,
    staleTime: 30_000,
  });
  const recent = recentQuery.data?.data ?? [];
  const remember = (text: string) =>
    void api(account.id)
      .post<{ data: string[] }>('/search/recent', { q: text })
      .then((r) => qc.setQueryData(recentKey, r))
      .catch(() => undefined);

  const show = useCallback(() => setOpen(true), []);

  // Ctrl+B anywhere but a rich editor (where it means bold) — on any keyboard layout (with a Hebrew
  // layout `e.key` is "נ", so the physical key decides too).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isModLetter(e, 'b')) return;
      if ((e.target as HTMLElement | null)?.isContentEditable) return;
      e.preventDefault();
      show();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [show]);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(q.trim()), 200);
    return () => clearTimeout(id);
  }, [q]);

  const close = () => {
    setOpen(false);
    setQ('');
    setDebounced('');
    setActive(0);
  };
  useLayer(panel, open, close);

  const command = q.trimStart().startsWith('>');
  const results = useQuery({
    queryKey: ['account', account.id, 'search', debounced, withArchive],
    queryFn: () =>
      api(account.id).get<SearchResult>(
        `/search?q=${encodeURIComponent(debounced)}${withArchive ? '&archived=1' : ''}`,
      ),
    // A `#tag` search may be one character; `>` is never sent.
    enabled:
      open && !command && (debounced.length >= SEARCH_MIN || (debounced.startsWith('#') && debounced.length > 1)),
    staleTime: 10_000,
  });

  const rows = useMemo<{ section: string; rows: Row[] }[]>(() => {
    const go = (to: () => void) => () => {
      if (debounced) remember(debounced);
      close();
      to();
    };
    const slug = account.slug;
    if (command) {
      const text = q.trim().slice(1).trim().toLowerCase();
      return [
        {
          section: t('search.commands'),
          rows: COMMANDS
            // Guests have only their profile: no tokens, archive or trash.
            .filter((c) => account.role !== 'guest' || !['tokens', 'archive', 'trash'].includes(c.id))
            .filter((c) => c.id !== 'help' || !helpHiddenFor(account))
            .map((c) => ({ ...c, label: t(`search.cmd.${c.id}` as MessageKey) }))
            .filter((c) => c.label.toLowerCase().includes(text))
            .map((c) => ({
              key: `c:${c.id}`,
              kind: 'command' as const,
              title: c.label,
              go: () => {
                close();
                void navigate({ to: `/a/${slug}${c.path}` as never });
              },
            })),
        },
      ];
    }
    // Product decision (Ctrl+B stays search): the typed text can go to the agent instead — the AI panel opens
    // with it ready to send. The last row, so Enter still opens the first result.
    const typed = q.trim();
    const ask: { section: string; rows: Row[] }[] =
      aiGate.allowed && typed && !typed.startsWith('#')
        ? [
            {
              section: t('search.askAgent'),
              rows: [
                {
                  key: 'ai:ask',
                  kind: 'ai' as const,
                  title: t('search.askAgentRow', { q: typed }),
                  go: () => {
                    close();
                    openAssistant(typed);
                  },
                },
              ],
            },
          ]
        : [];
    if (debounced.length < SEARCH_MIN && !(debounced.startsWith('#') && debounced.length > 1))
      return [
        ...(recent.length
          ? [
              {
                section: t('search.recent'),
                rows: recent.map((r) => ({ key: `r:${r}`, kind: 'recent' as const, title: r, go: () => setQ(r) })),
              },
            ]
          : []),
        ...ask,
      ];
    const r = results.data;
    if (!r) return ask;
    const tagSearch = debounced.startsWith('#');
    // `updateId` (s37reply): an update hit opens that update's thread alone.
    const toItem = (boardId: string, itemId: string, tab?: 'updates', updateId?: string) => () =>
      void navigate({
        to: '/a/$accountSlug/b/$boardId/i/$itemId',
        params: { accountSlug: slug, boardId, itemId },
        search: updateId ? updateLinkSearch(updateId) : tab ? { tab } : {},
      } as never);
    const found: { section: string; rows: Row[] }[] = [
      {
        // A tag row narrows the search to that tag's items (`#name`).
        section: t('search.tags'),
        rows: r.tags.map((x) => ({
          key: `t:${x.id}`,
          kind: 'tag' as const,
          title: `#${x.name}`,
          color: colorOf(x.color),
          go: () => setQ(`#${x.name}`),
        })),
      },
      {
        // A `#tag` search lists that tag's items (fix2); a plain search finds tagged items too (`#tag` in the row).
        section: tagSearch ? t('search.taggedWith', { tag: debounced }) : t('search.items'),
        rows: r.items.map((i) => ({
          key: `i:${i.id}`,
          kind: 'item' as const,
          title: i.name,
          sub: [i.archived ? t('search.archived') : null, i.board.name, i.group?.title, i.matched]
            .filter(Boolean)
            .join(' · '),
          color: colorOf(i.group?.color),
          go: go(toItem(i.board.id, i.id)),
        })),
      },
      {
        section: t('search.boards'),
        rows: r.boards.map((b) => ({
          key: `b:${b.id}`,
          kind: 'board' as const,
          title: b.name,
          end: b.workspace ?? undefined,
          go: go(
            () => void navigate({ to: '/a/$accountSlug/b/$boardId', params: { accountSlug: slug, boardId: b.id } }),
          ),
        })),
      },
      {
        // Docs (M8): by name or text — the text around the match when the name did not match.
        section: t('search.docs'),
        rows: (r.docs ?? []).map((d) => ({
          key: `d:${d.id}`,
          kind: 'doc' as const,
          title: `📄 ${d.name}`,
          sub: d.excerpt ?? undefined,
          end: d.workspace ?? undefined,
          go: go(() => void navigate({ to: '/a/$accountSlug/d/$docId', params: { accountSlug: slug, docId: d.id } })),
        })),
      },
      {
        // Dashboards by name — only those I may open (a guest: the ones shared with them).
        section: t('search.dashboards'),
        rows: (r.dashboards ?? []).map((d) => ({
          key: `db:${d.id}`,
          kind: 'dashboard' as const,
          title: `📊 ${d.name}`,
          end: d.workspace ?? undefined,
          go: go(
            () =>
              void navigate({
                to: '/a/$accountSlug/dash/$dashboardId',
                params: { accountSlug: slug, dashboardId: d.id },
              } as never),
          ),
        })),
      },
      {
        section: t('search.updates'),
        rows: r.updates.map((u) => ({
          key: `u:${u.id}`,
          kind: 'update' as const,
          title: u.excerpt,
          sub: [u.author, u.item.name, u.board.name].filter(Boolean).join(' · '),
          person: u.author ?? undefined,
          go: go(toItem(u.board.id, u.item.id, 'updates', u.id)),
        })),
      },
      {
        section: t('search.files'),
        rows: r.files.map((f) => ({
          key: `f:${f.id}:${f.item.id}`,
          kind: 'file' as const,
          title: `📎 ${f.name}`,
          sub: [f.item.name, f.board.name].join(' · '),
          go: go(toItem(f.board.id, f.item.id, f.in_update ? 'updates' : undefined)),
        })),
      },
      {
        section: t('search.people'),
        rows: r.people.map((p) => ({
          key: `p:${p.id}`,
          kind: 'person' as const,
          title: p.name || p.email,
          end: p.email,
          person: p.name || p.email,
          go: go(() => void navigate({ to: '/a/$accountSlug', params: { accountSlug: slug } })),
        })),
      },
    ]
      .filter((s) => s.rows.length)
      .sort((a, b) =>
        tagSearch ? Number(b.section !== t('search.tags')) - Number(a.section !== t('search.tags')) : 0,
      );
    return [...found, ...ask];
    // `close` and `navigate` are stable enough for a list rebuilt on every result
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results.data, debounced, recent, account.id, account.slug, command, q, aiGate.allowed]);
  const flat = rows.flatMap((s) => s.rows);
  const hits = flat.some((r) => r.kind !== 'ai');
  const current = Math.min(active, Math.max(0, flat.length - 1));

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!flat.length) return;
      setActive((current + (e.key === 'ArrowDown' ? 1 : flat.length - 1)) % flat.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      flat[current]?.go();
    }
  };

  return (
    <>
      <button
        type="button"
        data-testid="search-open"
        data-tour="nav.search"
        aria-label={t('search.open')}
        title={`${t('search.open')} (Ctrl+B)`}
        onClick={show}
        className={cn(
          'text-shell-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]',
          variant === 'field' &&
            'mb-2 flex h-[2.125rem] w-full items-center gap-2 rounded-[10px] bg-[var(--shell-input)] px-2.5 text-start text-sm text-shell-fg hover:bg-[var(--shell-active)]',
          variant === 'rail' &&
            'grid size-12 place-items-center rounded-[14px] hover:bg-[var(--shell-hover)] hover:text-white',
          variant === 'icon' &&
            'grid size-10 place-items-center rounded-[10px] hover:bg-[var(--shell-hover)] hover:text-white',
          className,
        )}
      >
        <Icon name="search" size={variant === 'rail' ? 24 : variant === 'icon' ? 19 : 15} strokeWidth={1.9} />
        {variant === 'field' ? (
          <>
            {/* Prod (canvas): "חיפוש" and the shortcut, in the shell's text colour (AA on the field). */}
            <span className="min-w-0 flex-1 truncate">{t('navLayout.slot.search' as MessageKey)}</span>
            <kbd
              dir="ltr"
              className="rounded-[5px] border border-[var(--shell-line-strong)] px-1.5 py-px font-body text-[0.6875rem] whitespace-nowrap"
            >
              Ctrl+B
            </kbd>
          </>
        ) : null}
      </button>
      {open
        ? createPortal(
            <div className="fixed inset-0 z-palette flex items-start justify-center bg-[var(--scrim)] md:px-4 md:pt-20">
              <div
                ref={panel}
                role="dialog"
                aria-label={t('search.open')}
                data-testid="search-palette"
                className="flex h-full w-full flex-col overflow-hidden bg-surface shadow-[var(--shadow-pop)] md:h-auto md:max-h-[75vh] md:max-w-[680px] md:rounded-[20px] md:border md:border-line"
              >
                <div className="flex items-center gap-2.5 border-b border-line px-4 py-3.5">
                  <Icon name="search" size={18} className="shrink-0 text-muted" />
                  <input
                    autoFocus={autoFocusSearch()}
                    value={q}
                    onChange={(e) => {
                      setQ(e.target.value);
                      setActive(0);
                    }}
                    onKeyDown={onKeyDown}
                    placeholder={t('search.placeholder')}
                    aria-label={t('search.placeholder')}
                    data-testid="search-input"
                    role="combobox"
                    aria-expanded={flat.length > 0}
                    aria-controls="search-results"
                    aria-activedescendant={flat[current] ? `sr-${flat[current]!.key}` : undefined}
                    className="min-w-0 flex-1 bg-transparent text-[1.0625rem] text-fg outline-none placeholder:text-muted"
                  />
                  <ClearSearchButton
                    value={q}
                    testId="search-input-clear"
                    onClear={() => {
                      setQ('');
                      setActive(0);
                    }}
                  />
                  <Kbd className="max-md:hidden">Esc</Kbd>
                  <Button variant="ghost" size="sm" className="md:hidden" onClick={close}>
                    {t('common.cancel')}
                  </Button>
                </div>
                <div className="flex flex-wrap items-center gap-3 border-b border-line-soft px-4 py-2 text-xs">
                  <label className="flex items-center gap-1.5 text-fg-2">
                    <input
                      type="checkbox"
                      data-testid="search-archived"
                      checked={withArchive}
                      onChange={(e) => setWithArchive(e.target.checked)}
                      className="size-3.5 accent-[var(--check)]"
                    />
                    {t('search.includeArchive')}
                  </label>
                  <span className="text-muted">
                    {t('search.commandsHint').startsWith('>') ? (
                      <>
                        <Kbd>&gt;</Kbd>
                        {t('search.commandsHint').slice(1)}
                      </>
                    ) : (
                      t('search.commandsHint')
                    )}
                  </span>
                  {recent.length && !q ? (
                    <button
                      type="button"
                      data-testid="search-recent-clear"
                      className="ms-auto text-muted hover:text-fg hover:underline"
                      onClick={() =>
                        void api(account.id)
                          .delete<{ data: string[] }>('/search/recent')
                          .then((r) => qc.setQueryData(recentKey, r))
                      }
                    >
                      {t('search.clearRecent')}
                    </button>
                  ) : null}
                </div>
                <div id="search-results" role="listbox" className="flex-1 overflow-y-auto p-1.5">
                  {debounced.length >= SEARCH_MIN && results.isFetching && !results.data ? (
                    <SkeletonRows rows={4} label={t('app.loading')} className="px-2.5 py-3" />
                  ) : (
                    <>
                      {/* Nothing found (the "ask the agent" row is not a result: it still shows, below). */}
                      {debounced.length >= SEARCH_MIN && !hits ? (
                        <p className="px-4 py-6 text-center text-sm text-muted" data-testid="search-empty">
                          {t('search.none')}
                        </p>
                      ) : debounced.length < SEARCH_MIN && !hits ? (
                        <p className="px-4 py-6 text-center text-sm text-muted">{t('search.hint')}</p>
                      ) : null}
                      {rows.map((s) => (
                        <section key={s.section}>
                          <h3 className="px-2.5 pt-2 pb-1 text-[0.6875rem] font-semibold text-muted">{s.section}</h3>
                          {s.rows.map((r) => {
                            const i = flat.indexOf(r);
                            const on = i === current;
                            const twoLine = !!r.sub;
                            return (
                              <div
                                key={r.key}
                                id={`sr-${r.key}`}
                                role="option"
                                aria-selected={on}
                                data-testid="search-result"
                                data-kind={r.kind}
                                onMouseEnter={() => setActive(i)}
                                onClick={r.go}
                                className={cn(
                                  'flex cursor-pointer items-center gap-2.5 rounded-[9px] px-2.5 text-[0.8125rem] text-fg',
                                  twoLine ? 'h-12' : 'h-[2.125rem]',
                                  on && 'bg-surface-2',
                                )}
                              >
                                {r.kind === 'board' ? (
                                  <Icon name="board" size={16} className="shrink-0 text-muted" />
                                ) : r.person ? (
                                  <Avatar name={r.person} size={24} />
                                ) : r.color ? (
                                  <span
                                    aria-hidden
                                    className="h-6 w-2 shrink-0 rounded-[4px]"
                                    style={{ background: r.color }}
                                  />
                                ) : null}
                                <span className="flex min-w-0 flex-1 flex-col">
                                  <span
                                    className={cn(
                                      'truncate',
                                      (r.kind === 'item' || r.kind === 'tag') && 'font-semibold',
                                    )}
                                  >
                                    {r.kind === 'update' ? withMatch(r.title, debounced) : r.title}
                                  </span>
                                  {twoLine ? (
                                    <span className="truncate text-[0.6875rem] text-muted">{r.sub}</span>
                                  ) : null}
                                </span>
                                {r.end ? (
                                  <span className="max-w-[40%] shrink-0 truncate text-xs text-muted">{r.end}</span>
                                ) : null}
                                {on ? <Kbd className="shrink-0 max-md:hidden">Enter</Kbd> : null}
                              </div>
                            );
                          })}
                        </section>
                      ))}
                    </>
                  )}
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
};
