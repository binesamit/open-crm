// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { t, type ExtensionConsent, type ExtensionPreview, tDynamic } from '@bines/shared';
import { Badge, Button, Dialog, Notice, Switch } from '@bines/ui';
import { errorMessage } from '../../lib/api';
import { ScopePicker, scopeFrom, scopeIncomplete, scopeToGrant } from './ScopePicker';

/** What the consent screen shows — from a preview (new install) or a waiting update. */
export type ConsentSubject = {
  name: string;
  version: string;
  icon: string | null;
  publisher: string;
  kind: 'data' | 'code';
  scopes: { scope: string; write: boolean }[];
  /** Scopes a waiting update adds (highlighted). */
  added?: string[];
  frameOrigins: string[];
  features: { key: string; type: string; name: string }[];
  data: {
    board_templates: number;
    starter_kit: { workspace_name: string; folders: number; boards: number; all_builtin: boolean } | null;
    automation_recipes: number;
    agent_templates: number;
  } | null;
  warnings: string[];
  /** The current grant (an update keeps it as the starting point). */
  initial?: { board_ids: string[] | null; workspace_ids: string[] | null; allow_guests: boolean };
};

const WRITE_SCOPES = new Set([
  'boards:write',
  'items:write',
  'updates:write',
  'users:write',
  'teams:write',
  'automations:write',
  'webhooks',
  'notifications:write',
  'agents:run',
  'agents:write',
]);
export const isWriteScope = (s: string) => WRITE_SCOPES.has(s);

/** A scope in plain words ("לקרוא לוחות ופריטים"). */
export const scopeLabel = (s: string) => tDynamic(`ext.scope.${s.replace(':', '_')}`);

/**
 * The consent screen (MARKETPLACE §4.4): what the extension adds, which permissions — in plain words, every one
 * switchable off (fewer may break it, never more) — on which boards, and whether guests may use it. Nothing is
 * installed until the admin accepts.
 */
/** The consent screen's subject from a preview (POST /extensions/preview). */
export const fromPreview = (p: ExtensionPreview): ConsentSubject => ({
  name: p.manifest.name,
  version: p.manifest.version,
  icon: p.manifest.icon ?? null,
  publisher: p.manifest.publisher.name,
  kind: p.kind,
  scopes: p.scopes,
  frameOrigins: p.frame_origins,
  features: p.features.map((f) => ({ key: f.key, type: f.type, name: f.name })),
  data: p.data,
  warnings: p.warnings,
});

