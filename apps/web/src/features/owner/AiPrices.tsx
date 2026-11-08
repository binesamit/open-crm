// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AI_IMAGE_PRICE_KEY_RE,
  AI_PRICE_PROVIDERS,
  type AiPriceRow,
  type CreateAiPrice,
  type PlatformSettingsResponse,
  t,
  tDynamic,
} from '@bines/shared';
import { Button, Card, cn, Dialog, EmptyState, Field, Input, Notice, Picker, SkeletonRows, Switch } from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { confirmDialog } from '../../lib/dialogs';
import { showToast } from '../../lib/toast';
import { TD, TH } from '../trash/TrashPage';

const KEY = ['platform', 'ai-prices'] as const;
const fail = (e: unknown) => showToast({ message: errorMessage(e), tone: 'error' });
const saved = () => showToast({ message: t('admin.general.saved') });

const providerLabel = (p: string) => (p === '*' ? t('ai.prices.anyProvider') : tDynamic(`ai.provider.${p}`));
const num = (n: number | null) => (n === null ? '—' : `$${n}`);

/**
 * Owner console → "AI prices": the price table every AI call is costed with — per provider (or any) and
 * model, an exact id or a pattern with `*` (`gpt-5*`), USD per 1M tokens for input, output, cache reads and cache
 * writes. Seeded with the prices that used to be in code; an account's own per-connection price still wins. A model
 * nothing matches has an unknown price (its calls cost 0 and are flagged on the account's AI page).
 */
