// SPDX-License-Identifier: AGPL-3.0-only
import {
  LOGIN_PROVIDERS,
  type LoginProvider,
  type SecuritySettings,
  ssoGoogleDomainSchema,
  ssoMicrosoftTenantSchema,
  t,
  type UpdateSecurity,
} from '@bines/shared';
import { Badge, Notice, Switch } from '@bines/ui';
import { useAuthConfig } from '../../lib/branding';
import { DomainList } from './AdminSecurity';
import { Panel, Row } from './admin-parts';

/**
 * Administration → אבטחה → "Sign in through Google / Microsoft": when on, the covered members open
 * this account only from a session made through one of the chosen providers (the server answers 403 sso_required and
 * the app offers those buttons). Covered: everyone, or only the listed email domains; admins may be exempt; the
 * platform owner always is. The server refuses a policy that would shut out the admin saving it, or one without a
 * provider the platform offers (owner console → sign-in providers). Joining stays by invitation only.
 *
 * S-72 (optional, recommended): the organisations a provider sign-in must come from — Google Workspace domains and
 * Microsoft directory (tenant) ids. Empty = any account of that provider, a personal one too.
 */
export const SsoPolicyPanel = ({
  settings,
  busy,
  onSave,
}: {
  settings: SecuritySettings;
  busy: boolean;
  onSave: (patch: UpdateSecurity) => void;
}) => {
  const config = useAuthConfig();
  const policy = settings.sso;
  const offered = (p: LoginProvider) => !!config.data?.[p];
  const anyOffered = LOGIN_PROVIDERS.some(offered);
  return (
    <Panel title={t('sso.policy.title')} hint={t('sso.policy.hint')} testId="security-sso">
      {config.data && !anyOffered ? (
        <div className="px-3.5 pt-3">
          <Notice tone="warn">
            <span data-testid="security-sso-none">{t('sso.policy.noProviders')}</span>
          </Notice>
        </div>
      ) : null}
      <Row label={t('sso.policy.required')} hint={t('sso.policy.requiredHint')}>
        <Switch
          checked={policy.required}
          onChange={(on) => onSave({ sso: { required: on } })}
          disabled={busy || (!policy.required && !anyOffered)}
          label={t('sso.policy.required')}
          testId="security-sso-required"
        />
      </Row>
      <Row label={t('sso.policy.providers')} hint={t('sso.policy.providersHint')}>
        <div className="flex flex-wrap items-center gap-4">
          {LOGIN_PROVIDERS.map((p) => (
            <label key={p} className="flex items-center gap-2 text-sm">
              <Switch
                checked={policy.providers.includes(p)}
                disabled={busy || (policy.providers.includes(p) && policy.providers.length === 1)}
                onChange={(on) =>
                  onSave({
                    sso: { providers: on ? [...policy.providers, p] : policy.providers.filter((x) => x !== p) },
                  })
                }
                testId={`security-sso-provider-${p}`}
              />
              {t(`sso.provider.${p}`)}
              {config.data && !offered(p) ? <Badge tone="warn">{t('sso.policy.notOffered')}</Badge> : null}
            </label>
          ))}
        </div>
      </Row>
      <Row
        label={t('sso.policy.domains')}
        hint={t('sso.policy.domainsHint')}
        className="max-md:flex-col max-md:items-stretch"
      >
        <div className="w-[360px] max-md:w-full">
          <DomainList
            value={policy.domains}
            onChange={(domains) => onSave({ sso: { domains } })}
            busy={busy}
            testId="security-sso-domain"
            label={t('sso.policy.domains')}
          />
        </div>
      </Row>
      <Row
        label={t('sso.policy.googleDomains')}
        hint={<Recommended text={t('sso.policy.googleDomainsHint')} show={!policy.google_domains.length} />}
        className="max-md:flex-col max-md:items-stretch"
        testId="security-sso-google-row"
      >
        <div className="w-[360px] max-md:w-full">
          <DomainList
            value={policy.google_domains}
            onChange={(google_domains) => onSave({ sso: { google_domains } })}
            busy={busy}
            testId="security-sso-google-domain"
            label={t('sso.policy.googleDomains')}
            schema={ssoGoogleDomainSchema}
          />
        </div>
      </Row>
      <Row
        label={t('sso.policy.microsoftTenants')}
        hint={<Recommended text={t('sso.policy.microsoftTenantsHint')} show={!policy.microsoft_tenants.length} />}
        className="max-md:flex-col max-md:items-stretch"
        testId="security-sso-microsoft-row"
      >
        <div className="w-[360px] max-md:w-full">
          <DomainList
            value={policy.microsoft_tenants}
            onChange={(microsoft_tenants) => onSave({ sso: { microsoft_tenants } })}
            busy={busy}
            testId="security-sso-microsoft-tenant"
            label={t('sso.policy.microsoftTenants')}
            schema={ssoMicrosoftTenantSchema}
            prefix=""
            placeholder="00000000-0000-0000-0000-000000000000"
          />
        </div>
      </Row>
      <Row label={t('sso.policy.exemptAdmins')} hint={t('sso.policy.exemptAdminsHint')}>
        <Switch
          checked={policy.exempt_admins}
          onChange={(on) => onSave({ sso: { exempt_admins: on } })}
          disabled={busy}
          label={t('sso.policy.exemptAdmins')}
          testId="security-sso-exempt-admins"
        />
      </Row>
    </Panel>
  );
};

/** A hint with a "recommended" chip while the optional list is still empty (S-72: recommend, don't require). */
const Recommended = ({ text, show }: { text: string; show: boolean }) => (
  <span className="inline-flex flex-wrap items-center gap-1.5">
    {show ? (
      <span data-testid="security-sso-recommended">
        <Badge tone="info">{t('sso.policy.recommended')}</Badge>
      </span>
    ) : null}
    <span>{text}</span>
  </span>
);
