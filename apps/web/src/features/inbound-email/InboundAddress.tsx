// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type InboundAddressDto, type InboundKind, t, tDynamic } from '@bines/shared';
import { Button, Dialog, Notice } from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { confirmDialog } from '../../lib/dialogs';
import { copyText } from '../../lib/entity-menu';
import { Icon } from '../../lib/icons';

/**
 * Incoming email: the address of an item (mail → an update on it) or a board (mail → a new item).
 * Made on first use; "new address" retires the old one for good. Nothing shows while incoming email is off.
 */
const pathOf = (kind: InboundKind, id: string) => `/${kind === 'item' ? 'items' : 'boards'}/${id}/email-address`;
export const inboundAddressKey = (accountId: string, kind: InboundKind, id: string) =>
  ['account', accountId, 'inbound-address', kind, id] as const;

export const useInboundAddress = (accountId: string, kind: InboundKind, id: string, enabled = true) =>
  useQuery({
    queryKey: inboundAddressKey(accountId, kind, id),
    queryFn: () => api(accountId).get<InboundAddressDto>(pathOf(kind, id)),
    staleTime: 5 * 60_000,
    enabled,
    // A guest / a viewer who may not comment gets 403: no address for them, and nothing to retry.
    retry: false,
  });

/** The address with copy / new address / remove, or a button that makes it. */
export const InboundAddressPanel = ({
  accountId,
  kind,
  id,
  data,
}: {
  accountId: string;
  kind: InboundKind;
  id: string;
  data: InboundAddressDto;
}) => {
  const qc = useQueryClient();
  const set = (next: InboundAddressDto) => qc.setQueryData(inboundAddressKey(accountId, kind, id), next);
  const make = useMutation({
    mutationFn: () => api(accountId).post<InboundAddressDto>(pathOf(kind, id), {}),
    onSuccess: set,
  });
  const rotate = useMutation({
    mutationFn: () => api(accountId).post<InboundAddressDto>(`${pathOf(kind, id)}/rotate`, {}),
    onSuccess: set,
  });
  const remove = useMutation({
    mutationFn: () => api(accountId).delete<InboundAddressDto>(pathOf(kind, id)),
    onSuccess: set,
  });
  const error = make.error ?? rotate.error ?? remove.error;
  const busy = make.isPending || rotate.isPending || remove.isPending;

  if (!data.address)
    return (
      <div className="flex flex-col gap-2" data-testid="inbound-address">
        <p className="text-sm text-fg-2">{tDynamic(`inboundEmail.${kind}.explain`)}</p>
        <div>
          <Button size="sm" data-testid="inbound-address-make" disabled={busy} onClick={() => make.mutate()}>
            <Icon name="mail" size={14} />
            {t('inboundEmail.make')}
          </Button>
        </div>
        {error ? <Notice tone="error">{errorMessage(error)}</Notice> : null}
      </div>
    );

  return (
    <div className="flex flex-col gap-2" data-testid="inbound-address">
      <p className="text-sm text-fg-2">{tDynamic(`inboundEmail.${kind}.explain`)}</p>
      <div className="flex flex-wrap items-center gap-2">
        <code
          dir="ltr"
          data-testid="inbound-address-value"
          className="min-w-0 max-w-full select-all break-all rounded-[var(--radius)] bg-surface-2 px-2 py-1 text-[0.8125rem]"
        >
          {data.address}
        </code>
        <Button
          size="sm"
          variant="secondary"
          data-testid="inbound-address-copy"
          onClick={() => copyText(data.address!)}
        >
          <Icon name="copy" size={14} />
          {t('inboundEmail.copy')}
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="ghost"
          data-testid="inbound-address-rotate"
          disabled={busy}
          onClick={async () => {
            if (
              await confirmDialog({
                title: t('inboundEmail.rotate.title'),
                message: t('inboundEmail.rotate.message'),
                confirmLabel: t('inboundEmail.rotate.confirm'),
              })
            )
              rotate.mutate();
          }}
        >
          <Icon name="restore" size={14} />
          {t('inboundEmail.rotate.button')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          data-testid="inbound-address-remove"
          disabled={busy}
          onClick={async () => {
            if (
              await confirmDialog({
                title: t('inboundEmail.remove.title'),
                message: t('inboundEmail.remove.message'),
                confirmLabel: t('inboundEmail.remove.confirm'),
                danger: true,
              })
            )
              remove.mutate();
          }}
        >
          <Icon name="trash" size={14} />
          {t('inboundEmail.remove.button')}
        </Button>
      </div>
      {error ? <Notice tone="error">{errorMessage(error)}</Notice> : null}
    </div>
  );
};

/**
 * Whether the item's ⋯ menu offers "email to this item": only once the address answers (on in the platform and the
 * account, and the person may use it — a guest / a viewer gets 403).
 */
export const useItemInboundAvailable = (accountId: string, itemId: string, enabled: boolean) => {
  const q = useInboundAddress(accountId, 'item', itemId, enabled);
  return enabled && !!q.data && !q.data.off;
};

/** "Email to this item" (the card's ⋯ menu; the product owner,: not in the updates tab) / "email to this board" (the board menu). */
export const InboundAddressDialog = ({
  accountId,
  kind,
  id,
  onClose,
}: {
  accountId: string;
  kind: InboundKind;
  id: string;
  onClose: () => void;
}) => {
  const q = useInboundAddress(accountId, kind, id);
  return (
    <Dialog open onClose={onClose} title={tDynamic(`inboundEmail.${kind}.title`)} className="max-w-lg">
      {q.isError ? <Notice tone="error">{errorMessage(q.error)}</Notice> : null}
      {q.data?.off ? <Notice>{tDynamic(`inboundEmail.off.${q.data.off}`)}</Notice> : null}
      {q.data && !q.data.off ? <InboundAddressPanel accountId={accountId} kind={kind} id={id} data={q.data} /> : null}
    </Dialog>
  );
};
