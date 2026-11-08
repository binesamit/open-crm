// SPDX-License-Identifier: AGPL-3.0-only
import { getLocale, t, type ExtensionActionBlock, type ExtensionTriggerBlock } from '@bines/shared';
import { Input, Switch } from '@bines/ui';
import { columnTypeLabel } from '../../lib/locale';
import type { BoardDetail } from '../board/board-api';
import { PickerButton } from '../board/toolbar/parts';

/**
 * The form of an extension's automation action (D27 ת4), drawn from its manifest `inputs` — nothing here knows
 * any extension. Templates take `{item.…}` variables (rendered when the automation runs); a column field names a
 * column of this board.
 */
const en = () => getLocale() === 'en';

export const blockTitle = (b: { icon: string | null; name: string; name_en: string | null; extension_name: string }) =>
  `${b.icon ? `${b.icon} ` : ''}${(en() ? b.name_en : null) ?? b.name} · ${b.extension_name}`;

export const ExtensionBlockFields = ({
  block,
  board,
  value,
  issues,
  onChange,
}: {
  block: ExtensionActionBlock | undefined;
  board: BoardDetail;
  value: Record<string, unknown>;
  /** Paths of the server's issues (`actions.<i>.input.<key>`), already narrowed to this action. */
  issues: Set<string>;
  onChange: (next: Record<string, unknown>) => void;
}) => {
  if (!block)
    return (
      <p className="w-full text-xs text-danger-fg" data-testid="auto-ext-missing">
        {t('ext.auto.blockMissing')}
      </p>
    );
  if (!block.inputs.length) return null;
  const set = (key: string, v: unknown) => {
    const next = { ...value };
    if (v === undefined || v === '') delete next[key];
    else next[key] = v;
    onChange(next);
  };
  return (
    <div
      className="grid w-full gap-2 rounded-[12px] border border-line-soft p-2.5 sm:grid-cols-2"
      data-testid="auto-ext-fields"
      data-block={block.block}
    >
      {block.inputs.map((f) => {
        const label = `${(en() ? f.label_en : null) ?? f.label}${f.required ? ' *' : ''}`;
        const bad = issues.has(f.key);
        const v = value[f.key];
        const testId = `auto-ext-input-${f.key}`;
        return (
          <label key={f.key} className="block space-y-1 text-sm">
            <span className={bad ? 'text-xs font-semibold text-danger-fg' : 'text-xs font-semibold text-fg-2'}>
              {label}
            </span>
            {f.type === 'boolean' ? (
              <span className="flex h-9 items-center">
                <Switch
                  checked={v === true}
                  label={label}
                  onChange={(on) => set(f.key, on || undefined)}
                  testId={testId}
                />
              </span>
            ) : f.type === 'select' ? (
              <PickerButton
                menuLabel={label}
                placeholder={f.placeholder ?? t('ext.auto.choose')}
                label={f.options?.find((o) => o.value === v)?.label}
                testId={testId}
                items={(f.options ?? []).map((o) => ({ label: o.label, onSelect: () => set(f.key, o.value) }))}
              />
            ) : f.type === 'column' ? (
              <PickerButton
                menuLabel={label}
                placeholder={f.placeholder ?? t('ext.auto.chooseColumn')}
                label={board.columns.find((c) => c.id === v)?.title}
                testId={testId}
                items={board.columns
                  .filter((c) => !f.column_types?.length || f.column_types.includes(c.type))
                  .map((c) => ({
                    label: c.title,
                    keywords: columnTypeLabel(c.type),
                    onSelect: () => set(f.key, c.id),
                  }))}
              />
            ) : (
              <Input
                value={v === undefined || v === null ? '' : String(v)}
                inputMode={f.type === 'number' ? 'decimal' : undefined}
                dir={f.type === 'number' ? 'ltr' : undefined}
                placeholder={f.placeholder ?? (f.type === 'template' ? '{item.name}' : undefined)}
                aria-invalid={bad || undefined}
                data-testid={testId}
                onChange={(e) => {
                  const raw = e.target.value;
                  if (f.type !== 'number') return set(f.key, raw);
                  const n = Number(raw);
                  set(f.key, raw.trim() === '' ? undefined : Number.isFinite(n) ? n : raw);
                }}
              />
            )}
          </label>
        );
      })}
    </div>
  );
};

/**
 * an extension trigger's own fields (its manifest `inputs`), e.g. which of its buttons this automation
 * listens to — the automation then runs only for fires that carry the same values. Empty: every fire. Fields its page
 * prefilled (`openAutomationBuilder`) are shown read-only.
 */
export const ExtensionTriggerInputs = ({
  block,
  value,
  locked,
  issues,
  onChange,
}: {
  block: ExtensionTriggerBlock | undefined;
  value: Record<string, string>;
  locked?: string[];
  issues: { path: string }[];
  onChange: (next: Record<string, string> | undefined) => void;
}) => {
  if (!block?.inputs.length) return null;
  const set = (key: string, v: string) => {
    const next = { ...value };
    if (v === '') delete next[key];
    else next[key] = v;
    onChange(Object.keys(next).length ? next : undefined);
  };
  return (
    <div
      className="grid w-full gap-2 rounded-[12px] border border-line-soft p-2.5 sm:grid-cols-2"
      data-testid="auto-ext-trigger-inputs"
      data-block={block.block}
    >
      {block.inputs.map((f) => {
        const label = (en() ? f.label_en : null) ?? f.label;
        const bad = issues.some((i) => i.path === `trigger.inputs.${f.key}`);
        const fixed = locked?.includes(f.key) ?? false;
        return (
          <label key={f.key} className="block space-y-1 text-sm">
            <span className={bad ? 'text-xs font-semibold text-danger-fg' : 'text-xs font-semibold text-fg-2'}>
              {label}
            </span>
            <Input
              value={value[f.key] ?? ''}
              readOnly={fixed}
              aria-readonly={fixed || undefined}
              placeholder={f.placeholder ?? undefined}
              aria-invalid={bad || undefined}
              data-testid={`auto-ext-trigger-input-${f.key}`}
              onChange={(e) => {
                if (!fixed) set(f.key, e.target.value);
              }}
            />
          </label>
        );
      })}
    </div>
  );
};
