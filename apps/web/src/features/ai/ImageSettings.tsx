// SPDX-License-Identifier: AGPL-3.0-only
import {
  AI_IMAGES_MAX_CONCURRENCY,
  AI_IMAGE_QUALITIES,
  AI_IMAGE_SIZES,
  type AiSettings,
  type MyAccount,
  suggestModel,
  t,
  tDynamic,
} from '@bines/shared';
import { Notice, Picker, Segmented } from '@bines/ui';
import { Panel, Row } from '../admin/admin-parts';
import { modelChoices, modelPickerOptions, chatConnections, useAiConnections, useAiModels } from './ai-api';

type Images = AiSettings['images'];

/**
 * Administration → AI → "AI images": the connection + image model the "generate image" tool (assistant
 * agents, MCP) and the automation action use when they name none, the default size / quality and how many images
 * one call may make. Only models marked as making images are offered (the "images" badge; an admin marks a model of
 * an OpenAI-compatible server in its capabilities). No model chosen = automatic: the newest image model of the
 * connection's live list (any provider), named in the picker.
 */
export const ImageSettings = ({
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
  const s = settings.images;
  const connections = chatConnections(useAiConnections(account.id).data?.data);
  const save = (patch: Partial<Images>) => onSave({ images: { ...s, ...patch } });
  const conn = connections.find((c) => c.id === s.connection_id);
  const models = useAiModels(account.id, conn?.id ?? null);
  // The connection's live list only (ranked newest first): its image models.
  const imageModels = models.data
    ? modelChoices(models.data, s.model).filter((m) => m.capabilities.image_generation || m.id === s.model)
    : [];
  const auto = suggestModel(imageModels, 'image');
  const withCurrent = (list: readonly string[], v: string) => (list.includes(v) ? list : [v, ...list]);
  return (
    <Panel title={t('ai.images.title')} hint={t('ai.images.hint')} testId="ai-images-settings">
      <Row label={t('ai.images.connection')}>
        <Picker
          value={s.connection_id ?? ''}
          label={t('ai.images.connection')}
          placeholder={t('ai.images.pickConnection')}
          testId="ai-images-connection"
          onChange={(id) => save({ connection_id: id || null, model: null })}
          options={[
            { value: '', label: t('ai.images.off') },
            ...connections.map((c) => ({ value: c.id, label: c.name, testId: 'ai-images-connection-option' })),
          ]}
        />
      </Row>
      {conn ? (
        <Row label={t('ai.images.model')} hint={t('ai.images.modelHint')}>
          <Picker
            value={s.model ?? ''}
            label={t('ai.images.model')}
            placeholder={t('ai.images.pickModel')}
            testId="ai-images-model"
            onChange={(model) => save({ model: model || null })}
            options={[
              ...(auto
                ? [
                    {
                      value: '',
                      label: `${t('ai.models.auto')} · ${auto.display_name}`,
                      testId: 'ai-images-model-auto',
                    },
                  ]
                : []),
              ...modelPickerOptions(imageModels, 'ai-images-model-option'),
            ]}
          />
        </Row>
      ) : null}
      {conn && models.data && !imageModels.length ? (
        <div className="px-3.5 py-2" data-testid="ai-images-no-models">
          <Notice tone="warn">{t('ai.images.noModels')}</Notice>
        </div>
      ) : null}
      <Row label={t('ai.images.size')} hint={t('ai.images.sizeHint')}>
        <Picker
          value={s.size}
          label={t('ai.images.size')}
          testId="ai-images-size"
          onChange={(size) => save({ size })}
          options={withCurrent(AI_IMAGE_SIZES, s.size).map((v) => ({
            value: v,
            label: v === 'auto' ? t('ai.images.auto') : v,
          }))}
        />
      </Row>
      <Row label={t('ai.images.quality')}>
        <Picker
          value={s.quality}
          label={t('ai.images.quality')}
          testId="ai-images-quality"
          onChange={(quality) => save({ quality })}
          options={withCurrent(AI_IMAGE_QUALITIES, s.quality).map((v) => ({
            value: v,
            label: tDynamic(`ai.images.quality.${v}`),
          }))}
        />
      </Row>
      <Row label={t('ai.images.max')} hint={t('ai.images.maxHint')}>
        <Segmented
          value={String(s.max_images)}
          label={t('ai.images.max')}
          testId="ai-images-max"
          onChange={(v) => save({ max_images: Number(v) })}
          options={['1', '2', '3', '4'].map((v) => ({ value: v, label: v }))}
        />
      </Row>
      {/*: AI image column runs side by side (each run makes its images one after the other). */}
      <Row label={t('ai.images.concurrency')} hint={t('ai.images.concurrencyHint')}>
        <Segmented
          value={String(s.concurrency)}
          label={t('ai.images.concurrency')}
          testId="ai-images-concurrency"
          onChange={(v) => save({ concurrency: Number(v) })}
          options={Array.from({ length: AI_IMAGES_MAX_CONCURRENCY }, (_, i) => String(i + 1)).map((v) => ({
            value: v,
            label: v,
          }))}
        />
      </Row>
      {busy ? <span className="sr-only">{t('app.loading')}</span> : null}
    </Panel>
  );
};
