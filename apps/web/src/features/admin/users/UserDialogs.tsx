// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import {
  accountRoleSchema,
  t,
  type AccountRole,
  type MessageKey,
  type TransferResult,
  type TransferScope,
  TRANSFER_SCOPES,
} from '@bines/shared';
import { Avatar, Button, Dialog, Field, Input, Notice, Picker, Segmented } from '@bines/ui';
import { errorMessage, type Member } from '../../../lib/api';
import { showToast } from '../../../lib/toast';
import { CheckRow } from '../../board/toolbar/parts';
import type { useUsersMutations } from './users-api';

export const roleLabel = (role: AccountRole) => t(`role.${role}` as MessageKey);
export const displayName = (m: Pick<Member, 'name' | 'email'>) => m.name || m.email;

type Mutations = ReturnType<typeof useUsersMutations>;

/** A member in a dialog header: avatar, name, email. */
const Who = ({ member }: { member: Member }) => (
  <div className="flex items-center gap-3 rounded-[12px] bg-surface-3 px-3 py-2.5">
    <Avatar name={displayName(member)} url={member.avatar_url} size={32} />
    <span className="flex min-w-0 flex-col">
      <span className="truncate font-semibold text-heading">{displayName(member)}</span>
      <span className="truncate text-start text-xs text-muted [unicode-bidi:isolate]" dir="ltr">
        {member.email}
      </span>
    </span>
  </div>
);

/** עריכה: name, job title, department, phone and role (not your own role). */
export const EditUserDialog = ({
  member,
  isSelf,
  mutations,
  onClose,
}: {
  member: Member;
  isSelf: boolean;
  mutations: Mutations;
  onClose: () => void;
}) => {
  const [name, setName] = useState(member.name);
  const nameLocked = !isSelf && !!member.name_managed_elsewhere;
  const [title, setTitle] = useState(member.title ?? '');
  const [department, setDepartment] = useState(member.department ?? '');
  const [phone, setPhone] = useState(member.phone ?? '');
  const [role, setRole] = useState<AccountRole>(member.role);
  const save = mutations.update;
  const submit = () => {
    const patch = {
      ...(!nameLocked && name.trim() && name.trim() !== member.name ? { name: name.trim() } : {}),
      ...(title.trim() !== (member.title ?? '') ? { title: title.trim() } : {}),
      ...(department.trim() !== (member.department ?? '') ? { department: department.trim() } : {}),
      ...(phone.trim() !== (member.phone ?? '') ? { phone: phone.trim() } : {}),
      ...(role !== member.role ? { role } : {}),
    };
    if (!Object.keys(patch).length) return onClose();
    save.mutate(
      { id: member.user_id, patch },
      {
        onSuccess: () => {
          showToast({ message: t('adminUsers.saved') });
          onClose();
        },
      },
    );
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('adminUsers.edit.title')}
      subtitle={member.email}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button busy={save.isPending} onClick={submit} data-testid="user-edit-save">
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {/* S-63: a name that shows in the person's other accounts is theirs to change, not this account's admin's. */}
        <Field label={t('profile.name')} hint={nameLocked ? t('adminUsers.edit.nameManagedElsewhere') : undefined}>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            data-testid="user-edit-name"
            disabled={nameLocked}
            readOnly={nameLocked}
            required
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('profile.jobTitle')}>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} data-testid="user-edit-title" />
          </Field>
          <Field label={t('profile.department')}>
            <Input
              value={department}
              onChange={(e) => setDepartment(e.target.value)}
              data-testid="user-edit-department"
            />
          </Field>
        </div>
        <Field label={t('profile.phone')}>
          <Input
            dir="ltr"
            className="text-end"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            data-testid="user-edit-phone"
          />
        </Field>
        <Field label={t('adminUsers.col.role')} hint={isSelf ? t('adminUsers.ownRole') : undefined}>
          {isSelf ? (
            <Input value={roleLabel(member.role)} disabled readOnly />
          ) : (
            <Picker
              label={t('adminUsers.col.role')}
              value={role}
              onChange={setRole}
              testId="user-edit-role"
              options={accountRoleSchema.options.map((r) => ({ value: r, label: roleLabel(r) }))}
            />
          )}
        </Field>
        {save.isError ? <Notice tone="error">{errorMessage(save.error)}</Notice> : null}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
};

