// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { t, type IdocDoc, type MessageKey } from '@bines/shared';
import { Badge, Button, copyToClipboard, Dialog } from '@bines/ui';
import { Icon } from '../../lib/icons';
import { errorMessage } from '../../lib/api';
import { showToast } from '../../lib/toast';
import { keysOf, useDocMutations } from './idocs-api';

/**
 * The client's link of a document (product owner: "where is the link to share with the client?"): the address
 * itself, a copy button, whether it works now (active / expired / closed) and replace / close / reopen next to it.
 * Shown in each row of the Documents tab, in the editor's header and right after sending.
 */
const S = keysOf('idoc.share.');

const stateOf = (doc: IdocDoc): 'active' | 'expired' | 'closed' =>
  doc.status === 'revoked' ? 'closed' : doc.status === 'expired' ? 'expired' : 'active';

export const copyDocLink = async (url: string) =>
  showToast({ message: (await copyToClipboard(url)) ? S('copied') : t('error.generic'), seconds: 2 });

export const ShareLink = ({
  accountId,
  itemId,
  doc,
  compact,
}: {
  accountId: string;
  itemId: string;
  doc: IdocDoc;
  /** One line (the Documents tab row); else the full panel with the actions. */
  compact?: boolean;
}) => {
  const m = useDocMutations(accountId, itemId);
  const [confirm, setConfirm] = useState<null | 'token' | 'revoke'>(null);
  if (!doc.url) return null;
  const state = stateOf(doc);
  const run = (action: 'token' | 'revoke' | 'reopen') =>
    m.action.mutate({ id: doc.id, action }, { onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }) });
  return (
    <div className="grid gap-1.5" data-testid="idoc-share" data-state={state}>
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-xs text-fg-2">{S('title')}</span>
        <Badge tone={state === 'active' ? 'ok' : state === 'expired' ? 'warn' : 'danger'}>{S(`state.${state}`)}</Badge>
        {doc.expires_at && state === 'active' ? (
          <span className="text-[0.7rem] text-muted">
            {S('until', { date: new Date(doc.expires_at).toLocaleDateString() })}
          </span>
        ) : null}
      </div>
      <div className="flex min-w-0 items-center gap-1.5">
        <input
          readOnly
          value={doc.url}
          dir="ltr"
          aria-label={S('title')}
          onFocus={(e) => e.currentTarget.select()}
          data-testid="idoc-share-url"
          className="h-8 min-w-0 flex-1 rounded-[8px] border border-line bg-surface-3 px-2 font-mono text-xs text-fg-2"
        />
        <Button size="sm" variant="secondary" onClick={() => void copyDocLink(doc.url!)} data-testid="idoc-share-copy">
          <Icon name="copy" size={13} />
          {S('copy')}
        </Button>
        <a
          href={doc.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={S('open')}
          title={S('open')}
          className="grid size-8 shrink-0 place-items-center rounded-[8px] text-fg-2 hover:bg-surface-2"
        >
          <Icon name="eye" size={14} />
        </a>
      </div>
      {!compact ? (
        <div className="flex flex-wrap gap-1.5">
          {state === 'active' ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => setConfirm('token')}>
                <Icon name="link" size={13} />
                {S('replace')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirm('revoke')}>
                <Icon name="lock" size={13} />
                {S('close')}
              </Button>
            </>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => run('reopen')} data-testid="idoc-share-reopen">
              <Icon name="restore" size={13} />
              {S('reopen')}
            </Button>
          )}
        </div>
      ) : null}
      <Dialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        role="alertdialog"
        title={confirm === 'token' ? S('confirmReplace') : S('confirmClose')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={() => {
                if (confirm) run(confirm);
                setConfirm(null);
              }}
            >
              {confirm === 'token' ? S('replace') : S('close')}
            </Button>
          </>
        }
      >
        <p className="text-sm text-fg-2">{confirm === 'token' ? S('replaceText') : S('closeText')}</p>
      </Dialog>
    </div>
  );
};

/** "Share link" in the editor's header: opens the panel. */
export const ShareLinkButton = ({ accountId, itemId, doc }: { accountId: string; itemId: string; doc: IdocDoc }) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)} data-testid="idoc-builder-share">
        <Icon name="link" size={13} />
        {S('title')}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={S('title')} subtitle={doc.name}>
        <ShareLink accountId={accountId} itemId={itemId} doc={doc} />
        <p className="mt-3 text-xs text-muted">{S('hint')}</p>
      </Dialog>
    </>
  );
};

export type { MessageKey };
