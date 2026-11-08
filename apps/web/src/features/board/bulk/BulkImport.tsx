// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo } from 'react';
import {
  applyImport,
  autoMap,
  BULK_EDIT_MAX_ROWS,
  type Draft,
  IMPORT_NEW_TYPES,
  type ImportTable,
  type ImportTarget,
  importTargets,
  matchKeyColumns,
  newColumnSettings,
  newColumnTarget,
  NEW_COLUMN_PREFIX,
  type SheetColumn,
  sheetColumns,
  type SheetRow,
  t,
  tableData,
  tableHeaders,
} from '@bines/shared';
import { Input, Notice, Picker } from '@bines/ui';
import { CheckRow } from '../toolbar/parts';

const PREVIEW_ROWS = 5;
const IGNORE = 'ignore';
const NEW = 'new';
const typeLabel = (type: string) => t(`columnType.${type}` as never);

type Mapping = { sheet: number; header: boolean; targets: ImportTarget[]; matchBy: string | null };

/**
 * B3 — a file into the bulk-edit sheet: choose the sheet (xlsx with several), say whether the first row is the
 * header, map every file column (auto-matched by name and by the values; or a new column of a chosen type, or not
 * imported), optionally match existing items by a key column (those rows update them; the rest become new rows),
 * see the first rows as they will land — then "apply" fills the sheet's draft, which the usual "finish" reviews.
 */