const NO_TRANSFER = '__none__';

/** One line of what moved, e.g. "2 בורדים · 1 אוטומציה". */
export const transferSummary = (r: TransferResult) =>
  TRANSFER_SCOPES.filter((s) => r[s] > 0)
    .map((s) => t(`adminUsers.transfer.count.${s}`, { n: r[s] }))
    .join(' · ') || t('adminUsers.transfer.nothing');

/**
 * העברת בעלות (product decision 2026-10-04): every time it asks "to whom?" — preselected with the account's default transfer
 * user when one is set (still changeable) — and what to move: boards, automations, webhooks, service tokens and,
 * by choice, the people-column assignments. In `deactivate` mode it is the first step of deactivation (and may
 * skip the transfer); the deactivation runs in the same request.
 */
export const TransferDialog = ({
  member,
  members,
  defaultTransferId,
  mode,
  mutations,
  onClose,
}: {
  member: Member;
  members: Member[];
  defaultTransferId: string | null;
  mode: 'deactivate' | 'transfer';
  mutations: Mutations;
  onClose: () => void;
}) => {
  const targets = members.filter(
    (m) => m.user_id !== member.user_id && m.status === 'active' && (m.role === 'admin' || m.role === 'member'),
  );
  const preset = targets.some((m) => m.user_id === defaultTransferId) ? defaultTransferId! : null;
  const [to, setTo] = useState<string>(preset ?? (mode === 'deactivate' ? NO_TRANSFER : ''));
  const [scope, setScope] = useState<Set<TransferScope>>(
    () => new Set<TransferScope>(['boards', 'automations', 'webhooks', 'service_tokens']),
  );
  const toggle = (s: TransferScope) =>
    setScope((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  const transferring = to !== NO_TRANSFER && to !== '';
  const busy = mutations.deactivate.isPending || mutations.transfer.isPending;
  const error = mutations.deactivate.error ?? mutations.transfer.error;
  const body = transferring ? { to_user_id: to, scope: TRANSFER_SCOPES.filter((s) => scope.has(s)) } : undefined;
  const submit = () => {
    if (mode === 'deactivate') {
      mutations.deactivate.mutate(
        { id: member.user_id, transfer: body?.scope.length ? body : undefined },
        {
          onSuccess: (res) => {
            showToast({
              message: res.transfer
                ? `${t('adminUsers.deactivated', { name: displayName(member) })} · ${transferSummary(res.transfer)}`
                : t('adminUsers.deactivated', { name: displayName(member) }),
            });
            onClose();
          },
        },
      );
    } else if (body) {
      mutations.transfer.mutate(
        { id: member.user_id, body },
        {
          onSuccess: (res) => {
            showToast({ message: `${t('adminUsers.transfer.done')} · ${transferSummary(res)}` });
            onClose();
          },
        },
      );
    }
  };
  const options = [
    ...(mode === 'deactivate' ? [{ value: NO_TRANSFER, label: t('adminUsers.transfer.none') }] : []),
    ...targets.map((m) => ({
      value: m.user_id,
      label:
        m.user_id === defaultTransferId ? `${displayName(m)} · ${t('adminUsers.transfer.default')}` : displayName(m),
    })),
  ];
  const defaultMember = targets.find((m) => m.user_id === defaultTransferId);
  return (
    <Dialog
      open
      onClose={onClose}
      title={mode === 'deactivate' ? t('adminUsers.deactivate.title') : t('adminUsers.transfer.title')}
      subtitle={displayName(member)}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant={mode === 'deactivate' ? 'danger' : 'primary'}
            busy={busy}
            disabled={mode === 'transfer' ? !transferring || !scope.size : transferring && !scope.size}
            onClick={submit}
            data-testid="transfer-confirm"
          >
            {mode === 'deactivate'
              ? transferring
                ? t('adminUsers.deactivate.transferAndConfirm')
                : t('adminUsers.deactivate.confirm')
              : t('adminUsers.transfer.confirm')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Who member={member} />
        {mode === 'deactivate' ? <Notice tone="warn">{t('adminUsers.deactivate.explain')}</Notice> : null}
        <Field
          label={t('adminUsers.transfer.to')}
          hint={defaultMember ? t('adminUsers.transfer.defaultHint', { name: displayName(defaultMember) }) : undefined}
        >
          <Picker
            label={t('adminUsers.transfer.to')}
            value={to}
            onChange={setTo}
            placeholder={t('adminUsers.transfer.pick')}
            testId="transfer-to"
            options={options}
          />
        </Field>
        {transferring ? (
          <fieldset className="flex flex-col gap-0.5">
            <legend className="mb-1.5 text-xs font-semibold text-fg-2">{t('adminUsers.transfer.what')}</legend>
            {TRANSFER_SCOPES.map((s) => (
              <div key={s} data-testid={`transfer-scope-${s}`}>
                <CheckRow checked={scope.has(s)} onToggle={() => toggle(s)}>
                  <span className="flex flex-col">
                    <span>{t(`adminUsers.transfer.scope.${s}`)}</span>
                    {s === 'assignments' ? (
                      <span className="text-xs text-muted">{t('adminUsers.transfer.scope.assignments.hint')}</span>
                    ) : null}
                  </span>
                </CheckRow>
              </div>
            ))}
          </fieldset>
        ) : null}
        {error ? <Notice tone="error">{errorMessage(error)}</Notice> : null}
      </div>
    </Dialog>
  );
};

/** מחיקת פרטים (08 §3.2): only a deactivated member, irreversible — confirmed by typing their email. */
export const DeleteDetailsDialog = ({
  member,
  mutations,
  onClose,
}: {
  member: Member;
  mutations: Mutations;
  onClose: () => void;
}) => {
  const [display, setDisplay] = useState<'deleted' | 'first_name'>('deleted');
  const [typed, setTyped] = useState('');
  const run = mutations.deleteDetails;
  const matches = typed.trim().toLowerCase() === member.email.toLowerCase();
  const first = member.name.trim().split(/\s+/)[0] ?? '';
  return (
    <Dialog
      open
      role="alertdialog"
      onClose={onClose}
      title={t('adminUsers.deleteDetails.title')}
      subtitle={displayName(member)}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="danger"
            disabled={!matches}
            busy={run.isPending}
            data-testid="delete-details-confirm"
            onClick={() =>
              run.mutate(
                { id: member.user_id, display },
                {
                  onSuccess: () => {
                    showToast({ message: t('adminUsers.deleteDetails.done') });
                    onClose();
                  },
                },
              )
            }
          >
            {t('adminUsers.deleteDetails.confirm')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Who member={member} />
        <Notice tone="error">{t('adminUsers.deleteDetails.explain')}</Notice>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold text-fg-2">{t('adminUsers.deleteDetails.display')}</span>
          <Segmented<'deleted' | 'first_name'>
            label={t('adminUsers.deleteDetails.display')}
            value={display}
            onChange={setDisplay}
            className="w-auto self-start"
            options={[
              { value: 'deleted', label: t('adminUsers.deleteDetails.display.deleted') },
              ...(first
                ? [
                    {
                      value: 'first_name' as const,
                      label: t('adminUsers.deleteDetails.display.first', { name: first }),
                    },
                  ]
                : []),
            ]}
          />
        </div>
        <Field label={t('adminUsers.deleteDetails.typeEmail', { email: member.email })}>
          <Input
            dir="ltr"
            className="text-end"
            value={typed}
            placeholder={member.email}
            onChange={(e) => setTyped(e.target.value)}
            data-testid="delete-details-input"
            autoComplete="off"
          />
        </Field>
        {run.isError ? <Notice tone="error">{errorMessage(run.error)}</Notice> : null}
      </div>
    </Dialog>
  );
};
