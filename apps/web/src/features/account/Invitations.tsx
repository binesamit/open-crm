// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type ReactNode } from 'react';
import { formatDateTime, t, type InvitationStatus } from '@bines/shared';
import { Badge, Button, cn, Dialog, Menu, type MenuEntry, useActionMenu } from '@bines/ui';
import type { Invitation } from '../../lib/api';
import { confirmDialog } from '../../lib/dialogs';
import { Icon } from '../../lib/icons';
import { showToast } from '../../lib/toast';
import { Ago } from '../trash/TrashPage';
import { CopyLinkField, reasonMessage } from './CopyLink';
import { brandText } from '../../lib/branding';

/**
 * Invitations, one shared look (product owner: "לשגר לו למייל, להקפיץ לו את המייל, לבטל את ההזמנה" — in the owner
 * console and in the account): the status chip, who invited and when, the email history, and the actions — send
 * again (with another lifetime), copy a fresh link, cancel. Used by Administration → Users and the owner console.
 */

/** Lifetimes offered when sending again / copying a link (the account's default comes first, unmarked). */
export const EXPIRY_CHOICES = [1, 3, 7, 14, 30, 60, 90] as const;

const TONE: Record<InvitationStatus, 'neutral' | 'info' | 'ok' | 'warn' | 'danger'> = {
  link: 'neutral',
  sent: 'info',
  failed: 'danger',
  opened: 'ok',
  expired: 'warn',
};

export const InvitationStatusChip = ({ inv }: { inv: Invitation }) => {
  const status = inv.status ?? 'sent';
  return (
    <span data-testid="invitation-status" data-status={status} className="contents">
      <Badge tone={TONE[status]}>{t(`invites.status.${status}`)}</Badge>
    </span>
  );
};

/** "חבר צוות · הזמין/ה דנה · לפני 3 ימים · נשלח 2 פעמים · בתוקף עד 14/10". */
export const InvitationMeta = ({ inv, now }: { inv: Invitation; now: number }) => (
  <span className="text-[0.6875rem] text-muted" data-testid="invitation-meta">
    {t(`role.${inv.role}`)}
    {inv.invited_by ? <> · {t('invites.by', { name: inv.invited_by.name })}</> : null} ·{' '}
    <Ago iso={inv.created_at} now={now} />
    {inv.last_sent_at ? (
      <>
        {' '}
        · <span title={formatDateTime(inv.last_sent_at)}>{t('invites.sentTimes', { n: inv.send_count ?? 1 })}</span>
      </>
    ) : null}
    {' · '}
    <span title={formatDateTime(inv.expires_at)}>
      {inv.status === 'expired'
        ? t('invites.expiredAgo', { date: formatDateTime(inv.expires_at) })
        : t('invites.validUntil', { date: formatDateTime(inv.expires_at) })}
    </span>
  </span>
);

/** The answer of "send again" / "copy link": the invitation with its new link. */
export type ReissueResult = { invitation: Invitation; emailed: boolean };

export type InvitationHandlers = {
  /** Email it again; `days` = the new link's lifetime (undefined = the account's default). */
  resend: (id: string, days?: number) => Promise<ReissueResult>;
  /** A fresh link to copy (nothing emailed). */
  link: (id: string, days?: number) => Promise<ReissueResult>;
  revoke: (id: string) => Promise<unknown>;
};

/** The dialog with a fresh invitation link to copy / send by WhatsApp. */
export const InvitationLinkDialog = ({
  shown,
  onClose,
}: {
  shown: { email: string; url: string; emailed: boolean } | null;
  onClose: () => void;
}) =>
  shown ? (
    <Dialog open onClose={onClose} title={t('adminUsers.inviteLink.title')} subtitle={shown.email}>
      <div className="space-y-3 whitespace-normal" data-testid="invite-link-dialog">
        <CopyLinkField url={shown.url} message={brandText('invite.links.message')} testId="invite-link-dialog-field" />
        <p className="text-xs text-muted">{t(shown.emailed ? 'invites.link.emailedToo' : 'invites.link.note')}</p>
      </div>
    </Dialog>
  ) : null;

/**
 * The actions of one invitation: "שליחה מחדש" (one click, the default lifetime), "העתקת קישור", "⋯" (send again /
 * copy a link valid N days) and "ביטול" (confirmed: the link stops working at once).
 */
