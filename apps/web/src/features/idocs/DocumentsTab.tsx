// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { IDOC_STARTERS, t, type IdocDoc, type IdocStatus, type MessageKey } from '@bines/shared';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Input,
  Menu,
  Notice,
  SkeletonRows,
  Switch,
  useActionMenu,
  type MenuEntry,
} from '@bines/ui';
import { Icon } from '../../lib/icons';
import { errorMessage } from '../../lib/api';
import { showToast } from '../../lib/toast';
import {
  keysOf,
  useDocEvents,
  useDocMutations,
  useIdocTemplates,
  useItemDocs,
  useTemplateMutations,
} from './idocs-api';
import { DocBuilder } from './builder/DocBuilder';
import { PdfButton } from './PdfButton';
import { copyDocLink, ShareLink } from './ShareLink';

/**
 * The item card's "Documents" tab: the item's interactive documents — make one from a template
 * edit it, send or copy its link, follow what the client did, reopen / close it. Canvas parts 2 and 4.
 */
const L = keysOf('idoc.app.');

const STATUS_TONE: Record<IdocStatus, 'neutral' | 'info' | 'ok' | 'warn' | 'danger' | 'violet'> = {
  draft: 'neutral',
  sent: 'info',
  viewed: 'violet',
  signed: 'ok',
  expired: 'warn',
  revoked: 'danger',
};

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '';

