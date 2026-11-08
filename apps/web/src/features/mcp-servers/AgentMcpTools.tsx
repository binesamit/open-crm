// SPDX-License-Identifier: AGPL-3.0-only
import { t } from '@bines/shared';
import { Badge, Switch } from '@bines/ui';
import { useMcpAgentTools } from './mcp-servers-api';

/**
 * The agent editor's "external tools" (מ10): the enabled tools of the account's MCP servers, one switch each — an
 * agent gets a remote tool only when its editor turns it on here. A tool the admin left "with approval" always
 * waits for a person; otherwise it is a write (learner mode still asks).
 */
export const AgentMcpTools = ({
  accountId,
  tools,
  onToggle,
}: {
  accountId: string;
  tools: string[];
  onToggle: (alias: string, on: boolean) => void;
}) => {
  const list = useMcpAgentTools(accountId);
  const remote = list.data?.data ?? [];
  // A tool the agent has that is no longer enabled (or whose server is gone): shown so it can be removed.
  const stale = tools.filter((x) => x.startsWith('mcp_') && !remote.some((r) => r.alias === x));
  if (!remote.length && !stale.length) return null;
  return (
    <section className="border-t border-line-soft" data-testid="agent-mcp-tools">
      <h3 className="px-3.5 pt-2.5 pb-1 text-xs font-semibold text-muted">{t('mcpsrv.agent.title')}</h3>
      <p className="px-3.5 pb-1 text-xs text-muted">{t('mcpsrv.agent.hint')}</p>
      {remote.map((r) => (
        <div
          key={r.alias}
          className="flex flex-wrap items-center gap-2.5 px-3.5 py-2"
          data-testid="agent-tool"
          data-tool={r.alias}
        >
          <Switch
            checked={tools.includes(r.alias)}
            onChange={(v) => onToggle(r.alias, v)}
            label={r.name}
            testId={`agent-tool-${r.alias}`}
          />
          <span className="min-w-0 flex-1 text-sm text-fg">
            <span dir="ltr" className="font-mono text-xs">
              {r.name}
            </span>{' '}
            <span className="text-xs text-muted">· {r.server_name}</span>
            {r.description ? (
              <span className="block truncate text-xs text-muted" title={r.description}>
                {r.description}
              </span>
            ) : null}
          </span>
          {r.approval ? (
            <Badge tone="danger">{t('mcpsrv.agent.withApproval')}</Badge>
          ) : (
            <Badge tone="info">{t('mcpsrv.agent.noApproval')}</Badge>
          )}
        </div>
      ))}
      {stale.map((alias) => (
        <div key={alias} className="flex flex-wrap items-center gap-2.5 px-3.5 py-2" data-tool={alias}>
          <Switch checked onChange={(v) => onToggle(alias, v)} label={alias} />
          <span dir="ltr" className="min-w-0 flex-1 font-mono text-xs text-muted line-through">
            {alias}
          </span>
          <Badge tone="warn">{t('mcpsrv.agent.unavailable')}</Badge>
        </div>
      ))}
    </section>
  );
};
