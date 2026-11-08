// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo, useState } from 'react';
import {
  actionSentence,
  AUTOMATION_TEMPLATES,
  he,
  t,
  TEMPLATE_CATEGORIES,
  triggerSentence,
  type Action,
  type AutomationTemplate,
  type MessageKey,
  type SentenceBoard,
  type SentencePart,
  type TemplateCategory,
  type Trigger,
} from '@bines/shared';
import { cn, EmptyState, SearchField } from '@bines/ui';
import { Icon, type IconName } from '../../lib/icons';

/** A key of the r15auto strings (merged into he/en.json later): `null` until it exists, so nothing shows a raw key. */
const optional = (key: string) => (key in he ? t(key as MessageKey) : null);

/** Each category's icon (one look per kind of recipe). */
const CATEGORY_ICON: Record<TemplateCategory, IconName> = {
  status: 'check',
  items: 'plus',
  dates: 'calendar',
  people: 'people',
  cross_board: 'board',
  communication: 'bell',
  integrations: 'link',
};

type Shown = { tpl: AutomationTemplate; trigger: SentencePart[]; actions: SentencePart[][]; desc: string | null };

/** The sentence: plain words, the parts you fill highlighted (blank ones dashed until chosen in the builder). */
const Parts = ({ parts }: { parts: SentencePart[] }) => (
  <>
    {parts.map((p, i) =>
      p.slot ? (
        <span
          key={i}
          data-slot={p.slot}
          className={cn(
            'mx-0.5 inline-block rounded-[6px] px-1.5 font-semibold leading-6',
            p.empty ? 'border border-dashed border-[var(--accent)] text-accent-fg' : 'bg-accent-soft text-accent-fg',
          )}
        >
          {p.text || '…'}
        </span>
      ) : (
        <span key={i}>{p.text}</span>
      ),
    )}
  </>
);

/**
 * The built-in recipes: each one reads as a sentence — "When status changes to …, then notify …"
 * with the parts to fill highlighted, a short line of what it is for, grouped by category with its icon, and a
 * search over all of it. Choosing one opens the builder with it.
 */
export const TemplatePicker = ({
  sb,
  onPick,
  onCustom,
}: {
  sb: SentenceBoard;
  onPick: (tpl: AutomationTemplate) => void;
  onCustom: () => void;
}) => {
  const [q, setQ] = useState('');
  const [category, setCategory] = useState<TemplateCategory | 'all'>('all');
  const shown = useMemo<Shown[]>(
    () =>
      AUTOMATION_TEMPLATES.map((tpl) => ({
        tpl,
        trigger: triggerSentence(tpl.draft.trigger as unknown as Trigger, sb),
        actions: tpl.draft.actions.map((a, j) => actionSentence(a as unknown as Action, j, sb)),
        desc: optional(`auto.tpl.${tpl.id}.desc`),
      })),
    [sb],
  );
  const needle = q.trim().toLowerCase();
  const matches = (s: Shown) => {
    if (category !== 'all' && s.tpl.category !== category) return false;
    if (!needle) return true;
    const text = [
      ...s.trigger.map((p) => p.text),
      ...s.actions.flat().map((p) => p.text),
      s.desc ?? '',
      t(`auto.category.${s.tpl.category}` as MessageKey),
    ]
      .join(' ')
      .toLowerCase();
    return text.includes(needle);
  };
  const visible = shown.filter(matches);
  const then = t('auto.word.then');
  const and = t('auto.word.and');

  return (
    <div className="flex flex-col gap-3.5" data-testid="auto-templates" data-tour="automations.templates">
      <button
        type="button"
        data-testid="auto-custom"
        onClick={onCustom}
        className="flex w-full items-center gap-3 rounded-[14px] border border-dashed border-line-strong p-3.5 text-start hover:bg-surface-3"
      >
        <span className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-accent-soft text-accent-fg">
          <Icon name="plus" size={18} />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="font-semibold">{t('auto.create.custom')}</span>
          <span className="text-xs text-muted">{t('auto.create.custom_hint')}</span>
        </span>
      </button>

      <div className="flex flex-col gap-2.5">
        <SearchField
          value={q}
          onChange={setQ}
          placeholder={optional('auto.tpl.search') ?? t('menu.search')}
          testId="auto-template-search"
        />
        <div className="flex flex-wrap gap-1.5" role="group" data-testid="auto-template-categories">
          {(['all', ...TEMPLATE_CATEGORIES] as const).map((c) => (
            <button
              key={c}
              type="button"
              aria-pressed={category === c}
              data-testid={`auto-template-cat-${c}`}
              onClick={() => setCategory(c)}
              className={cn(
                'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold',
                category === c
                  ? 'border-transparent bg-heading text-[var(--surface)]'
                  : 'border-line bg-surface text-fg-2 hover:bg-surface-3',
              )}
            >
              {c === 'all' ? null : <Icon name={CATEGORY_ICON[c]} size={13} />}
              {c === 'all'
                ? (optional('auto.tpl.all') ?? t('notifications.filter.all'))
                : t(`auto.category.${c}` as MessageKey)}
            </button>
          ))}
        </div>
      </div>

      {!visible.length ? (
        <EmptyState
          icon={<Icon name="search" size={26} />}
          title={optional('auto.tpl.none') ?? t('board.noResults')}
          testId="auto-templates-empty"
        />
      ) : null}

      {TEMPLATE_CATEGORIES.map((cat) => {
        const list = visible.filter((s) => s.tpl.category === cat);
        if (!list.length) return null;
        return (
          <section key={cat} className="flex flex-col gap-2" data-testid="auto-template-section" data-category={cat}>
            <h3 className="flex items-center gap-2 text-xs font-semibold text-fg-2">
              <Icon name={CATEGORY_ICON[cat]} size={14} className="text-muted" />
              {t(`auto.category.${cat}` as MessageKey)}
              <span className="text-muted">· {list.length}</span>
            </h3>
            <div className="grid gap-2 sm:grid-cols-2">
              {list.map(({ tpl, trigger, actions, desc }) => (
                <button
                  key={tpl.id}
                  type="button"
                  data-testid="automation-template"
                  data-id={tpl.id}
                  onClick={() => onPick(tpl)}
                  className="group flex items-start gap-3 rounded-[12px] border border-line bg-surface p-3 text-start transition-colors hover:border-heading hover:bg-surface-3"
                >
                  <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-[9px] bg-surface-2 text-heading">
                    <Icon name={CATEGORY_ICON[cat]} size={16} />
                  </span>
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="text-[0.875rem] leading-6 text-fg" data-testid="automation-template-sentence">
                      <Parts parts={trigger} />
                      {', '}
                      <b className="font-bold text-heading">{then}</b>{' '}
                      {actions.map((parts, j) => (
                        <span key={j}>
                          {j ? and : null}
                          <Parts parts={parts} />
                        </span>
                      ))}
                    </span>
                    {desc ? (
                      <span className="text-xs text-muted" data-testid="automation-template-desc">
                        {desc}
                      </span>
                    ) : null}
                  </span>
                </button>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
};
