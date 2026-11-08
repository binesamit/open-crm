// SPDX-License-Identifier: AGPL-3.0-only
import { useContext, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { t } from '@bines/shared';
import { cn } from '@bines/ui';
import { api, errorMessage } from '../../../lib/api';
import { showToast } from '../../../lib/toast';
import { BoardAccountContext } from '../board-context';
import type { CellProps } from './index';

/**
 * vote (03 §3.11): the number of voters and my 👍 — one vote per user, cast and taken back through the vote
 * endpoint (never PUT /cells). Hover lists who voted.
 */
export const VoteCell = ({ column, value, editable, members, accountId, itemId }: CellProps) => {
  const { meId } = useContext(BoardAccountContext);
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const voters = (value as { voter_ids?: string[] } | null)?.voter_ids ?? [];
  const mine = voters.includes(meId);
  const names = voters
    .map((id) => {
      const m = members.find((x) => x.user_id === id);
      return m?.name || m?.email || '?';
    })
    .join(', ');

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api(accountId).post(`/items/${itemId}/cells/${column.id}/vote`, { vote: !mine });
      await qc.invalidateQueries({ queryKey: ['account', accountId, 'board'] });
      await qc.invalidateQueries({ queryKey: ['account', accountId, 'item'] });
    } catch (err) {
      showToast({ message: errorMessage(err), tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="flex h-full w-full items-center justify-center px-2 text-sm"
      title={voters.length ? t('vote.voters', { names }) : undefined}
    >
      <button
        type="button"
        disabled={!editable || busy}
        onClick={() => void toggle()}
        aria-pressed={mine}
        aria-label={mine ? t('vote.remove') : t('vote.cast')}
        data-testid="vote-button"
        className={cn(
          'flex cursor-pointer items-center gap-1 rounded-full border px-2 py-0.5 text-xs disabled:cursor-default',
          mine ? 'border-primary bg-primary-soft text-primary' : 'border-line text-muted enabled:hover:bg-surface-2',
        )}
      >
        <span aria-hidden>👍</span>
        <span data-testid="cell-value" dir="ltr">
          {voters.length}
        </span>
      </button>
    </div>
  );
};