export const ConsentDialog = ({
  accountId,
  subject,
  confirmLabel,
  onClose,
  onConfirm,
  note,
}: {
  accountId: string;
  subject: ConsentSubject;
  confirmLabel: string;
  onClose: () => void;
  onConfirm: (consent: ExtensionConsent) => Promise<unknown>;
  /** Round 13: a line above everything (copying a pack: which account it installs into). */
  note?: string;
}) => {
  const [scopes, setScopes] = useState<string[]>(subject.scopes.map((s) => s.scope));
  const [scope, setScope] = useState(() => scopeFrom(subject.initial ?? { board_ids: null }));
  const [guests, setGuests] = useState(subject.initial?.allow_guests ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm({
        accept: true,
        scopes: scopes as ExtensionConsent['scopes'],
        ...scopeToGrant(scope),
        allow_guests: guests,
      });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const d = subject.data;
  return (
    <>
      <Dialog
        open
        onClose={onClose}
        title={t('ext.consent.title', { name: subject.name })}
        subtitle={t('ext.consent.subtitle', { publisher: subject.publisher, version: subject.version })}
        footer={
          <div className="flex w-full flex-wrap items-center justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="accent"
              busy={busy}
              disabled={subject.kind === 'code' && scopeIncomplete(scope)}
              onClick={() => void accept()}
              data-testid="ext-consent-accept"
            >
              {confirmLabel}
            </Button>
          </div>
        }
      >
        <div className="space-y-4 text-sm" data-testid="ext-consent">
          {note ? (
            <div data-testid="ext-consent-note">
              <Notice tone="info">{note}</Notice>
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            {subject.icon ? (
              <span aria-hidden className="text-xl">
                {subject.icon}
              </span>
            ) : null}
            <Badge tone={subject.kind === 'code' ? 'violet' : 'info'}>{t(`ext.kind.${subject.kind}`)}</Badge>
          </div>
          {subject.warnings.map((w) => (
            <Notice key={w} tone={w === 'killed' ? 'error' : 'warn'}>
              {tDynamic(`ext.warning.${w}`)}
            </Notice>
          ))}

          <section className="space-y-1.5">
            <h3 className="font-bold text-heading">{t('ext.consent.adds')}</h3>
            <ul className="list-disc space-y-0.5 ps-5 text-fg-2">
              {subject.features.map((f) => (
                <li key={f.key}>{tDynamic(`ext.consent.feature.${f.type}`, { name: f.name })}</li>
              ))}
              {d?.starter_kit ? (
                <li>
                  {t('ext.consent.kit', {
                    name: d.starter_kit.workspace_name,
                    folders: d.starter_kit.folders,
                    boards: d.starter_kit.boards,
                  })}
                  {d.starter_kit.all_builtin ? ` ${t('ext.consent.kitAll')}` : ''}
                </li>
              ) : null}
              {d?.board_templates ? <li>{t('ext.consent.templates', { n: d.board_templates })}</li> : null}
              {d?.automation_recipes ? <li>{t('ext.consent.recipes', { n: d.automation_recipes })}</li> : null}
              {d?.agent_templates ? <li>{t('ext.consent.agents', { n: d.agent_templates })}</li> : null}
            </ul>
            {subject.frameOrigins.length ? (
              <p className="text-xs text-muted" data-testid="ext-consent-origins">
                {t('ext.consent.origins', { origins: subject.frameOrigins.join(', ') })}
              </p>
            ) : null}
          </section>

          {subject.scopes.length ? (
            <section className="space-y-1.5">
              <h3 className="font-bold text-heading">{t('ext.consent.permissions')}</h3>
              <p className="text-xs text-muted">{t('ext.consent.permissionsHint')}</p>
              <ul className="divide-y divide-line-soft rounded-[var(--radius)] border border-line">
                {subject.scopes.map((s) => (
                  <li key={s.scope} className="flex items-center gap-3 px-3 py-2" data-testid={`ext-scope-${s.scope}`}>
                    <span className="min-w-0 flex-1">
                      {scopeLabel(s.scope)}
                      {s.write ? (
                        <span className="ms-2">
                          <Badge tone="warn">{t('ext.scope.writes')}</Badge>
                        </span>
                      ) : null}
                      {subject.added?.includes(s.scope) ? (
                        <span className="ms-2">
                          <Badge tone="danger">{t('ext.consent.new')}</Badge>
                        </span>
                      ) : null}
                    </span>
                    <Switch
                      checked={scopes.includes(s.scope)}
                      label={scopeLabel(s.scope)}
                      onChange={(on) =>
                        setScopes((prev) => (on ? [...prev, s.scope] : prev.filter((x) => x !== s.scope)))
                      }
                    />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {subject.kind === 'code' ? (
            <section className="space-y-2">
              <h3 className="font-bold text-heading">{t('ext.consent.boards')}</h3>
              <ScopePicker accountId={accountId} value={scope} onChange={setScope} />
              <label className="flex items-center gap-3 pt-1">
                <span className="min-w-0 flex-1">
                  <span className="font-semibold">{t('ext.consent.guests')}</span>
                  <span className="block text-xs text-muted">{t('ext.consent.guestsHint')}</span>
                </span>
                <Switch checked={guests} onChange={setGuests} testId="ext-consent-guests" />
              </label>
            </section>
          ) : null}
          {error ? <Notice tone="error">{error}</Notice> : null}
        </div>
      </Dialog>
    </>
  );
};