export const AiPricesPanel = () => {
  const qc = useQueryClient();
  const prices = useQuery({ queryKey: KEY, queryFn: () => api().get<{ data: AiPriceRow[] }>('/platform/ai-prices') });
  const [editing, setEditing] = useState<AiPriceRow | 'new' | null>(null);
  const remove = useMutation({
    mutationFn: (id: string) => api().delete<{ ok: true }>(`/platform/ai-prices/${id}`),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: KEY });
      saved();
    },
    onError: fail,
  });
  const askRemove = async (row: AiPriceRow) => {
    const ok = await confirmDialog({
      title: t('ai.prices.confirmDelete', { model: row.model }),
      message: t('ai.prices.confirmDeleteHint'),
      confirmLabel: t('common.delete'),
      danger: true,
    });
    if (ok) remove.mutate(row.id);
  };
  const rows = prices.data?.data ?? [];
  return (
    <section className="space-y-2.5" data-testid="owner-ai-prices">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-0.5">
          <h2 className="font-display text-base font-bold text-heading">{t('ai.prices.title')}</h2>
          <p className="max-w-[640px] text-xs text-muted">{t('ai.prices.hint')}</p>
        </div>
        <Button variant="accent" size="sm" data-testid="ai-price-new" onClick={() => setEditing('new')}>
          {t('ai.prices.add')}
        </Button>
      </header>
      {prices.isPending ? <SkeletonRows rows={3} label={t('app.loading')} /> : null}
      {prices.isError ? <Notice tone="error">{errorMessage(prices.error)}</Notice> : null}
      {prices.data && !rows.length ? <EmptyState title={t('ai.prices.empty')} testId="ai-prices-empty" /> : null}
      {rows.length ? (
        <div className="overflow-x-auto rounded-[12px] border border-line bg-surface">
          <table className="w-full min-w-[800px] border-collapse text-sm">
            <thead>
              <tr>
                <th className={TH}>{t('ai.prices.provider')}</th>
                <th className={TH}>{t('ai.prices.model')}</th>
                <th className={TH}>{t('ai.prices.input')}</th>
                <th className={TH}>{t('ai.prices.output')}</th>
                <th className={TH}>{t('ai.prices.cacheRead')}</th>
                <th className={TH}>{t('ai.prices.cacheWrite')}</th>
                <th className={TH}>{t('ai.prices.perImage')}</th>
                <th className={TH} />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} data-testid="ai-price-row" data-model={r.model} data-provider={r.provider}>
                  <td className={TD}>{providerLabel(r.provider)}</td>
                  <td className={TD}>
                    <bdi dir="ltr" className="font-medium text-heading">
                      {r.model}
                    </bdi>
                    {r.note ? <div className="text-xs text-muted">{r.note}</div> : null}
                  </td>
                  {[r.input, r.output, r.cache_read, r.cache_write].map((v, i) => (
                    <td key={i} className={cn(TD, 'tabular-nums')} data-testid={`ai-price-cell-${i}`}>
                      <bdi dir="ltr">{num(v)}</bdi>
                    </td>
                  ))}
                  <td className={cn(TD, 'tabular-nums')} data-testid="ai-price-cell-image">
                    <bdi dir="ltr">{imageSummary(r)}</bdi>
                  </td>
                  <td className={cn(TD, 'whitespace-nowrap')}>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(r)} data-testid="ai-price-edit">
                      {t('ai.edit')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void askRemove(r)} data-testid="ai-price-delete">
                      {t('common.delete')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <p className="text-xs text-muted">{t('ai.prices.unit')}</p>
      {editing ? (
        <PriceDialog
          key={editing === 'new' ? 'new' : editing.id}
          row={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </section>
  );
};

/** AI images: the per-image price, and how many size / quality prices the row has ("$0.04 +5"). */
const imageSummary = (r: AiPriceRow) => {
  const variants = Object.keys(r.image_prices ?? {}).length;
  if (r.per_image === null && !variants) return '—';
  return `${num(r.per_image)}${variants ? ` +${variants}` : ''}`;
};

const MODEL = /^[A-Za-z0-9._:/@*-]+$/;
const validImagePrice = (v: number | null) => v === null || (Number.isFinite(v) && v >= 0 && v <= 1000);
const parsePrice = (v: string) => (v.trim() === '' ? null : Number(v));
const validPrice = (v: number | null) => v === null || (Number.isFinite(v) && v >= 0 && v <= 10_000);

const PriceDialog = ({ row, onClose }: { row: AiPriceRow | null; onClose: () => void }) => {
  const qc = useQueryClient();
  const [provider, setProvider] = useState<string>(row?.provider ?? 'openai');
  const [model, setModel] = useState(row?.model ?? '');
  const [values, setValues] = useState({
    input: row ? String(row.input) : '',
    output: row ? String(row.output) : '',
    cache_read: row?.cache_read !== null && row?.cache_read !== undefined ? String(row.cache_read) : '',
    cache_write: row?.cache_write !== null && row?.cache_write !== undefined ? String(row.cache_write) : '',
  });
  const [note, setNote] = useState(row?.note ?? '');
  // AI images: a price per image, and per image by size / quality (`1024x1024/high`, `1536x1024`, `low`).
  const [perImage, setPerImage] = useState(
    row?.per_image !== null && row?.per_image !== undefined ? String(row.per_image) : '',
  );
  const [variants, setVariants] = useState<{ key: string; price: string }[]>(
    Object.entries(row?.image_prices ?? {}).map(([key, price]) => ({ key, price: String(price) })),
  );
  const save = useMutation({
    mutationFn: (body: CreateAiPrice) =>
      row
        ? api().patch<AiPriceRow>(`/platform/ai-prices/${row.id}`, body)
        : api().post<AiPriceRow>('/platform/ai-prices', body),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: KEY });
      saved();
      onClose();
    },
    onError: fail,
  });
  const input = parsePrice(values.input);
  const output = parsePrice(values.output);
  const cacheRead = parsePrice(values.cache_read);
  const cacheWrite = parsePrice(values.cache_write);
  const imagePrice = parsePrice(perImage);
  const variantRows = variants.filter((v) => v.key.trim() || v.price.trim());
  const variantsValid = variantRows.every(
    (v) => AI_IMAGE_PRICE_KEY_RE.test(v.key.trim()) && v.price.trim() !== '' && validImagePrice(Number(v.price)),
  );
  const valid =
    MODEL.test(model.trim()) &&
    input !== null &&
    output !== null &&
    [input, output, cacheRead, cacheWrite].every(validPrice) &&
    validImagePrice(imagePrice) &&
    variantsValid &&
    variantRows.length <= 30;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    save.mutate({
      provider: provider as CreateAiPrice['provider'],
      model: model.trim(),
      input: input!,
      output: output!,
      cache_read: cacheRead,
      cache_write: cacheWrite,
      per_image: imagePrice,
      image_prices: variantRows.length
        ? Object.fromEntries(variantRows.map((v) => [v.key.trim(), Number(v.price)]))
        : null,
      note: note.trim() || null,
    });
  };
  const field = (key: keyof typeof values, label: string, hint?: string) => (
    <Field label={label} hint={hint}>
      <Input
        dir="ltr"
        inputMode="decimal"
        value={values[key]}
        placeholder={key.startsWith('cache') ? t('ai.prices.cacheEmpty') : '0'}
        onChange={(e) => setValues({ ...values, [key]: e.target.value })}
        data-testid={`ai-price-${key}`}
      />
    </Field>
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={row ? t('ai.prices.edit') : t('ai.prices.add')}
      subtitle={t('ai.prices.dialogHint')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            type="submit"
            form="ai-price-form"
            busy={save.isPending}
            disabled={!valid}
            data-testid="ai-price-save"
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form id="ai-price-form" className="space-y-3" onSubmit={submit} data-testid="ai-price-form">
        <Field label={t('ai.prices.provider')}>
          <Picker
            value={provider}
            label={t('ai.prices.provider')}
            testId="ai-price-provider"
            onChange={setProvider}
            options={AI_PRICE_PROVIDERS.map((p) => ({
              value: p,
              label: providerLabel(p),
              testId: `ai-price-provider-${p === '*' ? 'any' : p}`,
            }))}
          />
        </Field>
        <Field label={t('ai.prices.model')} hint={t('ai.prices.modelHint')}>
          <Input
            dir="ltr"
            value={model}
            maxLength={120}
            onChange={(e) => setModel(e.target.value)}
            placeholder="gpt-5*"
            data-testid="ai-price-model"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          {field('input', t('ai.prices.input'))}
          {field('output', t('ai.prices.output'))}
          {field('cache_read', t('ai.prices.cacheRead'))}
          {field('cache_write', t('ai.prices.cacheWrite'))}
        </div>
        <div className="space-y-2 rounded-[10px] border border-line p-3" data-testid="ai-price-images">
          <div className="text-sm font-semibold text-fg">{t('ai.prices.images')}</div>
          <p className="text-xs text-muted">{t('ai.prices.imagesHint')}</p>
          <Field label={t('ai.prices.perImage')}>
            <Input
              dir="ltr"
              inputMode="decimal"
              value={perImage}
              placeholder={t('ai.prices.perImageEmpty')}
              onChange={(e) => setPerImage(e.target.value)}
              data-testid="ai-price-per_image"
            />
          </Field>
          {variants.map((v, i) => (
            <div key={i} className="flex items-end gap-2" data-testid="ai-price-variant">
              <div className="flex-1">
                <Field label={t('ai.prices.variantKey')}>
                  <Input
                    dir="ltr"
                    value={v.key}
                    placeholder="1024x1024/high"
                    maxLength={40}
                    onChange={(e) => setVariants(variants.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))}
                    data-testid="ai-price-variant-key"
                  />
                </Field>
              </div>
              <div className="w-28">
                <Field label={t('ai.prices.variantPrice')}>
                  <Input
                    dir="ltr"
                    inputMode="decimal"
                    value={v.price}
                    placeholder="0.04"
                    onChange={(e) =>
                      setVariants(variants.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))
                    }
                    data-testid="ai-price-variant-price"
                  />
                </Field>
              </div>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setVariants(variants.filter((_, j) => j !== i))}
                data-testid="ai-price-variant-remove"
              >
                {t('common.delete')}
              </Button>
            </div>
          ))}
          {variants.length < 30 ? (
            // type="button": inside the form a plain button submits it (the price was saved without its sizes).
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => setVariants([...variants, { key: '', price: '' }])}
              data-testid="ai-price-variant-add"
            >
              {t('ai.prices.variantAdd')}
            </Button>
          ) : null}
          <p className="text-xs text-muted">{t('ai.prices.imagesUnit')}</p>
        </div>
        <Field label={t('ai.prices.note')}>
          <Input value={note} maxLength={255} onChange={(e) => setNote(e.target.value)} data-testid="ai-price-note" />
        </Field>
        <p className="text-xs text-muted">{t('ai.prices.unit')}</p>
      </form>
    </Dialog>
  );
};

