// SPDX-License-Identifier: AGPL-3.0-only
import { type AiSettings, type MyAccount, t, VOICE_MAX_SECONDS_LIMIT } from '@bines/shared';
import { Notice, Picker, Segmented, Switch } from '@bines/ui';
import { Panel, Row } from '../admin/admin-parts';
import { transcriptionConnections, useAiConnections, useTranscriptionModels } from './ai-api';

type Voice = AiSettings['voice'];

/** Languages offered as a hint (any ISO 639-1 code is valid; these are the common ones). */
const LANGUAGES = ['he', 'en', 'ar', 'ru', 'fr', 'es', 'de', 'am'] as const;
const MINUTES = [1, 2, 5, 10, 15, 30, 60] as const;

/**
 * Administration → AI → "Voice and transcription": the microphone in the update composer (on / off, the
 * longest recording) and speech to text — off until the admin turns it on and picks a connection that transcribes
 * (Soniox, OpenAI, an OpenAI-compatible server); the model (else the connection's newest), a language hint, and
 * whether the text goes straight into the update being written.
 */
export const VoiceSettings = ({
  account,
  settings,
  busy,
  onSave,
}: {
  account: MyAccount;
  settings: AiSettings;
  busy: boolean;
  onSave: (patch: Partial<AiSettings>) => void;
}) => {
  const v = settings.voice;
  const save = (patch: Partial<Voice>) => onSave({ voice: { ...v, ...patch } });
  const connections = transcriptionConnections(useAiConnections(account.id).data?.data);
  const conn = connections.find((c) => c.id === v.connection_id);
  const models = useTranscriptionModels(account.id, conn?.id ?? null).data?.data ?? [];
  const minutes = Math.round(v.max_seconds / 60);
  const minuteChoices = (MINUTES as readonly number[]).includes(minutes)
    ? MINUTES
    : [...MINUTES, minutes].sort((a, b) => a - b);
  return (
    <Panel title={t('ai.voice.title')} hint={t('ai.voice.hint')} testId="ai-voice-settings">
      <Row label={t('ai.voice.recording')} hint={t('ai.voice.recordingHint')}>
        <Switch
          checked={v.recording}
          disabled={busy}
          onChange={(on) => save({ recording: on })}
          label={t('ai.voice.recording')}
          testId="ai-voice-recording"
        />
      </Row>
      {v.recording ? (
        <Row label={t('ai.voice.maxMinutes')}>
          <Picker
            value={String(minutes)}
            label={t('ai.voice.maxMinutes')}
            testId="ai-voice-max"
            onChange={(m) => save({ max_seconds: Math.min(VOICE_MAX_SECONDS_LIMIT, Number(m) * 60) })}
            options={minuteChoices.map((m) => ({ value: String(m), label: String(m) }))}
          />
        </Row>
      ) : null}
      <Row label={t('ai.voice.transcription')} hint={t('ai.voice.transcriptionHint')}>
        <Switch
          checked={v.transcription}
          disabled={busy}
          onChange={(on) => save({ transcription: on })}
          label={t('ai.voice.transcription')}
          testId="ai-voice-transcription"
        />
      </Row>
      {v.transcription && !settings.enabled ? (
        <div className="px-3.5 py-2">
          <Notice tone="warn">{t('ai.voice.aiOff')}</Notice>
        </div>
      ) : null}
      {v.transcription ? (
        <>
          {connections.length ? (
            <Row label={t('ai.voice.connection')}>
              <Picker
                value={v.connection_id ?? ''}
                label={t('ai.voice.connection')}
                placeholder={t('ai.voice.pickConnection')}
                testId="ai-voice-connection"
                onChange={(id) => save({ connection_id: id || null, model: null })}
                options={connections.map((c) => ({ value: c.id, label: c.name, testId: 'ai-voice-connection-option' }))}
              />
            </Row>
          ) : (
            <div className="px-3.5 py-2" data-testid="ai-voice-no-connection">
              <Notice tone="info">{t('ai.voice.noConnection')}</Notice>
            </div>
          )}
          {conn ? (
            <Row label={t('ai.voice.model')} hint={t('ai.voice.modelHint')}>
              <Picker
                value={v.model ?? ''}
                label={t('ai.voice.model')}
                testId="ai-voice-model"
                onChange={(model) => save({ model: model || null })}
                options={[
                  {
                    value: '',
                    label: models[0]
                      ? `${t('ai.voice.modelAuto')} · ${models[0].display_name}`
                      : t('ai.voice.modelAuto'),
                  },
                  ...(v.model && !models.some((m) => m.id === v.model) ? [{ value: v.model, label: v.model }] : []),
                  ...models.map((m) => ({ value: m.id, label: m.display_name })),
                ]}
              />
            </Row>
          ) : null}
          <Row label={t('ai.voice.language')}>
            <Picker
              value={v.language ?? ''}
              label={t('ai.voice.language')}
              testId="ai-voice-language"
              onChange={(lang) => save({ language: lang || null })}
              options={[
                { value: '', label: t('ai.voice.languageAuto') },
                ...LANGUAGES.map((l) => ({ value: l, label: languageName(l) })),
                ...(v.language && !(LANGUAGES as readonly string[]).includes(v.language)
                  ? [{ value: v.language, label: languageName(v.language) }]
                  : []),
              ]}
            />
          </Row>
          {/* on request by default (the product owner) — nothing is charged until someone asks. */}
          <Row label={t('ai.voice.when')} hint={t(v.auto ? 'ai.voice.whenAutoHint' : 'ai.voice.whenRequestHint')}>
            <Segmented<'request' | 'auto'>
              label={t('ai.voice.when')}
              value={v.auto ? 'auto' : 'request'}
              onChange={(when) => !busy && save({ auto: when === 'auto' })}
              testId="ai-voice-auto"
              options={[
                { value: 'request', label: t('ai.voice.whenRequest'), testId: 'ai-voice-when-request' },
                { value: 'auto', label: t('ai.voice.whenAuto'), testId: 'ai-voice-when-auto' },
              ]}
            />
          </Row>
          <p className="px-3.5 pb-3 text-xs text-muted">{t('ai.voice.priceHint')}</p>
        </>
      ) : null}
      {busy ? <span className="sr-only">{t('app.loading')}</span> : null}
    </Panel>
  );
};

/** A language's own name in the UI language (Intl), else its code. */
const languageName = (code: string) => {
  try {
    return new Intl.DisplayNames([document.documentElement.lang || 'he'], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
};
