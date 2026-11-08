// SPDX-License-Identifier: AGPL-3.0-only
import { NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { isId, orderColumns, t, type ItemsPage, UPDATE_SEEN, msgKey } from '@bines/shared';
import { cn, Picker } from '@bines/ui';
import { api } from '../../../lib/api';
import { Icon } from '../../../lib/icons';
import { useEventStream } from '../../../lib/realtime';
import { type BoardDetail, type Item, useBoard } from '../../board/board-api';
import { useViews } from '../../board/views/views-api';
import { useDocEnv } from './doc-env';


/**
 * Live pieces of other objects inside a doc (M8 ד2, plan §3.2). Each one is loaded through the regular API with
 * the READER's access (never the writer's): a board / item the reader may not see shows "restricted", and what
 * they see refreshes when the board changes (its event stream).
 */
const EMBED_ROWS = 20;
const EMBED_COLUMNS = 5;

const Restricted = ({ kind }: { kind: 'board' | 'item' | 'doc' }) => (
  <span className="inline-flex items-center gap-1 text-sm text-muted" data-testid="doc-embed-restricted">
    <Icon name="lock" size={13} />
    {t(msgKey(`docs2.restricted.${kind}`))}
  </span>
);

/** The board's live events refetch what an embed shows. */
const useLiveBoard = (boardId: string | null, keys: unknown[][]) => {
  const { accountId } = useDocEnv();
  const qc = useQueryClient();
  useEventStream(boardId ? `/boards/${boardId}/events` : null, accountId, (e) => {
    if (e.type === UPDATE_SEEN) return; // r16seen: who saw an update shows in no embed
    for (const key of keys) void qc.invalidateQueries({ queryKey: key });
  });
};

const cellText = (item: Item, columnId: string) => item.cells[columnId]?.text ?? '';

/** S-41: ids come from doc content (anyone who can edit the doc) — only a real id may reach an API path. */
export const safeId = (value: unknown): string => {
  const id = typeof value === 'string' ? value : '';
  return isId(id) ? id : '';
};

/** A board (one of its views: filter, sort, columns) as a small read-only table, with "open the board". */
export const BoardEmbedView = ({ node, updateAttributes, editor }: ReactNodeViewProps) => {
  const { accountId, slug } = useDocEnv();
  const boardId = safeId(node.attrs.board_id);
  const board = useBoard(accountId, boardId);
  const views = useViews(accountId, boardId).data?.data ?? [];
  const view = views.find((v) => v.id === node.attrs.view_id) ?? views.find((v) => v.is_default) ?? views[0];
  const itemsKey = ['account', accountId, 'doc-embed', boardId, view?.id ?? 'none'];
  const items = useQuery({
    queryKey: itemsKey,
    queryFn: () =>
      api(accountId).post<ItemsPage>(`/boards/${encodeURIComponent(boardId)}/items/query`, {
        ...(view?.settings.query ?? {}),
        ignore_invalid_rules: true, // a saved view: a rule that no longer applies is skipped
        limit: EMBED_ROWS,
      }),
    enabled: !!board.data && views.length > 0,
    retry: false,
  });
  useLiveBoard(board.data ? boardId : null, [itemsKey]);
  const label = String(node.attrs.label ?? '');

  return (
    <NodeViewWrapper className="my-3" data-testid="doc-board-embed" data-id={node.attrs.id ?? undefined} data-board-id={boardId}>
      <div contentEditable={false} className="overflow-hidden rounded-[var(--radius-lg)] border border-line bg-surface">
        <div className="flex flex-wrap items-center gap-2 border-b border-line-soft bg-surface-3 px-3 py-2">
          <Icon name="board" size={16} className="shrink-0 text-muted" />
          <span className="min-w-0 flex-1 truncate font-display text-[0.875rem] font-bold text-heading">
            {board.data?.name ?? label}
          </span>
          {board.data && views.length > 1 && editor.isEditable ? (
            <Picker
              label={t('docs2.embed.view')}
              value={view?.id ?? ''}
              className="w-40"
              testId="doc-embed-view"
              options={views.map((v) => ({ value: v.id, label: v.name }))}
              onChange={(id) => updateAttributes({ view_id: id })}
            />
          ) : view && board.data ? (
            <span className="text-xs text-muted">{view.name}</span>
          ) : null}
          {board.data ? (
            <Link
              to="/a/$accountSlug/b/$boardId"
              params={{ accountSlug: slug, boardId }}
              search={view ? { view: view.id } : {}}
              className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
              data-testid="doc-embed-open"
            >
              {t('docs2.embed.openBoard')}
              <Icon name="ext" size={12} />
            </Link>
          ) : null}
        </div>
        {board.isError ? (
          <div className="px-3 py-3">
            <Restricted kind="board" />
          </div>
        ) : !board.data || !items.data ? (
          <div className="px-3 py-4 text-sm text-muted">{t('app.loading')}</div>
        ) : (
          <EmbedTable board={board.data} items={items.data} hidden={view?.settings.hidden_columns ?? []} order={view?.settings.column_order ?? []} />
        )}
      </div>
    </NodeViewWrapper>
  );
};

const EmbedTable = ({
  board,
  items,
  hidden,
  order,
}: {
  board: BoardDetail;
  items: ItemsPage;
  hidden: string[];
  order: string[];
}) => {
  const { slug } = useDocEnv();
  const columns = orderColumns(board.columns, order)
    .filter((c) => c.type !== 'name' && !hidden.includes(c.id))
    .slice(0, EMBED_COLUMNS);
  if (!items.data.length)
    return <div className="px-3 py-4 text-sm text-muted">{t('docs2.embed.empty')}</div>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[480px] text-sm" data-testid="doc-embed-table">
        <thead>
          <tr className="text-xs text-muted">
            <th className="px-3 py-1.5 text-start font-semibold">{t('docs2.embed.item')}</th>
            {columns.map((c) => (
              <th key={c.id} className="truncate px-3 py-1.5 text-start font-semibold">
                {c.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.data.map((it) => (
            <tr key={it.id} className="border-t border-line-soft" data-testid="doc-embed-row" data-item-name={it.name}>
              <td className="max-w-[240px] truncate px-3 py-1.5">
                <Link
                  to="/a/$accountSlug/b/$boardId/i/$itemId"
                  params={{ accountSlug: slug, boardId: board.parent_board_id ?? board.id, itemId: it.id }}
                  className="font-semibold text-fg hover:underline"
                >
                  {it.name}
                </Link>
              </td>
              {columns.map((c) => (
                <td key={c.id} className="max-w-[200px] truncate px-3 py-1.5 text-fg-2">
                  {cellText(it, c.id) || <span className="text-muted">—</span>}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {items.total > items.data.length ? (
        <div className="border-t border-line-soft px-3 py-1.5 text-xs text-muted">
          {t('docs2.embed.more', { n: items.total - items.data.length })}
        </div>
      ) : null}
    </div>
  );
};

/** An item's card: its name and first columns, live; "open the item". */
export const ItemEmbedView = ({ node }: ReactNodeViewProps) => {
  const { accountId, slug } = useDocEnv();
  const itemId = safeId(node.attrs.item_id);
  const itemKey = ['account', accountId, 'doc-embed-item', itemId];
  const item = useQuery({
    queryKey: itemKey,
    queryFn: () => api(accountId).get<Item>(`/items/${encodeURIComponent(itemId)}`),
    enabled: !!itemId,
    retry: false,
  });
  const board = useBoard(accountId, item.data?.board_id ?? '');
  useLiveBoard(item.data?.board_id ?? null, [itemKey]);
  const columns = (board.data?.columns ?? []).filter((c) => c.type !== 'name' && item.data?.cells[c.id]?.text);
  return (
    <NodeViewWrapper className="my-3" data-testid="doc-item-embed" data-id={node.attrs.id ?? undefined} data-item-id={itemId}>
      <div contentEditable={false} className="rounded-[var(--radius-lg)] border border-line bg-surface px-3.5 py-3">
        {item.isError ? (
          <Restricted kind="item" />
        ) : !item.data ? (
          <span className="text-sm text-muted">{t('app.loading')}</span>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <Icon name="cards" size={16} className="shrink-0 text-muted" />
              <span className="min-w-0 flex-1 truncate font-display text-[0.9375rem] font-bold text-heading">
                {item.data.name}
              </span>
              <Link
                to="/a/$accountSlug/b/$boardId/i/$itemId"
                params={{
                  accountSlug: slug,
                  boardId: board.data?.parent_board_id ?? item.data.board_id,
                  itemId: item.data.id,
                }}
                className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
              >
                {t('docs2.embed.openItem')}
                <Icon name="ext" size={12} />
              </Link>
            </div>
            {board.data ? <div className="mt-0.5 text-xs text-muted">{board.data.name}</div> : null}
            {columns.length ? (
              <dl className="mt-2 grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
                {columns.slice(0, 8).map((c) => (
                  <div key={c.id} className="contents">
                    <dt className="truncate text-muted">{c.title}</dt>
                    <dd className="truncate text-fg">{item.data!.cells[c.id]?.text}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </>
        )}
      </div>
    </NodeViewWrapper>
  );
};

/** An inline link to an item, a board or a doc; its current name, or "restricted" for whoever may not see it. */
export const EntityLinkView = ({ node, selected }: ReactNodeViewProps) => {
  const { accountId, slug } = useDocEnv();
  const kind = (node.attrs.kind === 'board' || node.attrs.kind === 'doc' ? node.attrs.kind : 'item') as
    | 'item'
    | 'board'
    | 'doc';
  const id = safeId(node.attrs.id);
  const seg = encodeURIComponent(id);
  const path = kind === 'item' ? `/items/${seg}` : kind === 'board' ? `/boards/${seg}` : `/docs/${seg}`;
  const target = useQuery({
    queryKey: ['account', accountId, 'doc-link', kind, id],
    queryFn: () => api(accountId).get<{ name: string; board_id?: string; parent_board_id?: string | null }>(path),
    enabled: !!id,
    retry: false,
    staleTime: 60_000,
  });
  const label = target.data?.name ?? String(node.attrs.label ?? '');
  const chip = cn(
    'mx-0.5 inline-flex max-w-full items-center gap-1 rounded-[6px] px-1 align-baseline text-[0.95em] font-semibold',
    selected ? 'bg-primary-soft' : 'bg-surface-2',
  );
  if (target.isError)
    return (
      <NodeViewWrapper as="span" className={chip} data-testid="doc-link" data-kind={kind} data-restricted="true">
        <Restricted kind={kind} />
      </NodeViewWrapper>
    );
  const icon = kind === 'board' ? 'board' : kind === 'doc' ? 'file' : 'cards';
  const boardId = node.attrs.board_id ? String(node.attrs.board_id) : (target.data?.board_id ?? '');
  return (
    <NodeViewWrapper as="span" className={chip} data-testid="doc-link" data-kind={kind} data-label={label}>
      <Icon name={icon} size={12} className="shrink-0 text-muted" />
      {kind === 'item' ? (
        <Link
          to="/a/$accountSlug/b/$boardId/i/$itemId"
          params={{ accountSlug: slug, boardId, itemId: id }}
          className="truncate text-primary hover:underline"
        >
          {label}
        </Link>
      ) : kind === 'board' ? (
        <Link to="/a/$accountSlug/b/$boardId" params={{ accountSlug: slug, boardId: id }} className="truncate text-primary hover:underline">
          {label}
        </Link>
      ) : (
        <Link to="/a/$accountSlug/d/$docId" params={{ accountSlug: slug, docId: id }} className="truncate text-primary hover:underline">
          {label}
        </Link>
      )}
    </NodeViewWrapper>
  );
};
