// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import {
  type BulkDecisions,
  type BulkReview as Review,
  labelDecisionKey,
  type SheetColumn,
  STATUS_COLORS,
  type ColorKey,
  t,
} from '@bines/shared';
import { cn, Notice, Picker } from '@bines/ui';
import { ColorGrid, LabelTag, tagVars } from '../../../lib/label-color';
import { Popover } from '../cells/Popover';
import { CheckRow } from '../toolbar/parts';

export type InviteRole = 'skip' | 'member' | 'viewer' | 'guest';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const canInvite = (name: string) => EMAIL_RE.test(name.trim());

/**
 * "Finish" (B2): what the draft would write, before anything is written. New values per status / dropdown column
 * and new tags ("add as a new label?", with a colour; default yes), values that do not read as their type (with
 * a link back to the cell — they are left out unless fixed), and people not found (skipped by default; an email
 * can be invited with a role — 12-ROADMAP decision 4).
 */
export const BulkReviewPanel = ({
  review,
  columns,
  decisions,
  onDecisions,
  invites,
  onInvites,
  onFix,
  skipped,
  sheets,
  replaceSecrets,
  onReplaceSecrets,
}: {
  review: Review;
  columns: SheetColumn[];
  decisions: BulkDecisions;
  onDecisions: (d: BulkDecisions) => void;
  invites: Record<string, InviteRole>;
  onInvites: (v: Record<string, InviteRole>) => void;
  onFix: (row: number, columnId: string, sheet?: 'sub') => void;
  skipped: number;
  /** The board has a subitems sheet (B4): invalid rows say which sheet they are on. */
  sheets?: boolean;
  /** write over secret cells that already have a value (off: they are left alone). */
  replaceSecrets: boolean;
  onReplaceSecrets: (on: boolean) => void;
}) => {
  const title = (id: string) => columns.find((c) => c.id === id)?.title ?? id;
  const type = (id: string) => columns.find((c) => c.id === id)?.type;
  const nothing = !review.cells;
  return (
    <div className="mx-auto w-full max-w-3xl space-y-5" data-testid="bulk-review">
      <div
        className="flex flex-wrap gap-2 text-[0.8125rem] text-fg-2"
        data-testid="bulk-review-counts"
        data-updated={review.updated}
        data-created={review.created}
        data-cells={review.cells}
      >
        {nothing ? (
          t('bulk.review.nothing')
        ) : (
          <>
            <Count n={review.updated} label={t('bulk.review.updated')} />
            <Count n={review.created} label={t('bulk.review.created')} />
            <Count n={review.cells} label={t('bulk.review.cells')} />
          </>
        )}
      </div>

      {review.secrets.set + review.secrets.replace ? (
        <Section title={t('bulk.secret.title')} hint={t('bulk.secret.hint')}>
          <div
            className="space-y-2"
            data-testid="bulk-review-secrets"
            data-set={review.secrets.set}
            data-replace={review.secrets.replace}
          >
            <p className="text-[0.8125rem] text-fg-2">
              {t('bulk.secret.counts', { set: review.secrets.set, replace: review.secrets.replace })}
            </p>
            {review.secrets.replace ? (
              <>
                <CheckRow
                  checked={replaceSecrets}
                  onToggle={() => onReplaceSecrets(!replaceSecrets)}
                  className="w-auto"
                  testId="bulk-secret-replace"
                >
                  {t('bulk.secret.replace', { n: review.secrets.replace })}
                </CheckRow>
                {replaceSecrets ? (
                  <Notice tone="warn">
                    <span data-testid="bulk-secret-replace-warning">{t('bulk.secret.replaceWarning')}</span>
                  </Notice>
                ) : null}
              </>
            ) : null}
          </div>
        </Section>
      ) : null}

      {review.labels.length ? (
        <Section title={t('bulk.review.labels')} hint={t('bulk.review.labelsHint')}>
          {review.labels.map((v) => {
            const key = labelDecisionKey(v.columnId, v.name);
            const d = decisions.labels[key] ?? { add: false };
            const status = type(v.columnId) === 'status';
            return (
              <div
                key={key}
                data-testid="bulk-new-label"
                data-label={v.name}
                data-column={v.columnId}
                data-add={d.add ? 'true' : 'false'}
                className="flex items-center gap-2"
              >
                <CheckRow
                  checked={d.add}
                  onToggle={() =>
                    onDecisions({ ...decisions, labels: { ...decisions.labels, [key]: { ...d, add: !d.add } } })
                  }
                  className="w-auto"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    {status ? (
                      <LabelTag color={d.color ?? STATUS_COLORS[0]}>{v.name}</LabelTag>
                    ) : (
                      <span className="truncate font-medium">{v.name}</span>
                    )}
                    <span className="truncate text-xs text-muted">
                      {title(v.columnId)} · {t('bulk.review.uses', { n: v.count })}
                    </span>
                  </span>
                </CheckRow>
                {status && d.add ? (
                  <ColorPick
                    value={d.color ?? STATUS_COLORS[0]!}
                    onChange={(color) =>
                      onDecisions({ ...decisions, labels: { ...decisions.labels, [key]: { ...d, color } } })
                    }
                  />
                ) : null}
              </div>
            );
          })}
        </Section>
      ) : null}

      {review.tags.length ? (
        <Section title={t('bulk.review.tags')} hint={t('bulk.review.tagsHint')}>
          {review.tags.map((v) => {
            const key = v.name.trim().toLocaleLowerCase();
            const d = decisions.tags[key] ?? { add: false };
            return (
              <div
                key={key}
                data-testid="bulk-new-tag"
                data-label={v.name}
                data-add={d.add ? 'true' : 'false'}
                className="flex items-center gap-2"
              >
                <CheckRow
                  checked={d.add}
                  onToggle={() =>
                    onDecisions({ ...decisions, tags: { ...decisions.tags, [key]: { ...d, add: !d.add } } })
                  }
                  className="w-auto"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <LabelTag color={d.color ?? 'forest'}>#{v.name}</LabelTag>
                    <span className="truncate text-xs text-muted">{t('bulk.review.uses', { n: v.count })}</span>
                  </span>
                </CheckRow>
                {d.add ? (
                  <ColorPick
                    value={d.color ?? 'forest'}
                    onChange={(color) =>
                      onDecisions({ ...decisions, tags: { ...decisions.tags, [key]: { ...d, color } } })
                    }
                  />
                ) : null}
              </div>
            );
          })}
        </Section>
      ) : null}

      {review.invalid.length ? (
        <Section title={t('bulk.review.invalid')} hint={t('bulk.review.invalidHint')} tone="error">
          <ul className="divide-y divide-line-soft rounded-[var(--radius)] border border-line">
            {review.invalid.slice(0, 200).map((x) => (
              <li key={`${x.sheet ?? 'main'}:${x.row}:${x.columnId}`}>
                <button
                  type="button"
                  data-testid="bulk-invalid"
                  data-row={x.row}
                  data-column={x.columnId}
                  data-sheet={x.sheet ?? 'main'}
                  data-reason={x.reason}
                  onClick={() => onFix(x.row, x.columnId, x.sheet)}
                  className="flex w-full items-center gap-3 px-3 py-2 text-start text-[0.8125rem] hover:bg-surface-2"
                >
                  <span className="w-28 shrink-0 text-xs text-muted tabular-nums">
                    {sheets ? (
                      <span className="block truncate">
                        {x.sheet === 'sub' ? t('bulk.tab.subitems') : t('bulk.tab.items')}
                      </span>
                    ) : null}
                    {t('bulk.review.row', { n: x.row + 1 })}
                  </span>
                  <span className="w-40 shrink-0 truncate text-fg-2">{title(x.columnId)}</span>
                  <span className="min-w-0 flex-1 truncate font-medium text-danger-fg">
                    {x.reason ? (
                      <>
                        {x.text ? <span className="me-1.5">{x.text}</span> : null}
                        <span className="text-xs font-normal">{t(`bulk.review.reason.${x.reason}`)}</span>
                      </>
                    ) : (
                      x.text
                    )}
                  </span>
                  <span className="shrink-0 text-xs font-semibold text-heading underline">{t('bulk.review.fix')}</span>
                </button>
              </li>
            ))}
          </ul>
          {review.invalid.length > 200 ? (
            <p className="text-xs text-muted">{t('bulk.review.more', { n: review.invalid.length - 200 })}</p>
          ) : null}
        </Section>
      ) : null}

      {review.people.length ? (
        <Section title={t('bulk.review.people')} hint={t('bulk.review.peopleHint')}>
          {review.people.map((p) => {
            const role = invites[p.name] ?? 'skip';
            return (
              <div
                key={p.name}
                data-testid="bulk-missing-person"
                data-name={p.name}
                className="flex items-center gap-3 text-[0.8125rem]"
              >
                <span className="min-w-0 flex-1 truncate font-medium">{p.name}</span>
                <span className="shrink-0 text-xs text-muted">{t('bulk.review.uses', { n: p.count })}</span>
                {canInvite(p.name) ? (
                  <Picker<InviteRole>
                    value={role}
                    label={t('bulk.review.inviteAs')}
                    testId="bulk-invite-role"
                    className="w-44"
                    options={[
                      { value: 'skip', label: t('bulk.review.skip') },
                      { value: 'member', label: `${t('bulk.review.invite')} ${t('role.member')}` },
                      { value: 'viewer', label: `${t('bulk.review.invite')} ${t('role.viewer')}` },
                      { value: 'guest', label: `${t('bulk.review.invite')} ${t('role.guest')}` },
                    ]}
                    onChange={(v) => onInvites({ ...invites, [p.name]: v })}
                  />
                ) : (
                  <span className="w-44 shrink-0 text-xs text-muted">{t('bulk.review.skip')}</span>
                )}
              </div>
            );
          })}
        </Section>
      ) : null}

      {skipped ? (
        <Notice tone="warn">
          <span data-testid="bulk-review-skipped" data-n={skipped}>
            {t('bulk.review.skipped', { n: skipped })}
          </span>
        </Notice>
      ) : null}
    </div>
  );
};

