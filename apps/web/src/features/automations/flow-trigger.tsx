// SPDX-License-Identifier: AGPL-3.0-only
import { useContext } from 'react';
import { FLOW_TEMPLATE_FIELDS, FLOW_TRIGGER_TYPES, t, type SentenceBoard } from '@bines/shared';
import { SearchableList } from '@bines/ui';
import { BoardAccountContext } from '../board/board-context';
import { useFlowConnections, useFlows } from '../flows/flows-api';

/**
 * The builder's side of the flow triggers ("when an external flow fails / recovers"): the
 * connection and flow blanks (picked from the account's flow connections — Administration → זרימות — and that
 * connection's flows), their names in the sentence, and the `{flow.*}` variables for the actions' texts.
 */

export const isFlowTrigger = (type: string) => (FLOW_TRIGGER_TYPES as readonly string[]).includes(type);

const connectionOf = (trigger: Record<string, unknown>) =>
  isFlowTrigger(String(trigger.type)) && typeof trigger.connection === 'string' && trigger.connection !== 'any'
    ? trigger.connection
    : null;

/** Names for the sentence and the variables a flow trigger's run offers (nothing for other triggers). */
export const useFlowTriggerNames = (accountId: string, trigger: Record<string, unknown>) => {
  const flow = isFlowTrigger(String(trigger.type));
  const connections = useFlowConnections(accountId, flow);
  const flows = useFlows(accountId, connectionOf(trigger));
  const sentence: Pick<SentenceBoard, 'flowConnectionName' | 'flowName'> = {
    flowConnectionName: (id) => connections.data?.data.find((c) => c.id === id)?.name,
    flowName: (_c, id) => flows.data?.data.find((f) => f.id === id)?.name,
  };
  const variables = flow ? FLOW_TEMPLATE_FIELDS.map((f) => ({ v: `{flow.${f}}`, label: t(`auto.var.flow.${f}`) })) : [];
  return { sentence, variables };
};

const optionCls = (active: boolean) =>
  `shrink-0 truncate rounded px-2 py-1 text-start text-sm bg-[var(--surface-2)] ${active ? 'ring-2 ring-[var(--primary)]' : ''}`;

/** The `connection` / `flow` blank of a flow trigger. */
export const FlowTriggerSlot = ({
  owner,
  field,
  onSet,
}: {
  owner: Record<string, unknown>;
  field: 'connection' | 'flow';
  onSet: (patch: Record<string, unknown>) => void;
}) => {
  const { id: accountId } = useContext(BoardAccountContext);
  const connections = useFlowConnections(accountId, true);
  const connectionId = connectionOf(owner);
  const flows = useFlows(accountId, field === 'flow' ? connectionId : null);
  if (field === 'flow' && !connectionId)
    return <p className="w-56 text-xs text-muted">{t('auto.flow.pick_connection_first')}</p>;
  const options =
    field === 'connection'
      ? [
          { id: 'any', name: t('auto.flow.any_connection') },
          ...(connections.data?.data ?? []).filter((c) => c.enabled).map((c) => ({ id: c.id, name: c.name })),
        ]
      : [
          { id: '', name: t('auto.flow.any_flow') },
          ...(flows.data?.data ?? []).map((f) => ({ id: f.id, name: f.name })),
        ];
  const current = field === 'connection' ? String(owner.connection ?? 'any') : String(owner.flow ?? '');
  const loading = field === 'connection' ? connections.isPending : flows.isPending;
  return (
    <SearchableList items={options} text={(o) => o.name} className="w-64" testId="slot-search">
      {(shown) => (
        <div className="flex max-h-72 flex-col gap-1 overflow-y-auto [&>*]:shrink-0" data-testid={`slot-flow-${field}`}>
          {shown.map((o) => (
            <button
              key={o.id || 'any'}
              type="button"
              className={optionCls(o.id === current)}
              data-testid="slot-option"
              data-value={o.id || 'any'}
              onClick={() =>
                onSet(
                  field === 'connection'
                    ? // Another connection: its flows differ — the flow blank starts over.
                      { connection: o.id, flow: undefined }
                    : { flow: o.id || undefined },
                )
              }
            >
              {o.name}
            </button>
          ))}
          {loading ? <p className="text-xs text-muted">{t('app.loading')}</p> : null}
          {connections.isError && field === 'connection' ? (
            <p className="text-xs text-muted">{t('auto.flow.no_access')}</p>
          ) : null}
        </div>
      )}
    </SearchableList>
  );
};