export const InvitationActions = ({
  inv,
  handlers,
  onLink,
}: {
  inv: Invitation;
  handlers: InvitationHandlers;
  /** Shows the dialog with the new link. */
  onLink: (shown: { email: string; url: string; emailed: boolean }) => void;
}) => {
  const [busy, setBusy] = useState<'resend' | 'link' | 'revoke' | null>(null);
  const menu = useActionMenu();
  const run = async (kind: 'resend' | 'link' | 'revoke', fn: () => Promise<unknown>) => {
    setBusy(kind);
    try {
      await fn();
    } catch (err) {
      showToast({ message: reasonMessage(err), tone: 'error' });
    } finally {
      setBusy(null);
    }
  };
  const resend = (days?: number) =>
    run('resend', async () => {
      const res = await handlers.resend(inv.id, days);
      showToast({
        message: res.emailed ? t('adminUsers.resent', { n: 1 }) : t('invites.emailFailed'),
        tone: res.emailed ? undefined : 'error',
      });
      if (!res.emailed && res.invitation.url) onLink({ email: inv.email, url: res.invitation.url, emailed: false });
    });
  const link = (days?: number) =>
    run('link', async () => {
      const res = await handlers.link(inv.id, days);
      if (res.invitation.url) onLink({ email: inv.email, url: res.invitation.url, emailed: false });
    });
  const revoke = () =>
    void confirmDialog({
      title: t('invites.revoke.title', { email: inv.email }),
      message: t('invites.revoke.body'),
      confirmLabel: t('invites.revoke.confirm'),
      danger: true,
    }).then((ok) => {
      if (!ok) return;
      void run('revoke', async () => {
        await handlers.revoke(inv.id);
        showToast({ message: t('invites.revoked', { email: inv.email }) });
      });
    });
  const days = (kind: 'resend' | 'link'): MenuEntry[] =>
    EXPIRY_CHOICES.map((n) => ({
      label: t('invites.validDays', { n }),
      testId: `invitation-${kind}-days-${n}`,
      onSelect: () => void (kind === 'resend' ? resend(n) : link(n)),
    }));
  const items: MenuEntry[] = [
    {
      kind: 'submenu',
      label: t('invites.resendFor'),
      icon: <Icon name="send" size={16} />,
      testId: 'invitation-resend-for',
      items: days('resend'),
    },
    {
      kind: 'submenu',
      label: t('invites.linkFor'),
      icon: <Icon name="link" size={16} />,
      testId: 'invitation-link-for',
      items: days('link'),
    },
  ];
  return (
    <span className="flex flex-wrap items-center gap-1">
      <Button
        variant="ghost"
        size="sm"
        data-testid="invitation-resend"
        busy={busy === 'resend'}
        onClick={() => void resend()}
      >
        <Icon name="send" size={14} />
        {t('adminUsers.resend')}
      </Button>
      {/* fix8: the link itself, to send by WhatsApp etc. when email does not arrive. */}
      <Button
        variant="ghost"
        size="sm"
        data-testid="invitation-copy-link"
        busy={busy === 'link'}
        onClick={() => void link()}
      >
        <Icon name="link" size={14} />
        {t('adminUsers.copyInviteLink')}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        aria-haspopup="menu"
        aria-label={t('invites.more')}
        data-tip={t('invites.more')}
        data-testid="invitation-more"
        onClick={menu.fromTrigger}
      >
        ⋯
      </Button>
      <Menu at={menu.at} onClose={menu.close} items={items} label={inv.email} testId="invitation-menu" />
      <Button
        variant="ghost"
        size="sm"
        className="text-danger-fg hover:text-danger-fg"
        data-testid="invitation-revoke"
        busy={busy === 'revoke'}
        onClick={revoke}
      >
        {t('members.revoke')}
      </Button>
    </span>
  );
};

/** One invitation row: [leading] email + meta · status · actions. */
export const InvitationRowBody = ({
  inv,
  now,
  leading,
  actions,
  className,
}: {
  inv: Invitation;
  now: number;
  leading?: ReactNode;
  actions: ReactNode;
  className?: string;
}) => (
  <div className={cn('flex flex-wrap items-center gap-3', className)}>
    {leading}
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="truncate text-start font-semibold [unicode-bidi:isolate]" dir="ltr">
        {inv.email}
      </span>
      <InvitationMeta inv={inv} now={now} />
    </span>
    <InvitationStatusChip inv={inv} />
    {actions}
  </div>
);
