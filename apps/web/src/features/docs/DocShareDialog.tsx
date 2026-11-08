// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { DOC_LEVELS, t, type DocDetail, type DocLevel, type MyAccount, msgKey } from '@bines/shared';
import { Avatar, Button, Dialog, Input, Notice, Picker, Segmented, SkeletonRows } from '@bines/ui';
import { errorMessage } from '../../lib/api';
import { useMembers, useTeams } from '../board/board-api';
import { InviteLinks, SendEmailSwitch } from '../account/InviteLinks';
import { useDocMembers, useDocMutations, useInviteToDoc } from './doc-api';

type Row = { type: 'user' | 'team'; id: string; name: string; email: string | null; level: DocLevel };
type Kind = DocDetail['kind'];

/**
 * "שיתוף" (M8 ד1): the doc's type — main (the whole workspace), private (only who is invited), shareable (guests
 * too) — and who is invited, at which level (owner / editor / commenter / viewer). Saved together; the people
 * connected now are checked again by the server at once.
 */
export const DocShareDialog = ({ account, doc, onClose }: { account: MyAccount; doc: DocDetail; onClose: () => void }) => {
  const current = useDocMembers(account.id, doc.id);
  const people = useMembers(account.id).data?.data ?? [];
  const teams = useTeams(account.id).data?.data ?? [];
  const mut = useDocMutations(account.id);
  const [kind, setKind] = useState<Kind>(doc.kind);
  const [rows, setRows] = useState<Row[] | null>(null);
  const list = rows ?? current.data?.data ?? [];
  const setList = (next: Row[]) => setRows(next);

  const taken = new Set(list.map((r) => `${r.type}:${r.id}`));
  const addable = [
    ...people
      .filter((m) => m.status === 'active' && !taken.has(`user:${m.user_id}`))
      .filter((m) => m.role !== 'guest' || kind === 'shareable')
      .map((m) => ({ value: `user:${m.user_id}`, label: m.name || m.email, keywords: m.email })),
    ...teams
      .filter((tm) => !taken.has(`team:${tm.id}`))
      .map((tm) => ({ value: `team:${tm.id}`, label: `${tm.name} · ${t('docs.share.team')}` })),
  ];
  const add = (value: string) => {
    const [type, id] = value.split(':') as ['user' | 'team', string];
    const person = people.find((m) => m.user_id === id);
    const team = teams.find((tm) => tm.id === id);
    setList([
      ...list,
      {
        type,
        id,
        name: type === 'user' ? (person?.name ?? '') : (team?.name ?? ''),
        email: person?.email ?? null,
        level: 'editor',
      },
    ]);
  };
  const levels = DOC_LEVELS.map((l) => ({ value: l, label: t(msgKey(`docs.level.${l}`)) }));
  const save = async () => {
    if (kind !== doc.kind) await mut.update.mutateAsync({ id: doc.id, kind });
    if (rows) await mut.setMembers.mutateAsync({ id: doc.id, members: rows.map(({ type, id, level }) => ({ type, id, level })) });
    onClose();
  };
  const error = mut.update.error ?? mut.setMembers.error;

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('docs.share.title', { name: doc.name })}
      className="max-w-xl!"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} data-testid="doc-share-cancel">
            {t('common.cancel')}
          </Button>
          <Button
            onClick={() => void save()}
            busy={mut.update.isPending || mut.setMembers.isPending}
            data-testid="doc-share-save"
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-4" data-testid="doc-share-dialog">
        <Segmented
          label={t('docs.share.kind')}
          value={kind}
          onChange={setKind}
          testId="doc-share-kind"
          options={(['main', 'private', 'shareable'] as const).map((v) => ({
            value: v,
            label: t(msgKey(`docs.kind.${v}`)),
            testId: `doc-kind-${v}`,
          }))}
        />
        <p className="text-xs text-muted">{t(msgKey(`docs.kind.${kind}.hint`))}</p>
        {current.isPending ? (
          <SkeletonRows rows={3} label={t('app.loading')} />
        ) : (
          <ul className="space-y-1.5" aria-label={t('docs.share.members')}>
            {list.map((r) => (
              <li
                key={`${r.type}:${r.id}`}
                className="flex items-center gap-2"
                data-testid="doc-member"
                data-email={r.email ?? undefined}
                data-level={r.level}
              >
                <Avatar name={r.name || r.email || '?'} size={26} />
                <span className="min-w-0 flex-1 truncate text-sm">
                  {r.name || r.email}
                  {r.email && r.name ? <span className="ms-1 text-xs text-muted">{r.email}</span> : null}
                </span>
                <Picker
                  label={t('docs.share.level')}
                  value={r.level}
                  options={levels}
                  className="w-36"
                  testId="doc-member-level"
                  onChange={(level) => setList(list.map((x) => (x === r ? { ...x, level } : x)))}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t('docs.share.remove', { name: r.name || r.email || '' })}
                  title={t('docs.share.remove', { name: r.name || r.email || '' })}
                  data-testid="doc-member-remove"
                  onClick={() => setList(list.filter((x) => x !== r))}
                >
                  ✕
                </Button>
              </li>
            ))}
          </ul>
        )}
        <Picker
          label={t('docs.share.add')}
          placeholder={t('docs.share.add')}
          value=""
          options={addable}
          searchable
          testId="doc-share-add"
          onChange={add}
        />
        {error ? <Notice tone="error">{errorMessage(error)}</Notice> : null}
        <InviteByEmail accountId={account.id} doc={doc} canInviteGuests={account.role === 'admin' || account.role === 'member'} />
      </div>
    </Dialog>
  );
};