const Count = ({ n, label }: { n: number; label: string }) => (
  <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2.5 py-1">
    <b className="font-display text-sm text-heading tabular-nums">{n}</b>
    {label}
  </span>
);

const Section = ({
  title,
  hint,
  tone,
  children,
}: {
  title: string;
  hint: string;
  tone?: 'error';
  children: React.ReactNode;
}) => (
  <section className="space-y-2">
    <div>
      <h3
        className={cn('font-display text-[0.9375rem] font-bold', tone === 'error' ? 'text-danger-fg' : 'text-heading')}
      >
        {title}
      </h3>
      <p className="text-xs text-muted">{hint}</p>
    </div>
    <div className="space-y-1.5">{children}</div>
  </section>
);

/**
 * A colour swatch that opens the palette (system popover, never a native colour input) — all forty colours (pal40),
 * the app's colour picker; values are palette keys.
 */
const ColorPick = ({ value, onChange }: { value: string; onChange: (key: ColorKey) => void }) => {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative">
      {/* The label's real look (its tint, a dot in its ink), like the label editor. */}
      <button
        type="button"
        data-testid="bulk-color"
        aria-label={t('bulk.review.color')}
        title={t('bulk.review.color')}
        onClick={() => setOpen((o) => !o)}
        className="label-tag size-6 rounded-[var(--radius-sm)] p-0 ring-1 ring-line-strong ring-offset-2 ring-offset-[var(--surface)] hover:ring-[var(--tag-ink)]"
        style={tagVars(value)}
      >
        <span className="size-2 rounded-full" style={{ backgroundColor: 'var(--tag-ink)' }} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} align="end" className="w-56 p-2">
        {/* r17ui: a pick keeps the palette open; outside click / Esc close it. */}
        <ColorGrid
          kind="radio"
          look="label"
          label={t('bulk.review.color')}
          selected={(c) => c === value}
          onPick={onChange}
        />
      </Popover>
    </span>
  );
};
