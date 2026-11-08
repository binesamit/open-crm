// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import {
  exactTime,
  formatInstantDate,
  MCP_SCOPE_GROUP_KEYS,
  MCP_SCOPE_GROUPS,
  type McpConnection,
  relativeTime,
  t,
} from '@bines/shared';
import { Badge, Button, EmptyState, Notice, SkeletonRows } from '@bines/ui';
import { errorMessage, type MyAccount } from '../../lib/api';
import { confirmDialog } from '../../lib/dialogs';
import { Icon } from '../../lib/icons';
import { showToast } from '../../lib/toast';
import { useAllBoards } from '../automations/automations-api';
import { useDisconnectMcp, useMcpConnections } from './ai-api';

/** The consent groups a connection holds (read always). */
export const groupsOf = (scopes: readonly string[]) =>
  MCP_SCOPE_GROUP_KEYS.filter((g) => g === 'read' || MCP_SCOPE_GROUPS[g].some((s) => scopes.includes(s)));

/**
 * AI apps connected over OAuth (the planning notes "AGENTS-MCP" מ5): Claude.ai, ChatGPT… — who, which account rights
 * (read / edit / automations), which boards, last use, and "disconnect" (its tokens stop at once). `all`: every
 * member's (admins, Administration); otherwise mine (profile → API tokens).
 */
export const McpConnections = ({ account, all = false }: { account: MyAccount; all?: boolean }) => {
  const list = useMcpConnections(account.id, all);
  const disconnect = useDisconnectMcp(account.id);
  const boards = useAllBoards(account.id);
  const [now] = useState(() => Date.now());
  const ask = async (c: McpConnection) => {
    if (
      await confirmDialog({
        title: t('mcp.connections.disconnectTitle', { name: c.client_name }),
        message: t('mcp.connections.disconnectBody'),
        danger: true,
        confirmLabel: t('mcp.connections.disconnect'),
      })
    )
      disconnect.mutate(c.id, {
        onSuccess: () => showToast({ message: t('mcp.connections.disconnected') }),
        onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
      });
  };
  return (
    <section className="space-y-2" data-testid="mcp-connections">
      <div className="space-y-0.5">
        <h2 className="font-display text-[1rem] leading-snug font-extrabold text-heading">
          {t('mcp.connections.title')}
        </h2>
        <p className="max-w-[640px] text-sm text-muted">{t('mcp.connections.intro')}</p>
      </div>
      {list.isError ? <Notice tone="error">{errorMessage(list.error)}</Notice> : null}
      {list.isPending ? (
        <SkeletonRows rows={2} label={t('app.loading')} />
      ) : !list.data?.data.length ? (
        <EmptyState
          icon={<Icon name="link" size={24} />}
          title={t('mcp.connections.empty')}
          testId="mcp-connections-empty"
        />
      ) : (
        <ul className="overflow-hidden rounded-[14px] border border-line">
          {list.data.data.map((c) => (
            <li
              key={c.id}
              className="flex items-start gap-3 border-b border-line-soft bg-surface px-3.5 py-3 last:border-b-0"
              data-testid="mcp-connection-row"
              data-name={c.client_name}
            >
              <span className="grid size-7 shrink-0 place-items-center rounded-[10px] bg-surface-2 text-heading">
                <Icon name="link" size={15} />
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-fg">{c.client_name}</span>
                  <bdi dir="ltr" className="font-mono text-[0.6875rem] text-muted">
                    {c.client_host}
                  </bdi>
                </p>
                <p className="flex flex-wrap gap-1">
                  {groupsOf(c.scopes).map((g) => (
                    <Badge key={g} tone={g === 'read' ? 'neutral' : g === 'write' ? 'info' : 'warn'}>
                      {t(`connect.scope.${g}`)}
                    </Badge>
                  ))}
                </p>
                <p className="flex flex-wrap gap-x-1.5 text-[0.6875rem] text-muted">
                  {all && c.user_name ? (
                    <>
                      <span>{c.user_name}</span>
                      <span aria-hidden>·</span>
                    </>
                  ) : null}
                  <span data-testid="mcp-connection-boards">
                    {c.board_ids
                      ? t('mcp.connections.onlyBoards', {
                          boards: c.board_ids.map((id) => boards.find((b) => b.id === id)?.name ?? '…').join(', '),
                        })
                      : t('mcp.connections.allBoards')}
                  </span>
                  <span aria-hidden>·</span>
                  <span>
                    {t('mcp.connections.connectedAt')}: {formatInstantDate(c.created_at)}
                  </span>
                  <span aria-hidden>·</span>
                  <span>
                    {t('mcp.connections.lastUsed')}:{' '}
                    {c.last_used_at ? (
                      <time dateTime={c.last_used_at} title={exactTime(c.last_used_at)}>
                        {relativeTime(c.last_used_at, now)}
                      </time>
                    ) : (
                      '—'
                    )}
                  </span>
                </p>
              </div>
              <Button
                variant="danger-outline"
                size="sm"
                disabled={disconnect.isPending}
                onClick={() => void ask(c)}
                data-testid="mcp-connection-disconnect"
              >
                {t('mcp.connections.disconnect')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