export const BulkImportPanel = ({
  tables,
  fileName,
  columns,
  base,
  plan,
  mapping,
  onMapping,
}: {
  tables: ImportTable[];
  fileName: string;
  /** The sheet's columns now (new columns of earlier imports included). */
  columns: SheetColumn[];
  base: SheetRow[];
  /** `planImport` of the mapping (the dialog applies it). */
  plan: ReturnType<typeof planImport>;
  mapping: Mapping;
  onMapping: (m: Mapping) => void;
}) => {
  const table = tables[mapping.sheet] ?? tables[0]!;
  const headers = useMemo(() => tableHeaders(table.rows, mapping.header), [table, mapping.header]);
  const data = useMemo(() => tableData(table.rows, mapping.header), [table, mapping.header]);
  const targets = importTargets(columns);
  const keys = matchKeyColumns(columns);
  const usedBy = (id: string) => mapping.targets.findIndex((x) => x.kind === 'column' && x.columnId === id);

  const setTarget = (i: number, value: string) => {
    const next = [...mapping.targets];
    if (value === IGNORE) next[i] = { kind: 'ignore' };
    else if (value === NEW)
      next[i] = newColumnTarget(
        headers[i]!,
        data.map((r) => r[i] ?? ''),
      );
    else {
      const id = value.slice(4);
      // A board column takes one file column: the one that had it lets it go.
      const before = usedBy(id);
      if (before >= 0 && before !== i) next[before] = { kind: 'ignore' };
      next[i] = { kind: 'column', columnId: id };
    }
    onMapping({ ...mapping, targets: next });
  };
  const setNew = (i: number, patch: Partial<{ type: string; title: string }>) => {
    const cur = mapping.targets[i];
    if (cur?.kind !== 'new') return;
    const next = [...mapping.targets];
    next[i] = { ...cur, ...patch };
    onMapping({ ...mapping, targets: next });
  };
  const reMap = (m: Pick<Mapping, 'sheet' | 'header'>) => {
    const tb = tables[m.sheet] ?? tables[0]!;
    const h = tableHeaders(tb.rows, m.header);
    const d = tableData(tb.rows, m.header);
    onMapping({
      ...m,
      targets: autoMap(h, d, columns),
      matchBy: defaultMatchBy(base, columns, autoMap(h, d, columns), d),
    });
  };

  const options = [
    { value: IGNORE, label: t('bulk.import.ignore') },
    { value: NEW, label: t('bulk.import.newColumn') },
    ...targets.map((c) => ({ value: `col:${c.id}`, label: c.title })),
    // Frozen key columns (an item id) take a file column only to match rows by it.
    ...keys
      .filter((c) => c.mode === 'frozen')
      .map((c) => ({ value: `col:${c.id}`, label: `${c.title} · ${t('bulk.import.keyOnly')}` })),
  ];
  const valueOf = (x: ImportTarget) => (x.kind === 'column' ? `col:${x.columnId}` : x.kind === 'new' ? NEW : IGNORE);
  const titleOf = (x: ImportTarget) =>
    x.kind === 'column' ? (columns.find((c) => c.id === x.columnId)?.title ?? '') : x.kind === 'new' ? x.title : '';
  const shown = mapping.targets.map((x, i) => [x, i] as const).filter(([x]) => x.kind !== 'ignore');
  // a file column that goes into a secret column is never shown — dots instead of its values.
  const secretAt = (i: number) => {
    const x = mapping.targets[i];
    return x?.kind === 'column' && columns.find((c) => c.id === x.columnId)?.mode === 'secret';
  };
  const DOTS = '••••••';
  const sample = (i: number) =>
    secretAt(i)
      ? DOTS
      : data
          .map((r) => r[i] ?? '')
          .filter((v) => v.trim())
          .slice(0, 3)
          .join(' · ');

  return (
    <div className="mx-auto w-full max-w-4xl space-y-5" data-testid="bulk-import" data-file={fileName}>
      <div className="flex flex-wrap items-end gap-4">
        {tables.length > 1 ? (
          <label className="block w-60 space-y-1.5">
            <span className="text-xs font-semibold text-fg-2">{t('bulk.import.sheet')}</span>
            <Picker
              value={String(mapping.sheet)}
              label={t('bulk.import.sheet')}
              testId="bulk-import-sheet"
              options={tables.map((x, i) => ({ value: String(i), label: x.name }))}
              onChange={(v) => reMap({ sheet: Number(v), header: mapping.header })}
            />
          </label>
        ) : null}
        <CheckRow
          checked={mapping.header}
          onToggle={() => reMap({ sheet: mapping.sheet, header: !mapping.header })}
          className="w-auto"
        >
          <span data-testid="bulk-import-header" data-on={mapping.header ? 'true' : 'false'}>
            {t('bulk.import.header')}
          </span>
        </CheckRow>
        <span className="ms-auto text-xs text-muted">
          {fileName} · {t('bulk.rows', { n: data.length })}
        </span>
      </div>

      <section className="space-y-2">
        <div>
          <h3 className="text-sm font-semibold text-heading">{t('bulk.import.mapping')}</h3>
          <p className="text-xs text-muted">{t('bulk.import.mappingHint')}</p>
        </div>
        <div className="divide-y divide-line-soft rounded-[var(--radius)] border border-line">
          {headers.map((h, i) => {
            const x = mapping.targets[i] ?? { kind: 'ignore' as const };
            return (
              <div
                key={i}
                data-testid="bulk-import-row"
                data-source={h}
                data-target={x.kind === 'column' ? x.columnId : x.kind}
                className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-3 px-3 py-2 md:grid-cols-[minmax(0,1fr)_14rem_minmax(0,1fr)]"
              >
                <div className="min-w-0">
                  <div className="truncate text-[0.8125rem] font-medium text-fg">{h}</div>
                  <div className="truncate text-xs text-muted">{sample(i) || '—'}</div>
                </div>
                <Picker
                  value={valueOf(x)}
                  label={t('bulk.import.target')}
                  testId="bulk-import-target"
                  searchable
                  options={options}
                  onChange={(v) => setTarget(i, v)}
                />
                {x.kind === 'new' ? (
                  <div className="col-span-2 flex gap-2 md:col-span-1">
                    <Picker
                      value={x.type}
                      label={t('bulk.import.newType')}
                      testId="bulk-import-new-type"
                      searchable
                      className="w-36 shrink-0"
                      options={IMPORT_NEW_TYPES.map((type) => ({ value: type, label: typeLabel(type) }))}
                      onChange={(type) => setNew(i, { type })}
                    />
                    <Input
                      value={x.title}
                      aria-label={t('bulk.import.newTitle')}
                      data-testid="bulk-import-new-title"
                      maxLength={255}
                      onChange={(e) => setNew(i, { title: e.target.value })}
                    />
                  </div>
                ) : (
                  <span className="hidden md:block" />
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section className="space-y-2">
        <label className="block max-w-sm space-y-1.5">
          <span className="text-xs font-semibold text-fg-2">{t('bulk.import.matchBy')}</span>
          <Picker
            value={mapping.matchBy ?? ''}
            label={t('bulk.import.matchBy')}
            testId="bulk-import-match"
            options={[
              { value: '', label: t('bulk.import.matchNone') },
              ...keys.map((c) => ({ value: c.id, label: c.title })),
            ]}
            onChange={(v) => onMapping({ ...mapping, matchBy: v || null })}
          />
        </label>
        <p className="text-xs text-muted">{t('bulk.import.matchHint')}</p>
        {mapping.matchBy && usedBy(mapping.matchBy) < 0 ? (
          <Notice tone="warn">
            {t('bulk.import.matchNeedsColumn', {
              column: keys.find((c) => c.id === mapping.matchBy)?.title ?? '',
            })}
          </Notice>
        ) : null}
      </section>

      <section className="space-y-2">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-sm font-semibold text-heading">{t('bulk.import.preview')}</h3>
          <span className="text-xs text-muted">
            {t('bulk.import.previewHint', { n: Math.min(PREVIEW_ROWS, data.length), total: data.length })}
          </span>
        </div>
        <div className="overflow-x-auto rounded-[var(--radius)] border border-line">
          <table className="w-full text-[0.8125rem]" data-testid="bulk-import-preview">
            <thead className="bg-surface-2">
              <tr>
                {shown.map(([x, i]) => (
                  <th
                    key={i}
                    className="border-e border-line px-2 py-1.5 text-start text-xs font-semibold text-heading"
                  >
                    <span className="block truncate">{titleOf(x)}</span>
                    {x.kind === 'new' ? (
                      <span className="text-[0.6875rem] font-normal text-info-fg">
                        {t('bulk.import.newBadge')} · {typeLabel(x.type)}
                      </span>
                    ) : null}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.slice(0, PREVIEW_ROWS).map((r, ri) => (
                <tr key={ri} className="border-t border-line-soft">
                  {shown.map(([, i]) => (
                    <td key={i} className="max-w-48 truncate border-e border-line-soft px-2 py-1.5">
                      {secretAt(i) && r[i] ? DOTS : (r[i] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {!shown.length ? (
        <Notice tone="warn">{t('bulk.import.nothingMapped')}</Notice>
      ) : plan.result.tooMany ? (
        <Notice tone="error">
          <span data-testid="bulk-import-too-many">
            {t('bulk.import.tooMany', { rows: plan.result.rows, max: BULK_EDIT_MAX_ROWS })}
          </span>
        </Notice>
      ) : (
        <p
          className="text-[0.8125rem] text-fg-2"
          data-testid="bulk-import-summary"
          data-updated={plan.result.updated}
          data-created={plan.result.created}
        >
          {t('bulk.import.summary', { updated: plan.result.updated, created: plan.result.created })}
          {plan.result.skipped ? ` · ${t('bulk.import.skipped', { n: plan.result.skipped })}` : ''}
        </p>
      )}
    </div>
  );
};

/** The first mapping of a table: auto-matched; matching by name when the file's names hit existing rows. */
export const initialMapping = (tables: ImportTable[], columns: SheetColumn[], base: SheetRow[]): Mapping => {
  const rows = tables[0]!.rows;
  const header = true;
  const h = tableHeaders(rows, header);
  const d = tableData(rows, header);
  const targets = autoMap(h, d, columns);
  return { sheet: 0, header, targets, matchBy: defaultMatchBy(base, columns, targets, d) };
};

const defaultMatchBy = (base: SheetRow[], columns: SheetColumn[], targets: ImportTarget[], data: string[][]) => {
  const name = columns.find((c) => c.mode === 'name');
  const i = targets.findIndex((x) => x.kind === 'column' && x.columnId === name?.id);
  if (!name || i < 0 || !base.length) return null;
  const have = new Set(base.map((r) => (r.texts[name.id] ?? '').trim().toLocaleLowerCase()));
  return data.some((r) => have.has((r[i] ?? '').trim().toLocaleLowerCase())) ? name.id : null;
};

/**
 * The mapping as the draft it makes: new-column targets become sheet columns (`__new_<n>`, settings of their type
 * with empty labels), every file column a sheet column id or null.
 */
export const planImport = (
  base: SheetRow[],
  draft: Draft,
  columns: SheetColumn[],
  data: string[][],
  mapping: Mapping,
  nextNewId: number,
) => {
  let n = nextNewId;
  const added: SheetColumn[] = [];
  const columnFor = mapping.targets.map((x) => {
    if (x.kind === 'column') return x.columnId;
    if (x.kind !== 'new') return null;
    const id = `${NEW_COLUMN_PREFIX}${n++}`;
    added.push(
      ...sheetColumns([{ id, type: x.type, title: x.title.trim() || x.type, settings: newColumnSettings(x.type) }]),
    );
    return id;
  });
  // New columns go before the group column (always last).
  const all = [...columns.slice(0, -1), ...added, ...columns.slice(-1)];
  const result = applyImport(base, draft, all, data, columnFor, mapping.matchBy);
  return { result, columns: added, all };
};

export type { Mapping as ImportMapping };
