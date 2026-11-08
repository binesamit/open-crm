// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  DIGEST_FREQUENCIES,
  type DigestFrequency,
  formatHour,
  type MessageKey,
  NOTIFICATION_CATEGORIES,
  type NotificationDefaults,
  type NotificationSettings,
  PUSH_DEFAULT_CATEGORIES,
  t,
} from '@bines/shared';
import { Badge, Button, Card, cn, Notice, SkeletonRows, Switch } from '@bines/ui';
import { Icon } from '../../lib/icons';
import { api, errorMessage, type MyAccount } from '../../lib/api';
import { PickerButton } from '../board/toolbar/parts';
import { useAccountDetail, useUpdateAccount } from '../admin/account-settings';
import { PhoneNotificationsSection } from '../../pwa/PhoneNotificationsSection';
import { AdminPwaPushSection } from '../../pwa/AdminPwaSection';

type Category = { key: string; bell: boolean; email: boolean; push: boolean };
type Channel = 'bell' | 'email' | 'push';
type Patch = {
  categories?: { key: string; bell?: boolean; email?: boolean; push?: boolean }[];
  digest?: DigestFrequency;
  digest_hour?: number;
  digest_weekday?: number;
  quiet?: NotificationSettings['quiet'];
  badge?: boolean;
};
type Digest = { digest: DigestFrequency; digest_hour: number; digest_weekday: number };

/** The canvas table (`.tblbox` / `.tbl`): header 36px on surface-3, rows separated by line-soft. */
const TH = 'h-9 border-b border-line bg-surface-3 px-3 text-xs font-semibold whitespace-nowrap text-muted';
const TD = 'border-b border-line-soft px-3';
const TR = '[&:last-child>td]:border-b-0';

