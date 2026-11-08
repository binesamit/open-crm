// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import {
  type InboundEmailSettings,
  type InboundSenderPolicy,
  mailDomainSchema,
  type MyAccount,
  t,
  tDynamic,
} from '@bines/shared';
import { Button, Card, Field, Input, Notice, Segmented, Switch } from '@bines/ui';
import { showToast } from '../../lib/toast';
import { reasonMessage } from '../account/CopyLink';
import { useAccountDetail, useUpdateAccount } from './account-settings';
import { h2 } from './admin-parts';

/** "a.co.il, b.com" / one per line → the list (lower-case, no duplicates). */
const domainsOf = (text: string) => [
  ...new Set(
    text
      .split(/[\s,;]+/)
      .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
      .filter(Boolean),
  ),
];

/**
 * Administration → Connections → incoming email: items and boards get an email address — mail to an
 * item becomes an update, mail to a board a new item. On by default; who may send: anyone (an unknown sender shows
 * as external), members only, or listed domains. Needs the platform's inbound domain (owner console).
 */
export const InboundEmailCard = ({ account }: { account: MyAccount }) => {
  const detail = useAccountDetail(account).data;
  if (!detail) return null;
  return (
    <Form
      account={account}
      saved={detail.settings.inbound_email}
      domain={detail.platform_defaults?.inbound_domain ?? null}
    />
  );
};

const Form = ({
  account,
  saved,
  domain,
}: {
  account: MyAccount;
  saved: InboundEmailSettings;
  domain: string | null;
}) => {
  const update = useUpdateAccount(account);
  const [enabled, setEnabled] = useState(saved.enabled);
  const [senders, setSenders] = useState<InboundSenderPolicy>(saved.senders);
  const [domainsText, setDomainsText] = useState(saved.domains.join(', '));
  // the images of a message — the body's kept as files (above a size), the web's shown through the app.
  const [bodyImages, setBodyImages] = useState(saved.body_images);
  const [minKbText, setMinKbText] = useState(String(saved.body_image_min_kb));
  const [remoteImages, setRemoteImages] = useState(saved.remote_images);
  const minKb = Number(minKbText);
  const minKbOk = /^\d{1,4}$/.test(minKbText) && minKb <= 1024;
  const domains = domainsOf(domainsText);
  const bad = domains.filter((d) => !mailDomainSchema.safeParse(d).success);
  const ok = !bad.length && domains.length <= 50 && (senders !== 'domains' || domains.length > 0) && minKbOk;
  const dirty =
    enabled !== saved.enabled ||
    senders !== saved.senders ||
    domains.join(',') !== saved.domains.join(',') ||
    bodyImages !== saved.body_images ||
    minKb !== saved.body_image_min_kb ||
    remoteImages !== saved.remote_images;
  const save = () =>
    update.mutate(
      {
        settings: {
          inbound_email: {
            enabled,
            senders,
            domains,
            body_images: bodyImages,
            body_image_min_kb: minKb,
            remote_images: remoteImages,
          },
        },
      },
      {
        onSuccess: () => showToast({ message: t('admin.general.saved') }),
        onError: (err) => showToast({ message: reasonMessage(err), tone: 'error' }),
      },
    );
  return (
    <section data-testid="inbound-email-settings">
      <Card className="flex flex-col gap-3">
        <div className="space-y-0.5">
          <h2 className={h2}>{t('admin.inboundEmail.title')}</h2>
          <p className="text-xs text-muted">{t('admin.inboundEmail.hint')}</p>
        </div>
        {!domain ? <Notice>{t('admin.inboundEmail.noDomain')}</Notice> : null}
        <label className="flex items-center gap-2.5 text-sm text-fg">
          <Switch checked={enabled} onChange={setEnabled} testId="inbound-email-enabled" />
          {t('admin.inboundEmail.enabled')}
        </label>
        <Field label={t('admin.inboundEmail.senders')} hint={tDynamic(`admin.inboundEmail.senders.${senders}.hint`)}>
          <Segmented<InboundSenderPolicy>
            label={t('admin.inboundEmail.senders')}
            value={senders}
            onChange={setSenders}
            testId="inbound-email-senders"
            options={[
              { value: 'anyone', label: t('admin.inboundEmail.senders.anyone') },
              { value: 'members', label: t('admin.inboundEmail.senders.members') },
              { value: 'domains', label: t('admin.inboundEmail.senders.domains') },
            ]}
          />
        </Field>
        {senders === 'domains' ? (
          <Field
            label={t('admin.inboundEmail.domains')}
            hint={
              bad.length
                ? t('admin.inboundEmail.domainsBad', { list: bad.join(', ') })
                : t('admin.inboundEmail.domainsHint')
            }
          >
            <Input
              value={domainsText}
              dir="ltr"
              className="text-start"
              placeholder="example.com, example.co.il"
              onChange={(e) => setDomainsText(e.target.value)}
              data-testid="inbound-email-domains"
            />
          </Field>
        ) : null}
        <label className="flex items-start gap-2.5 text-sm text-fg">
          <Switch checked={bodyImages} onChange={setBodyImages} testId="inbound-email-body-images" />
          <span className="min-w-0">
            <span className="block">{t('admin.inboundEmail.bodyImages')}</span>
            <span className="block text-xs text-muted">{t('admin.inboundEmail.bodyImagesHint')}</span>
          </span>
        </label>
        {bodyImages ? (
          <Field
            label={t('admin.inboundEmail.minImage')}
            hint={minKbOk ? t('admin.inboundEmail.minImageHint') : t('admin.inboundEmail.minImageBad')}
          >
            <span className="flex items-center gap-1.5 text-xs text-muted">
              <Input
                value={minKbText}
                inputMode="numeric"
                dir="ltr"
                className="h-8 w-[5rem] text-center"
                aria-invalid={!minKbOk || undefined}
                onChange={(e) => setMinKbText(e.target.value.replace(/\D/g, '').slice(0, 4))}
                data-testid="inbound-email-min-image"
              />
              {t('admin.inboundEmail.kb')}
            </span>
          </Field>
        ) : null}
        <label className="flex items-start gap-2.5 text-sm text-fg">
          <Switch checked={remoteImages} onChange={setRemoteImages} testId="inbound-email-remote-images" />
          <span className="min-w-0">
            <span className="block">{t('admin.inboundEmail.remoteImages')}</span>
            <span className="block text-xs text-muted">{t('admin.inboundEmail.remoteImagesHint')}</span>
          </span>
        </label>
        <div className="flex justify-end">
          <Button
            variant="accent"
            size="sm"
            disabled={!ok || !dirty}
            busy={update.isPending}
            onClick={save}
            data-testid="inbound-email-save"
          >
            {t('common.save')}
          </Button>
        </div>
      </Card>
    </section>
  );
};
