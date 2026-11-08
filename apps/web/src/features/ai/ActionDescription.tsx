// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type ReactNode } from 'react';
import {
  type ActionDescription,
  type DescValue,
  formatDate,
  formatDateTime,
  formatNumber,
  t,
  tDynamic,
} from '@bines/shared';
import { cn } from '@bines/ui';
import { Icon } from '../../lib/icons';

/**
 * "What the AI wants to do" in words (sync-ai, product decision): an agent's approval request, an agent's run step and
 * the assistant's proposed change all show a sentence with real names, the changed fields as "label: value" lines,
 * and the raw JSON only behind "technical details". The server resolves the names for the reader
 * (`describeToolCall`); this turns them into the reader's language:
 *   `ai.describe.<tool>.<variant>` → `ai.describe.<tool>` → `ai.describe.generic` ("{tool}: {target}"),
 * detail labels `ai.field.<field>`, list values `ai.enum.<value>`, dates in the reader's region.
 * Keys come from SCRATCH/i18n/ai.json (merged into he/en by the lead).
 */
const has = (key: string) => tDynamic(key) !== key;

/** The params as shown: a name the reader may not see (or that is gone) reads "unknown". */
const shownParams = (d: ActionDescription) =>
  Object.fromEntries(
    Object.entries(d.params).map(([k, v]) => [k, v === null || v === '' ? t('ai.describe.unknown') : v]),
  );

/** Whether a template got every value it asks for (a param an input lacks leaves "{name}" in place). */
const complete = (s: string) => !/\{\w+\}/.test(s);

export const describeSentence = (d: ActionDescription, toolLabel: string) => {
  const params = shownParams(d);
  const keys = [d.variant ? `ai.describe.${d.tool}.${d.variant}` : null, `ai.describe.${d.tool}`].filter(
    (k): k is string => !!k && has(k),
  );
  for (const key of keys) {
    const s = tDynamic(key, params);
    if (complete(s)) return s;
  }
  // No sentence for this tool (a remote MCP tool, a new tool): its label and the first thing it is about.
  const target = [
    'item',
    'name',
    'title',
    'board',
    'group',
    'column',
    'automation',
    'update',
    'workspace',
    'widget',
    'dashboard',
    'template',
  ]
    .map((k) => d.params[k])
    .find((v) => v);
  return target ? t('ai.describe.generic', { tool: toolLabel, target }) : toolLabel;
};

const fieldLabel = (field: string, label: string | null) => {
  if (label) return label;
  const key = `ai.field.${field}`;
  return has(key) ? tDynamic(key) : field.replace(/_/g, ' ');
};

export const describeValue = (v: DescValue): string => {
  switch (v.kind) {
    case 'text':
      return v.text;
    case 'number':
      return formatNumber(v.value);
    case 'bool':
      return t(v.value ? 'ai.value.yes' : 'ai.value.no');
    case 'enum': {
      const key = `ai.enum.${v.value}`;
      return has(key) ? tDynamic(key) : v.value;
    }
    case 'date':
      return formatDate(v.value);
    case 'datetime':
      return formatDateTime(v.value);
    case 'clear':
      return t('ai.value.clear');
  }
};

const json = (v: unknown) => {
  const s = JSON.stringify(v ?? {}, null, 2);
  return s.length > 4000 ? `${s.slice(0, 4000)}…` : s;
};

/**
 * The sentence + details + the technical toggle. Without a description (an older record) the tool's label stands and
 * the JSON is still only behind the toggle. `output` (a run step's result) joins the technical details.
 */
export const ActionDescriptionView = ({
  description,
  toolLabel,
  input,
  output,
  outputError,
  className,
  sentenceClassName,
}: {
  description: ActionDescription | null | undefined;
  toolLabel: string;
  input: unknown;
  output?: unknown;
  outputError?: boolean;
  className?: string;
  sentenceClassName?: string;
}) => {
  const [open, setOpen] = useState(false);
  const details = description?.details ?? [];
  return (
    <div className={cn('min-w-0 space-y-1', className)} data-testid="action-description">
      <p dir="auto" className={cn('text-sm break-words text-fg', sentenceClassName)} data-testid="action-sentence">
        {description ? describeSentence(description, toolLabel) : toolLabel}
      </p>
      {details.length ? (
        <ul className="space-y-0.5 text-xs text-fg-2" data-testid="action-details">
          {details.map((x, i) => (
            <li
              key={`${x.field}-${i}`}
              className="flex min-w-0 gap-1.5"
              data-testid="action-detail"
              data-field={x.field}
            >
              <span className="shrink-0 text-muted">{fieldLabel(x.field, x.label)}:</span>
              <bdi className="min-w-0 break-words" dir="auto">
                {describeValue(x.value)}
              </bdi>
            </li>
          ))}
        </ul>
      ) : null}
      <TechnicalDetails open={open} onToggle={() => setOpen((v) => !v)}>
        <pre
          dir="ltr"
          className="max-h-60 overflow-auto rounded-[8px] bg-surface-2 p-2 text-start text-[0.7188rem] text-fg-2"
          data-testid="action-tech-input"
        >
          {json(input)}
        </pre>
        {output !== undefined ? (
          <pre
            dir="ltr"
            className={cn(
              'max-h-60 overflow-auto rounded-[8px] p-2 text-start text-[0.7188rem]',
              outputError ? 'bg-danger-soft text-danger-fg' : 'bg-surface-2 text-fg-2',
            )}
            data-testid="action-tech-output"
          >
            {json(output)}
          </pre>
        ) : null}
      </TechnicalDetails>
    </div>
  );
};

const TechnicalDetails = ({
  open,
  onToggle,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) => (
  <div>
    <button
      type="button"
      className="inline-flex items-center gap-1 rounded-[6px] text-[0.6875rem] font-medium text-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-[var(--primary)]"
      aria-expanded={open}
      onClick={onToggle}
      data-testid="action-tech-toggle"
    >
      <Icon name="chevronDown" size={12} className={cn('shrink-0 transition-transform', open ? 'rotate-180' : '')} />
      {t('ai.describe.technical')}
    </button>
    {open ? (
      <div className="mt-1.5 grid gap-2" data-testid="action-tech">
        {children}
      </div>
    ) : null}
  </div>
);