/**
 * Share by email (M8 ד3): people already in the account join the doc at once; someone new gets an invitation —
 * as a guest when the doc is shareable (they then see only what is shared with them), or as a member.
 */
const InviteByEmail = ({ accountId, doc, canInviteGuests }: { accountId: string; doc: DocDetail; canInviteGuests: boolean }) => {
  const invite = useInviteToDoc(accountId, doc.id);
  const [emails, setEmails] = useState('');
  const shareable = doc.kind === 'shareable';
  const [role, setRole] = useState<'guest' | 'member'>(shareable ? 'guest' : 'member');
  const [level, setLevel] = useState<DocLevel>('viewer');
  const [sendEmail, setSendEmail] = useState(true);
  const list = emails
    .split(/[\s,;]+/)
    .map((e) => e.trim())
    .filter(Boolean);
  const levels = DOC_LEVELS.filter((l) => role !== 'guest' || l !== 'owner').map((l) => ({
    value: l,
    label: t(msgKey(`docs.level.${l}`)),
  }));
  const result = invite.data;
  return (
    <div className="space-y-2 border-t border-line-soft pt-3" data-testid="doc-invite">
      <p className="text-sm font-semibold text-fg">{t('docs2.invite.title')}</p>
      <Input
        value={emails}
        placeholder={t('docs2.invite.emails')}
        aria-label={t('docs2.invite.emails')}
        data-testid="doc-invite-emails"
        dir="ltr"
        onChange={(e) => setEmails(e.target.value)}
      />
      <div className="flex flex-wrap items-center gap-2">
        {canInviteGuests && shareable ? (
          <Segmented
            label={t('docs2.invite.as')}
            value={role}
            onChange={setRole}
            testId="doc-invite-role"
            options={[
              { value: 'guest', label: t('docs2.invite.guest'), testId: 'doc-invite-guest' },
              { value: 'member', label: t('docs2.invite.member'), testId: 'doc-invite-member' },
            ]}
          />
        ) : null}
        <Picker
          label={t('docs.share.level')}
          value={level}
          options={levels}
          className="w-36"
          testId="doc-invite-level"
          onChange={setLevel}
        />
        <Button
          variant="secondary"
          disabled={!list.length || (role === 'guest' && !shareable)}
          busy={invite.isPending}
          data-testid="doc-invite-send"
          onClick={() =>
            invite.mutate(
              { emails: list, role, level, ...(sendEmail ? {} : { send_email: false }) },
              { onSuccess: () => setEmails('') },
            )
          }
        >
          {t('docs2.invite.send')}
        </Button>
      </div>
      <SendEmailSwitch checked={sendEmail} onChange={setSendEmail} testId="doc-invite-send-email" />
      {!shareable ? <p className="text-xs text-muted">{t('docs2.invite.guestsNeedShareable')}</p> : null}
      {invite.error ? <Notice tone="error">{errorMessage(invite.error)}</Notice> : null}
      {result ? (
        <div data-testid="doc-invite-result">
          <Notice tone={result.errors.length ? 'warn' : 'success'}>
            {t('docs2.invite.result', {
              added: result.added.length,
              invited: result.invited.length,
              failed: result.errors.length,
            })}
          </Notice>
        </div>
      ) : null}
      {result ? <InviteLinks invited={result.invited} testId="doc-invite-links" /> : null}
    </div>
  );
};