/**
 * Owner console → Platform settings: whether accounts may point an OpenAI-compatible AI connection at a private /
 * local address (a self-hosted Ollama or LM Studio). Off by default: the SSRF guard refuses such addresses.
 */
export const AiLocalEndpointsCard = ({ data }: { data: PlatformSettingsResponse }) => {
  const qc = useQueryClient();
  const on = data.settings.ai?.allow_local_endpoints ?? false;
  const origins = data.settings.ai?.local_endpoint_origins ?? [];
  // Audit 2026-10-10 #19: instead of the whole network, the owner may name the private AI servers (one per line).
  const [list, setList] = useState(origins.join('\n'));
  const save = useMutation({
    mutationFn: (patch: { allow_local_endpoints?: boolean; local_endpoint_origins?: string[] }) =>
      api().patch<PlatformSettingsResponse>('/platform/settings', { ai: patch }),
    onSuccess: (res) => {
      qc.setQueryData(['platform', 'settings'], res);
      setList((res.settings.ai?.local_endpoint_origins ?? []).join('\n'));
      saved();
    },
    onError: fail,
  });
  const parsed = list
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const dirty = parsed.join('\n') !== origins.join('\n');
  return (
    <Card className="space-y-2">
      <div data-testid="owner-ai-local" className="space-y-2">
        <h3 className="text-sm font-semibold text-fg">{t('ai.local.title')}</h3>
        <p className="text-xs text-muted">{t('ai.local.hint')}</p>
        <label className="flex items-center gap-2 text-sm">
          <Switch
            checked={on}
            disabled={save.isPending}
            onChange={(v) => save.mutate({ allow_local_endpoints: v })}
            label={t('ai.local.allow')}
            testId="owner-ai-local-allow"
          />
          {t('ai.local.allow')}
        </label>
        <Field label={t('ai.local.origins')} hint={t('ai.local.origins.hint')}>
          <textarea
            rows={3}
            maxLength={50 * 301}
            value={list}
            data-testid="owner-ai-local-origins"
            dir="ltr"
            onChange={(e) => setList(e.target.value)}
            className="w-full rounded-[10px] border border-line-strong bg-surface px-2.5 py-2 font-mono text-sm text-fg placeholder:text-muted focus:border-primary focus:ring-3 focus:ring-[var(--accent-soft)] focus:outline-none"
          />
        </Field>
        <Button
          size="sm"
          variant="secondary"
          disabled={!dirty || save.isPending}
          onClick={() => save.mutate({ local_endpoint_origins: parsed })}
          data-testid="owner-ai-local-origins-save"
        >
          {t('ai.local.origins.save')}
        </Button>
      </div>
    </Card>
  );
};