/** Category × bell / email switches (my settings, or the account defaults). */
const CategoryTable = ({
  categories,
  onChange,
  testId,
  rowTestId = 'notif-category',
}: {
  categories: Category[];
  onChange: (key: string, channel: Channel, on: boolean) => void;
  testId: string;
  rowTestId?: string;
}) => (
  <div className="overflow-x-auto rounded-[12px] border border-line bg-surface">
    <table className="w-full border-collapse text-sm" data-testid={testId}>
      <thead>
        <tr>
          <th className={cn(TH, 'text-start')}>{t('notifSettings.kind')}</th>
          <th className={cn(TH, 'w-20 text-center')}>{t('notifSettings.bell')}</th>
          <th className={cn(TH, 'w-20 text-center')}>{t('notifSettings.email')}</th>
          <th className={cn(TH, 'w-20 text-center')} data-testid="notif-push-header">
            {t('notifSettings.push')}
          </th>
        </tr>
      </thead>
      <tbody>
        {categories.map((c) => (
          <tr key={c.key} className={TR} data-testid={rowTestId} data-key={c.key}>
            <td className={cn(TD, 'h-[3.25rem] py-2 text-fg')}>{t(`notifSettings.category.${c.key}` as MessageKey)}</td>
            {(['bell', 'email', 'push'] as const).map((channel) => (
              <td key={channel} className={cn(TD, 'text-center align-middle')}>
                <Switch
                  label={`${t(`notifSettings.category.${c.key}` as MessageKey)} — ${t(`notifSettings.${channel}` as MessageKey)}`}
                  testId={`notif-${channel}`}
                  checked={c[channel]}
                  onChange={(on) => onChange(c.key, channel, on)}
                  className="align-middle"
                />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const hourLabel = (h: number) => formatHour(h);

/**
 * One email per notification, or a daily / weekly summary at a chosen hour (and weekday): stacked radio cards
 * (`.radio`), the day and hour pickers inside the chosen card.
 */
const DigestChooser = ({
  value,
  disabled,
  onChange,
  testPrefix,
}: {
  value: Digest;
  disabled?: boolean;
  onChange: (patch: Partial<Digest>) => void;
  testPrefix: string;
}) => (
  <div role="radiogroup" aria-label={t('notifSettings.digest')} className="flex flex-col gap-2">
    {DIGEST_FREQUENCIES.map((d) => {
      const on = value.digest === d;
      return (
        <div
          key={d}
          className={cn(
            'rounded-[12px] border bg-surface',
            on
              ? 'border-heading bg-surface-3 shadow-[inset_0_0_0_1px_var(--heading)]'
              : 'border-line hover:bg-surface-3',
          )}
        >
          <button
            type="button"
            role="radio"
            aria-checked={on}
            data-testid={`${testPrefix}-digest-${d}`}
            disabled={disabled}
            onClick={() => !on && onChange({ digest: d })}
            className="flex w-full items-center gap-2.5 p-3 text-start text-sm disabled:cursor-not-allowed"
          >
            <span
              aria-hidden
              className={cn(
                'size-[0.9375rem] shrink-0 rounded-full border bg-surface',
                on ? 'border-[4.5px] border-[var(--check)]' : 'border-line-strong',
              )}
            />
            <span className={cn('text-fg', on && 'font-semibold')}>{t(`notifSettings.digest.${d}` as MessageKey)}</span>
          </button>
          {on && d !== 'instant' ? (
            <div className="-mt-1 flex flex-wrap items-center gap-2 ps-[2.3125rem] pe-3 pb-3 text-sm">
              {d === 'weekly' ? (
                <PickerButton
                  testId={`${testPrefix}-digest-weekday`}
                  menuLabel={t('notifSettings.digest.on')}
                  placeholder=""
                  className="h-9 w-[140px]"
                  label={`${t('notifSettings.digest.on')} ${t(`weekday.${value.digest_weekday}` as MessageKey)}`}
                  items={[0, 1, 2, 3, 4, 5, 6].map((wd) => ({
                    label: t(`weekday.${wd}` as MessageKey),
                    checked: wd === value.digest_weekday,
                    onSelect: () => onChange({ digest_weekday: wd }),
                  }))}
                />
              ) : null}
              <PickerButton
                testId={`${testPrefix}-digest-hour`}
                menuLabel={t('notifSettings.digest.at')}
                placeholder=""
                className="h-9 w-[120px]"
                label={`${t('notifSettings.digest.at')} ${hourLabel(value.digest_hour)}`}
                items={Array.from({ length: 24 }, (_, h) => ({
                  label: hourLabel(h),
                  checked: h === value.digest_hour,
                  onSelect: () => onChange({ digest_hour: h }),
                }))}
              />
            </div>
          ) : null}
        </div>
      );
    })}
  </div>
);

const SectionTitle = ({ children }: { children: string }) => (
  <h2 className="font-display text-base leading-snug font-bold text-heading">{children}</h2>
);

/**
 * "הגדרות התראות" (08 §12.3): per category, bell and email; one email per notification or a daily / weekly
 * summary at a chosen hour; the boards I muted. Admins also set the account defaults. Settings are per account.
 */
/**
 * fix5: lives in "הפרופיל שלי" → התראות (`embedded`: a section under the profile's tabs, no page title or padding);
 * /settings/notifications redirects there.
 */
export const NotificationSettingsPage = ({ account, embedded = false }: { account: MyAccount; embedded?: boolean }) => {
  const qc = useQueryClient();
  const client = api(account.id);
  const key = ['account', account.id, 'notification-settings'];
  const settings = useQuery({
    queryKey: key,
    queryFn: () => client.get<NotificationSettings>('/me/notifications/settings'),
    // The app badge (r19pwa) keeps this query for minutes: the page always reads the current settings when it opens.
    refetchOnMount: 'always',
  });
  // Optimistic: the checkbox / choice moves at once; the server's answer (or a refetch on error) settles it.
  const save = useMutation({
    mutationFn: (patch: Patch) => client.patch<NotificationSettings>('/me/notifications/settings', patch),
    onMutate: async (patch) => {
      // A load still on its way (the page refetches when it opens) would land after this and undo the choice.
      await qc.cancelQueries({ queryKey: key });
      qc.setQueryData<NotificationSettings>(key, (old) =>
        old
          ? {
              ...old,
              digest: patch.digest ?? old.digest,
              digest_hour: patch.digest_hour ?? old.digest_hour,
              digest_weekday: patch.digest_weekday ?? old.digest_weekday,
              quiet: patch.quiet ?? old.quiet,
              badge: patch.badge ?? old.badge,
              categories: old.categories.map((c) => {
                const p = patch.categories?.find((x) => x.key === c.key);
                return { ...c, bell: p?.bell ?? c.bell, email: p?.email ?? c.email, push: p?.push ?? c.push };
              }),
            }
          : old,
      );
    },
    onSuccess: (data) => qc.setQueryData(key, data),
    onError: () => qc.invalidateQueries({ queryKey: key }),
  });
  const unmute = useMutation({
    mutationFn: (boardId: string) => client.put(`/boards/${boardId}/notifications`, { muted: false }),
    onSuccess: (_data, boardId) =>
      Promise.all([
        qc.invalidateQueries({ queryKey: key }),
        qc.invalidateQueries({ queryKey: ['account', account.id, 'board', boardId, 'notifications'] }),
      ]),
  });

  const s = settings.data;
  const Root = embedded ? 'section' : 'main';
  return (
    <Root className={embedded ? 'space-y-4' : 'w-full space-y-4 px-4 py-5 md:px-6'}>
      <header className="space-y-1">
        {embedded ? null : (
          <h1 className="font-display text-[1.875rem] leading-tight font-extrabold tracking-[-0.6px] text-heading max-md:text-2xl">
            {t('notifSettings.title')}
          </h1>
        )}
        <p className="max-w-[640px] text-sm text-muted">{t('notifSettings.intro')}</p>
      </header>
      {settings.isError ? <Notice tone="error">{errorMessage(settings.error)}</Notice> : null}
      {save.isError ? <Notice tone="error">{errorMessage(save.error)}</Notice> : null}
      {!s ? (
        <SkeletonRows rows={5} label={t('app.loading')} className="max-w-[560px]" />
      ) : (
        <div className="flex items-start gap-5 max-md:flex-col max-md:items-stretch">
          <div className="flex min-w-0 flex-[1_1_560px] flex-col gap-5 max-md:flex-auto">
            <section className="flex flex-col gap-2">
              <SectionTitle>{t('notifSettings.mine')}</SectionTitle>
              <CategoryTable
                testId="notif-settings"
                categories={s.categories}
                onChange={(k, channel, on) => save.mutate({ categories: [{ key: k, [channel]: on }] })}
              />
            </section>

            <Card className="flex flex-col gap-3">
              <SectionTitle>{t('notifSettings.digest')}</SectionTitle>
              <DigestChooser value={s} disabled={save.isPending} onChange={(p) => save.mutate(p)} testPrefix="notif" />
            </Card>

            <PhoneNotificationsSection
              account={account}
              settings={s}
              busy={save.isPending}
              onSave={(p) => save.mutate(p)}
            />

            <section className="flex flex-col gap-2">
              <SectionTitle>{t('notifSettings.muted')}</SectionTitle>
              {s.muted_boards.length ? (
                <ul className="overflow-hidden rounded-[14px] border border-line">
                  {s.muted_boards.map((b) => (
                    <li
                      key={b.id}
                      className="flex items-center gap-3 border-b border-line-soft bg-surface px-3.5 py-3 text-sm last:border-b-0"
                      data-testid="notif-muted-board"
                      data-name={b.name}
                    >
                      <Icon name="board" size={15} className="shrink-0 text-muted" />
                      <Link
                        to="/a/$accountSlug/b/$boardId"
                        params={{ accountSlug: account.slug, boardId: b.id }}
                        className="min-w-0 flex-1 truncate font-semibold text-fg hover:underline"
                      >
                        {b.name}
                      </Link>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={unmute.isPending}
                        onClick={() => unmute.mutate(b.id)}
                      >
                        {t('notifSettings.unmute')}
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted">{t('notifSettings.mutedNone')}</p>
              )}
            </section>
          </div>

          {account.role === 'admin' ? (
            // The account defaults live in Administration → התראות (product decision, account admin A3).
            <aside
              className="flex min-w-0 flex-[0_1_340px] flex-col max-md:flex-auto"
              data-testid="notif-defaults-link-card"
            >
              <Card soft className="flex flex-col gap-2">
                <span className="self-start">
                  <Badge tone="ok">{t('role.admin')}</Badge>
                </span>
                <SectionTitle>{t('notifSettings.defaults')}</SectionTitle>
                <p className="text-xs text-muted">{t('notifSettings.defaults.moved')}</p>
                <Link
                  to="/a/$accountSlug/admin/$section"
                  params={{ accountSlug: account.slug, section: 'notifications' }}
                  data-testid="notif-defaults-link"
                  className="press inline-flex h-8 items-center justify-center gap-1.5 self-start rounded-[10px] border border-line-strong bg-surface px-2.5 text-[0.8125rem] whitespace-nowrap text-heading hover:bg-surface-2"
                >
                  <Icon name="gear" size={14} />
                  {t('notifSettings.defaults.open')}
                </Link>
              </Card>
            </aside>
          ) : null}
        </div>
      )}
    </Root>
  );
};

/**
 * Administration → התראות (admins): what members get until they choose (account_settings.notifications) —
 * per category bell / email, and the summary schedule. Personal choices stay on the member's own page.
 */
export const AccountNotificationDefaults = ({ account }: { account: MyAccount }) => {
  const qc = useQueryClient();
  const detail = useAccountDetail(account);
  const update = useUpdateAccount(account);
  // Members' effective settings follow the defaults, so the personal page refetches too.
  const save = (notifications: Partial<NotificationDefaults>) =>
    update.mutate(
      { settings: { notifications } },
      { onSuccess: () => qc.invalidateQueries({ queryKey: ['account', account.id, 'notification-settings'] }) },
    );
  const d = detail.data?.settings.notifications;
  if (detail.isError) return <Notice tone="error">{errorMessage(detail.error)}</Notice>;
  if (!d) return <SkeletonRows rows={4} label={t('app.loading')} />;
  // The phone column: unset = assignment and mention on (PUSH_DEFAULT_CATEGORIES).
  const categories: Category[] = NOTIFICATION_CATEGORIES.map((k) => {
    const c = d.categories.find((x) => x.key === k);
    return {
      key: k,
      bell: c?.bell ?? true,
      email: c?.email ?? true,
      push: c?.push ?? PUSH_DEFAULT_CATEGORIES.includes(k),
    };
  });
  return (
    <section
      className="flex min-w-0 flex-col gap-3"
      data-testid="notif-defaults"
      aria-label={t('notifSettings.defaults')}
    >
      <Card className="flex flex-col gap-3">
        <SectionTitle>{t('notifSettings.defaults')}</SectionTitle>
        <p className="text-xs text-muted">{t('notifSettings.defaults.hint')}</p>
        {update.isError ? <Notice tone="error">{errorMessage(update.error)}</Notice> : null}
        <CategoryTable
          testId="notif-defaults-table"
          rowTestId="notif-default-category"
          categories={categories}
          onChange={(k, channel, on) =>
            save({
              categories: categories.map((c) =>
                c.key === k ? { ...c, [channel]: on } : c,
              ) as NotificationDefaults['categories'],
            })
          }
        />
        <h3 className="mt-1 text-xs font-semibold text-fg-2">{t('notifSettings.digest')}</h3>
        <DigestChooser value={d} disabled={update.isPending} onChange={(p) => save(p)} testPrefix="notif-defaults" />
      </Card>
      <AdminPwaPushSection account={account} />
      <Card soft>
        <div className="flex flex-wrap items-center gap-3" data-testid="notif-defaults-personal">
          <Icon name="bell" size={18} className="shrink-0 text-heading" />
          <p className="min-w-0 flex-[1_1_220px] text-sm text-muted">{t('notifSettings.defaults.personal')}</p>
          <Link
            to="/a/$accountSlug/profile"
            params={{ accountSlug: account.slug }}
            search={{ tab: 'notifications' }}
            data-testid="notif-defaults-personal-link"
            className="press inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-[10px] border border-line-strong bg-surface px-2.5 text-[0.8125rem] whitespace-nowrap text-heading hover:bg-surface-2"
          >
            {t('notifSettings.title')}
          </Link>
        </div>
      </Card>
    </section>
  );
};