export const DocumentsTab = ({
  accountId,
  itemId,
  boardId,
  canEdit,
  isAdmin,
}: {
  accountId: string;
  itemId: string;
  boardId: string;
  canEdit: boolean;
  isAdmin: boolean;
}) => {
  const docs = useItemDocs(accountId, itemId);
  const templates = useIdocTemplates(accountId, boardId);
  const m = useDocMutations(accountId, itemId);
  const tm = useTemplateMutations(accountId);
  const menu = useActionMenu();
  const [editing, setEditing] = useState<string | null>(null);
  const [sending, setSending] = useState<IdocDoc | null>(null);
  const [log, setLog] = useState<IdocDoc | null>(null);
  const [manage, setManage] = useState(false);
  const fail = (e: unknown) => showToast({ message: errorMessage(e), tone: 'error' });

  const create = (input: { template_id?: string; starter?: string }) =>
    m.create.mutate(input, { onSuccess: (doc) => setEditing(doc.id), onError: fail });
  const newItems: MenuEntry[] = [
    ...(templates.data ?? []).map((tpl) => ({
      label: tpl.name,
      icon: <Icon name="template" size={15} />,
      testId: 'idoc-new-from-template',
      onSelect: () => create({ template_id: tpl.id }),
    })),
    ...(templates.data?.length ? [{ kind: 'separator' as const }] : []),
    { kind: 'label', label: L('starters') },
    ...IDOC_STARTERS.map((s) => ({
      label: s.name.he,
      hint: s.description.he,
      testId: `idoc-new-starter-${s.key}`,
      onSelect: () => create({ starter: s.key }),
    })),
    ...(templates.data?.length
      ? [{ kind: 'separator' as const }, { label: L('manageTemplates'), onSelect: () => setManage(true) }]
      : []),
  ];

  if (docs.isPending) return <SkeletonRows rows={3} label="…" />;
  const list = docs.data ?? [];

  return (
    <div className="grid gap-3" data-testid="idoc-tab">
      {canEdit ? (
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted">{L('intro')}</p>
          <Button size="sm" onClick={menu.fromTrigger} busy={m.create.isPending} data-testid="idoc-new">
            <Icon name="plus" size={14} />
            {L('new')}
          </Button>
          <Menu at={menu.at} onClose={menu.close} items={newItems} label={L('new')} />
        </div>
      ) : null}
      {!list.length ? (
        <EmptyState icon={<Icon name="doc" size={22} />} title={L('emptyTitle')} testId="idoc-empty">
          {L('emptyText')}
        </EmptyState>
      ) : (
        <ul className="grid gap-2.5">
          {list.map((doc) => (
            <DocRow
              key={doc.id}
              accountId={accountId}
              itemId={itemId}
              doc={doc}
              canEdit={canEdit}
              isAdmin={isAdmin}
              onEdit={() => setEditing(doc.id)}
              onSend={() => setSending(doc)}
              onLog={() => setLog(doc)}
              onAction={(action) => m.action.mutate({ id: doc.id, action }, { onError: fail })}
              onDelete={() => m.remove.mutate(doc.id, { onError: fail })}
              onSaveTemplate={() =>
                tm.create.mutate(
                  { name: doc.name, board_id: boardId, from_doc_id: doc.id },
                  { onSuccess: () => showToast({ message: L('templateSaved'), seconds: 3 }), onError: fail },
                )
              }
            />
          ))}
        </ul>
      )}
      {editing ? (
        <DocBuilder
          accountId={accountId}
          itemId={itemId}
          boardId={boardId}
          docId={editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {sending ? (
        <SendDialog accountId={accountId} itemId={itemId} doc={sending} onClose={() => setSending(null)} />
      ) : null}
      {log ? <LogDialog accountId={accountId} doc={log} onClose={() => setLog(null)} /> : null}
      {manage ? <TemplatesDialog accountId={accountId} boardId={boardId} onClose={() => setManage(false)} /> : null}
    </div>
  );
};

const DocRow = ({
  accountId,
  itemId,
  doc,
  canEdit,
  isAdmin,
  onEdit,
  onSend,
  onLog,
  onAction,
  onDelete,
  onSaveTemplate,
}: {
  accountId: string;
  itemId: string;
  doc: IdocDoc;
  canEdit: boolean;
  isAdmin: boolean;
  onEdit: () => void;
  onSend: () => void;
  onLog: () => void;
  onAction: (a: 'token' | 'revoke' | 'reopen') => void;
  onDelete: () => void;
  onSaveTemplate: () => void;
}) => {
  const more = useActionMenu();
  const [confirm, setConfirm] = useState<null | 'token' | 'revoke' | 'delete'>(null);
  const closed = doc.status === 'revoked' || doc.status === 'expired' || doc.status === 'signed';
  const items: MenuEntry[] = [
    { label: L('log'), icon: <Icon name="history" size={15} />, onSelect: onLog },
    ...(canEdit
      ? [
          { label: L('saveAsTemplate'), icon: <Icon name="template" size={15} />, onSelect: onSaveTemplate },
          { label: L('replaceLink'), icon: <Icon name="link" size={15} />, onSelect: () => setConfirm('token') },
          closed
            ? {
                label: L('reopen'),
                icon: <Icon name="restore" size={15} />,
                onSelect: () => onAction('reopen'),
                testId: 'idoc-reopen',
              }
            : { label: L('closeLink'), icon: <Icon name="lock" size={15} />, onSelect: () => setConfirm('revoke') },
          { kind: 'separator' as const },
          {
            label: L('delete'),
            icon: <Icon name="trash" size={15} />,
            danger: true,
            disabled: !!doc.signature && !isAdmin,
            hint: doc.signature && !isAdmin ? L('deleteSignedAdmin') : undefined,
            onSelect: () => setConfirm('delete'),
          },
        ]
      : []),
  ];
  return (
    <li
      className="grid gap-2 rounded-[var(--radius)] border border-line bg-surface p-3"
      data-testid="idoc-row-doc"
      data-status={doc.status}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm text-heading">{doc.name}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
            <Badge tone={STATUS_TONE[doc.status]}>{t(`idoc.status.${doc.status}` as MessageKey)}</Badge>
            {doc.version > 1 ? <span>v{doc.version}</span> : null}
            {doc.sent_at ? <span>{L('sentOn', { when: when(doc.sent_at), to: doc.sent_to ?? '' })}</span> : null}
            {doc.view_count ? <span>{L('views', { n: doc.view_count, when: when(doc.last_viewed_at) })}</span> : null}
          </div>
          {doc.signature ? (
            <div className="mt-1 text-xs text-ok-fg">
              {L('signedBy', { name: doc.signature.name, when: when(doc.signature.at) })}
            </div>
          ) : null}
        </div>
        <button
          type="button"
          onClick={more.fromTrigger}
          aria-label={L('more')}
          className="grid size-7 place-items-center rounded-[var(--radius-sm)] text-muted hover:bg-surface-2 hover:text-fg"
        >
          ⋯
        </button>
        <Menu at={more.at} onClose={more.close} items={items} label={L('more')} />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {canEdit ? (
          <Button size="sm" variant="secondary" onClick={onEdit} data-testid="idoc-edit">
            <Icon name="edit" size={14} />
            {L('edit')}
          </Button>
        ) : null}
        {canEdit && doc.status !== 'revoked' ? (
          <Button size="sm" variant="secondary" onClick={onSend} data-testid="idoc-send">
            <Icon name="send" size={14} />
            {doc.sent_at ? L('sendAgain') : L('send')}
          </Button>
        ) : null}
        <PdfButton accountId={accountId} doc={doc} />
      </div>
      {/* The client's link, its state and copy — always in sight (the product owner). */}
      <ShareLink accountId={accountId} itemId={itemId} doc={doc} compact />
      <Dialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        role="alertdialog"
        title={confirm ? L(`confirm.${confirm}.title`) : ''}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant={confirm === 'delete' ? 'danger' : 'primary'}
              onClick={() => {
                if (confirm === 'delete') onDelete();
                else if (confirm) onAction(confirm);
                setConfirm(null);
              }}
              data-testid="idoc-confirm"
            >
              {confirm ? L(`confirm.${confirm}.ok`) : ''}
            </Button>
          </>
        }
      >
        <p className="text-sm text-fg-2">{confirm ? L(`confirm.${confirm}.text`) : ''}</p>
      </Dialog>
    </li>
  );
};

const SendDialog = ({
  accountId,
  itemId,
  doc,
  onClose,
}: {
  accountId: string;
  itemId: string;
  doc: IdocDoc;
  onClose: () => void;
}) => {
  const m = useDocMutations(accountId, itemId);
  const [email, setEmail] = useState(doc.sent_to ?? '');
  const [noEmail, setNoEmail] = useState(false);
  const send = () =>
    m.send.mutate(
      { id: doc.id, ...(noEmail ? { no_email: true } : email.trim() ? { email: email.trim() } : {}) },
      {
        onSuccess: () => {
          showToast({
            message: noEmail ? L('markedSent') : L('sent'),
            seconds: 8,
            ...(doc.url ? { action: { label: L('copyLink'), run: () => void copyDocLink(doc.url!) } } : {}),
          });
          onClose();
        },
      },
    );
  return (
    <Dialog
      open
      onClose={onClose}
      title={L('sendTitle')}
      subtitle={doc.name}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={send} busy={m.send.isPending} data-testid="idoc-send-confirm">
            {noEmail ? L('markSent') : L('send')}
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <label className="grid gap-1 text-sm">
          <span className="text-xs text-fg-2">{L('sendTo')}</span>
          <Input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            dir="ltr"
            type="email"
            placeholder={L('sendToPlaceholder')}
            disabled={noEmail}
            data-testid="idoc-send-email"
          />
        </label>
        <label className="flex items-center justify-between gap-3 text-sm text-fg-2">
          {L('noEmail')}
          <Switch checked={noEmail} onChange={setNoEmail} label={L('noEmail')} />
        </label>
        {m.send.isError ? <Notice tone="error">{errorMessage(m.send.error)}</Notice> : null}
      </div>
    </Dialog>
  );
};

const LogDialog = ({ accountId, doc, onClose }: { accountId: string; doc: IdocDoc; onClose: () => void }) => {
  const events = useDocEvents(accountId, doc.id);
  return (
    <Dialog open onClose={onClose} title={L('log')} subtitle={doc.name}>
      {events.isPending ? (
        <SkeletonRows rows={4} label="…" />
      ) : (
        <ol className="grid gap-2 text-sm" data-testid="idoc-log">
          {(events.data ?? []).map((e) => (
            <li key={e.id} className="grid grid-cols-[auto_1fr] gap-x-3">
              <span className="text-xs text-muted tabular-nums">{when(e.at)}</span>
              <span>
                {t(`idoc.event.k.${e.kind}` as MessageKey, { who: e.who || t('idoc.client') })}
                {e.detail ? <span className="block text-xs text-muted">{e.detail}</span> : null}
              </span>
            </li>
          ))}
        </ol>
      )}
    </Dialog>
  );
};

const TemplatesDialog = ({
  accountId,
  boardId,
  onClose,
}: {
  accountId: string;
  boardId: string;
  onClose: () => void;
}) => {
  const templates = useIdocTemplates(accountId, boardId);
  const tm = useTemplateMutations(accountId);
  const [names, setNames] = useState<Record<string, string>>({});
  return (
    <Dialog open onClose={onClose} title={L('manageTemplates')}>
      <ul className="grid gap-2">
        {(templates.data ?? []).map((tpl) => (
          <li key={tpl.id} className="flex items-center gap-2">
            <Input
              value={names[tpl.id] ?? tpl.name}
              aria-label={L('templateName')}
              onChange={(e) => setNames((n) => ({ ...n, [tpl.id]: e.target.value }))}
              onBlur={() => {
                const v = (names[tpl.id] ?? '').trim();
                if (v && v !== tpl.name) tm.save.mutate({ id: tpl.id, name: v });
              }}
            />
            <span className="shrink-0 text-xs text-muted">{tpl.board_id ? L('thisBoard') : L('allBoards')}</span>
            <Button
              size="sm"
              variant="ghost"
              aria-label={L('delete')}
              onClick={() =>
                tm.remove.mutate(tpl.id, { onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }) })
              }
            >
              <Icon name="trash" size={14} />
            </Button>
          </li>
        ))}
      </ul>
    </Dialog>
  );
};
