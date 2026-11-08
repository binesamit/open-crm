// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { newId, type IdocLineMapping, type IdocRowSource, type IdocSection, type IdocSectionOf } from '@bines/shared';
import { Button, Input, Notice, Picker, Segmented } from '@bines/ui';
import { api, errorMessage } from '../../../lib/api';
import { showToast } from '../../../lib/toast';
import { boardKeys, type BoardDetail, type Column } from '../../board/board-api';
import type { KeysUnder } from '../idocs-api';
import {
  B,
  BoundValue,
  COLS,
  ColumnPick,
  ListEditor,
  LongText,
  NumberField,
  Row,
  Text,
  Toggle,
  UploadButton,
} from './fields';

/**
 * The selected section's settings in the builder: one form per section kind, every value a setting (canvas part 2,
 * right pane). Column pickers list only the types a setting accepts; "create the columns" makes what a row section
 * or a signature needs on the board and maps it, so a new board is ready in one click.
 */
type Props = {
  accountId: string;
  section: IdocSection;
  board: BoardDetail | undefined;
  subBoard: BoardDetail | undefined;
  sections: IdocSection[];
  onChange: (next: IdocSection) => void;
};

const tokensOf = (board: BoardDetail | undefined) => [
  { label: B('tok.item'), token: '{item.name}' },
  { label: B('tok.date'), token: '{doc.date}' },
  { label: B('tok.expires'), token: '{doc.expires}' },
  { label: B('tok.account'), token: '{account.name}' },
  { label: B('tok.grand'), token: '{total.grand}' },
  { label: B('tok.recurring'), token: '{total.recurring}' },
  ...(board?.columns ?? []).filter((c) => c.type !== 'name').map((c) => ({ label: c.title, token: `{col:${c.id}}` })),
];

export const SectionForm = ({ accountId, section, board, subBoard, sections, onChange }: Props) => {
  const s = section;
  const set = <K extends IdocSection['kind']>(patch: Partial<IdocSectionOf<K>>) =>
    onChange({ ...s, ...patch } as IdocSection);
  const tokens = tokensOf(board);
  const cols = board?.columns ?? [];
  const title =
    'title' in s ? (
      <Row label={B('title')}>
        <Text value={s.title} onChange={(v) => set({ title: v } as never)} testId="idoc-f-title" />
      </Row>
    ) : null;
  const common = (
    <div className="grid gap-2 border-t border-line pt-3">
      <Toggle label={B('askOn')} checked={s.ask} onChange={(v) => set({ ask: v })} />
      <Toggle label={B('hidden')} checked={s.hidden} onChange={(v) => set({ hidden: v })} />
    </div>
  );
  const body = (() => {
    switch (s.kind) {
      case 'header':
        return (
          <>
            <Row label={B('title')}>
              <Text value={s.title} onChange={(v) => set<'header'>({ title: v })} />
            </Row>
            <Row label={B('subtitle')}>
              <Text value={s.subtitle} onChange={(v) => set<'header'>({ subtitle: v })} />
            </Row>
            <Toggle label={B('showLogo')} checked={s.show_logo} onChange={(v) => set<'header'>({ show_logo: v })} />
            <Row label={B('cover')}>
              <div className="flex items-center gap-2">
                <UploadButton
                  accountId={accountId}
                  accept="image/*"
                  label={s.cover_asset_id ? B('replace') : B('upload')}
                  onDone={([id]) => set<'header'>({ cover_asset_id: id ?? null })}
                />
                {s.cover_asset_id ? (
                  <Button size="sm" variant="ghost" onClick={() => set<'header'>({ cover_asset_id: null })}>
                    {B('remove')}
                  </Button>
                ) : null}
              </div>
            </Row>
            <FieldsEditor fields={s.fields} tokens={tokens} onChange={(fields) => set<'header'>({ fields })} />
          </>
        );
      case 'text':
        return (
          <>
            {title}
            <Row label={B('body')} hint={B('markdownHint')}>
              <LongText
                value={s.body}
                onChange={(v) => set<'text'>({ body: v })}
                rows={8}
                tokens={tokens}
                testId="idoc-f-body"
              />
            </Row>
            <Toggle
              label={B('twoColumns')}
              checked={s.body2 !== '' || false}
              onChange={(v) => set<'text'>({ body2: v ? ' ' : '' })}
            />
            {s.body2 !== '' ? (
              <Row label={B('body2')}>
                <LongText value={s.body2} onChange={(v) => set<'text'>({ body2: v || ' ' })} rows={6} tokens={tokens} />
              </Row>
            ) : null}
            <Row label={B('style')}>
              <Segmented
                label={B('style')}
                value={s.style}
                onChange={(v) => set<'text'>({ style: v })}
                options={(['plain', 'callout', 'quote', 'muted'] as const).map((v) => ({
                  value: v,
                  label: B(`styles.${v}`),
                }))}
              />
            </Row>
            <Toggle label={B('numbered')} checked={s.numbered} onChange={(v) => set<'text'>({ numbered: v })} />
            <Toggle
              label={B('collapsible')}
              checked={s.collapsible}
              onChange={(v) => set<'text'>({ collapsible: v })}
            />
            {s.collapsible ? (
              <Toggle label={B('collapsed')} checked={s.collapsed} onChange={(v) => set<'text'>({ collapsed: v })} />
            ) : null}
          </>
        );
      case 'fields':
        return (
          <>
            {title}
            <FieldsEditor fields={s.fields} tokens={tokens} onChange={(fields) => set<'fields'>({ fields })} />
            <Row label={B('layout')}>
              <Segmented
                label={B('layout')}
                value={s.layout}
                onChange={(v) => set<'fields'>({ layout: v })}
                options={[
                  { value: 'grid', label: B('grid') },
                  { value: 'list', label: B('list') },
                ]}
              />
            </Row>
          </>
        );
      case 'people':
        return (
          <>
            {title}
            <Row label={B('peopleColumn')}>
              <ColumnPick
                columns={cols}
                types={COLS.people}
                value={s.column_key}
                onChange={(v) => set<'people'>({ column_key: v })}
                label={B('peopleColumn')}
              />
            </Row>
            <Toggle label={B('showEmail')} checked={s.show_email} onChange={(v) => set<'people'>({ show_email: v })} />
            <Toggle label={B('showPhone')} checked={s.show_phone} onChange={(v) => set<'people'>({ show_phone: v })} />
            <Row label={B('note')}>
              <Text value={s.note} onChange={(v) => set<'people'>({ note: v })} />
            </Row>
          </>
        );
      case 'lines':
        return (
          <LinesForm
            accountId={accountId}
            s={s}
            board={board}
            subBoard={subBoard}
            sections={sections}
            onChange={onChange}
            tokens={tokens}
          />
        );
      case 'table':
        return (
          <>
            {title}
            <Row label={B('intro')}>
              <LongText value={s.intro} onChange={(v) => set<'table'>({ intro: v })} rows={2} />
            </Row>
            <Row label={B('tableColumns')} hint={B('tableColumnsHint')}>
              <Text
                value={s.columns.join(' | ')}
                onChange={(v) =>
                  set<'table'>({
                    columns: v
                      .split('|')
                      .map((x) => x.trim())
                      .slice(0, 12),
                  })
                }
              />
            </Row>
            <Row label={B('tableRows')} hint={B('tableRowsHint')}>
              <LongText
                value={s.rows.map((r) => r.join(' | ')).join('\n')}
                rows={6}
                onChange={(v) =>
                  set<'table'>({
                    rows: v
                      .split('\n')
                      .filter((l) => l.trim())
                      .map((l) =>
                        l
                          .split('|')
                          .map((x) => x.trim())
                          .slice(0, 12),
                      )
                      .slice(0, 200),
                  })
                }
              />
            </Row>
            <Toggle
              label={B('headerColumn')}
              checked={s.header_column}
              onChange={(v) => set<'table'>({ header_column: v })}
            />
          </>
        );
      case 'summary':
        return (
          <>
            {title}
            <Row label={B('discount')}>
              <div className="grid grid-cols-[auto_1fr] gap-2">
                <Segmented
                  label={B('discount')}
                  value={s.discount?.kind ?? 'none'}
                  onChange={(v) =>
                    set<'summary'>({
                      discount:
                        v === 'none'
                          ? null
                          : { kind: v, value: s.discount?.value ?? 0, label: s.discount?.label ?? '' },
                    })
                  }
                  options={[
                    { value: 'none' as const, label: B('none') },
                    { value: 'percent' as const, label: '%' },
                    { value: 'amount' as const, label: B('amount') },
                  ]}
                />
                {s.discount ? (
                  <NumberField
                    value={s.discount.value}
                    onChange={(v) => set<'summary'>({ discount: { ...s.discount!, value: v ?? 0 } })}
                  />
                ) : null}
              </div>
            </Row>
            {s.discount ? (
              <Row label={B('discountLabel')}>
                <Text
                  value={s.discount.label}
                  onChange={(v) => set<'summary'>({ discount: { ...s.discount!, label: v } })}
                />
              </Row>
            ) : null}
            <Toggle
              label={B('showTotals')}
              checked={s.show_totals}
              onChange={(v) => set<'summary'>({ show_totals: v })}
            />
            <Toggle label={B('showVat')} checked={s.show_vat} onChange={(v) => set<'summary'>({ show_vat: v })} />
            <Toggle
              label={B('showRecurring')}
              checked={s.show_recurring}
              onChange={(v) => set<'summary'>({ show_recurring: v })}
            />
            <Toggle
              label={B('showThirdParty')}
              checked={s.show_third_party}
              onChange={(v) => set<'summary'>({ show_third_party: v })}
            />
            <Toggle label={B('sticky')} checked={s.sticky} onChange={(v) => set<'summary'>({ sticky: v })} />
            <Row label={B('schedule')} hint={B('scheduleHint')}>
              <ListEditor
                items={s.schedule}
                onChange={(schedule) => set<'summary'>({ schedule })}
                blank={() => ({ label: '', percent: 0 })}
                addLabel={B('addPayment')}
                max={12}
                render={(p, put) => (
                  <div className="grid grid-cols-[1fr_5rem] gap-1.5">
                    <Input
                      value={p.label}
                      onChange={(e) => put({ ...p, label: e.target.value })}
                      placeholder={B('paymentLabel')}
                      aria-label={B('paymentLabel')}
                    />
                    <NumberField value={p.percent} max={100} onChange={(v) => put({ ...p, percent: v ?? 0 })} />
                  </div>
                )}
              />
            </Row>
          </>
        );
      case 'media':
        return (
          <>
            {title}
            <Row label={B('mediaMode')}>
              <Picker
                label={B('mediaMode')}
                value={s.mode}
                onChange={(v) => set<'media'>({ mode: v })}
                options={(['image', 'gallery', 'logos', 'files', 'video'] as const).map((v) => ({
                  value: v,
                  label: B(`media.${v}`),
                }))}
              />
            </Row>
            {s.mode === 'video' ? (
              <Row label={B('videoUrl')}>
                <Text value={s.url} onChange={(v) => set<'media'>({ url: v })} dir="ltr" placeholder="https://" />
              </Row>
            ) : (
              <>
                <Row label={B('uploaded', { n: s.asset_ids.length })}>
                  <div className="flex flex-wrap items-center gap-2">
                    <UploadButton
                      accountId={accountId}
                      accept={s.mode === 'files' ? undefined : 'image/*'}
                      multiple={s.mode !== 'image'}
                      label={B('upload')}
                      onDone={(ids) =>
                        set<'media'>({
                          asset_ids: s.mode === 'image' ? ids.slice(0, 1) : [...s.asset_ids, ...ids].slice(0, 40),
                        })
                      }
                    />
                    {s.asset_ids.length ? (
                      <Button size="sm" variant="ghost" onClick={() => set<'media'>({ asset_ids: [] })}>
                        {B('clearAll')}
                      </Button>
                    ) : null}
                  </div>
                </Row>
                <Row label={B('filesColumn')}>
                  <ColumnPick
                    columns={cols}
                    types={COLS.file}
                    value={s.column_key}
                    onChange={(v) => set<'media'>({ column_key: v })}
                    label={B('filesColumn')}
                  />
                </Row>
              </>
            )}
            <Row label={B('caption')}>
              <Text value={s.caption} onChange={(v) => set<'media'>({ caption: v })} />
            </Row>
          </>
        );
      case 'inputs':
        return (
          <>
            {title}
            <Row label={B('intro')}>
              <LongText value={s.intro} onChange={(v) => set<'inputs'>({ intro: v })} rows={2} />
            </Row>
            <Row label={B('inputs')} hint={B('inputsHint')}>
              <ListEditor
                items={s.inputs}
                onChange={(inputs) => set<'inputs'>({ inputs })}
                blank={() => ({
                  id: newId().slice(-8).toLowerCase(),
                  label: '',
                  column_key: '',
                  required: false,
                  help: '',
                })}
                addLabel={B('addInput')}
                render={(inp, put) => (
                  <>
                    <Input
                      value={inp.label}
                      onChange={(e) => put({ ...inp, label: e.target.value })}
                      placeholder={B('label')}
                      aria-label={B('label')}
                    />
                    <ColumnPick
                      columns={cols}
                      types={COLS.input}
                      value={inp.column_key || null}
                      onChange={(v) => put({ ...inp, column_key: v ?? '' })}
                      label={B('column')}
                    />
                    <Toggle
                      label={B('required')}
                      checked={inp.required}
                      onChange={(v) => put({ ...inp, required: v })}
                    />
                  </>
                )}
              />
            </Row>
          </>
        );
      case 'questions':
        return (
          <>
            {title}
            <Row label={B('intro')}>
              <Text value={s.intro} onChange={(v) => set<'questions'>({ intro: v })} />
            </Row>
            <Notice>{B('questionsNote')}</Notice>
          </>
        );
      case 'signature':
        return <SignatureForm accountId={accountId} s={s} board={board} onChange={onChange} tokens={tokens} />;
      case 'cta':
        return (
          <>
            <Row label={B('ctaText')}>
              <Text value={s.text} onChange={(v) => set<'cta'>({ text: v })} />
            </Row>
            <Row label={B('buttonLabel')}>
              <Text value={s.button_label} onChange={(v) => set<'cta'>({ button_label: v })} />
            </Row>
            <Row label={B('ctaAction')}>
              <Segmented
                label={B('ctaAction')}
                value={s.action}
                onChange={(v) => set<'cta'>({ action: v })}
                options={(['sign', 'questions', 'url'] as const).map((v) => ({ value: v, label: B(`cta.${v}`) }))}
              />
            </Row>
            {s.action === 'url' ? (
              <Row label={B('url')}>
                <Text value={s.url} onChange={(v) => set<'cta'>({ url: v })} dir="ltr" placeholder="https://" />
              </Row>
            ) : null}
          </>
        );
      case 'faq':
        return (
          <>
            {title}
            <ListEditor
              items={s.items}
              onChange={(items) => set<'faq'>({ items })}
              blank={() => ({ q: '', a: '' })}
              addLabel={B('addFaq')}
              max={60}
              render={(f, put) => (
                <>
                  <Input
                    value={f.q}
                    onChange={(e) => put({ ...f, q: e.target.value })}
                    placeholder={B('question')}
                    aria-label={B('question')}
                  />
                  <LongText value={f.a} onChange={(v) => put({ ...f, a: v })} rows={2} ariaLabel={B('answer')} />
                </>
              )}
            />
          </>
        );
      case 'timeline':
        return (
          <>
            {title}
            <SourceForm
              source={s.source}
              board={board}
              rowsBoard={s.source.kind === 'subitems' ? subBoard : undefined}
              onChange={(source) => set<'timeline'>({ source })}
            />
            <Row label={B('dateColumn')}>
              <ColumnPick
                columns={(s.source.kind === 'subitems' ? subBoard?.columns : undefined) ?? []}
                types={COLS.date}
                value={s.date_column_key}
                onChange={(v) => set<'timeline'>({ date_column_key: v })}
                label={B('dateColumn')}
              />
            </Row>
            <Row label={B('descriptionColumn')}>
              <ColumnPick
                columns={(s.source.kind === 'subitems' ? subBoard?.columns : undefined) ?? []}
                types={COLS.text}
                value={s.description_column_key}
                onChange={(v) => set<'timeline'>({ description_column_key: v })}
                label={B('descriptionColumn')}
              />
            </Row>
          </>
        );
      case 'divider':
        return (
          <Row label={B('dividerStyle')}>
            <Segmented
              label={B('dividerStyle')}
              value={s.style}
              onChange={(v) => set<'divider'>({ style: v })}
              options={(['line', 'space', 'page_break'] as const).map((v) => ({ value: v, label: B(`divider.${v}`) }))}
            />
          </Row>
        );
      case 'toc':
        return title;
    }
  })();
  return (
    <div className="grid gap-3" data-testid="idoc-section-form" data-kind={s.kind}>
      {body}
      {common}
    </div>
  );
};

const FieldsEditor = ({
  fields,
  tokens,
  onChange,
}: {
  fields: { label: string; value: string }[];
  tokens: { label: string; token: string }[];
  onChange: (f: { label: string; value: string }[]) => void;
}) => (
  <Row label={B('fields')} hint={B('fieldsHint')}>
    <ListEditor
      items={fields}
      onChange={onChange}
      blank={() => ({ label: '', value: '' })}
      addLabel={B('addField')}
      render={(f, put) => (
        <div className="grid grid-cols-2 gap-1.5">
          <Input
            value={f.label}
            onChange={(e) => put({ ...f, label: e.target.value })}
            placeholder={B('label')}
            aria-label={B('label')}
          />
          <BoundValue
            label={f.label ? `${B('value')}: ${f.label}` : B('value')}
            value={f.value}
            tokens={tokens}
            onChange={(value, picked) => put({ ...f, value, label: f.label || picked || '' })}
          />
        </div>
      )}
    />
  </Row>
);

const SourceForm = ({
  source,
  board,
  rowsBoard,
  onChange,
}: {
  source: IdocRowSource;
  board: BoardDetail | undefined;
  rowsBoard: BoardDetail | undefined;
  onChange: (s: IdocRowSource) => void;
}) => (
  <>
    <Row label={B('rowsFrom')}>
      <Segmented
        label={B('rowsFrom')}
        value={source.kind}
        onChange={(v) => onChange({ ...source, kind: v })}
        options={[
          { value: 'subitems' as const, label: B('subitems') },
          { value: 'linked' as const, label: B('linked') },
        ]}
      />
    </Row>
    {source.kind === 'linked' ? (
      <Row label={B('relationColumn')}>
        <ColumnPick
          columns={board?.columns ?? []}
          types={COLS.relation}
          value={source.relation_column_key}
          onChange={(v) => onChange({ ...source, relation_column_key: v })}
          label={B('relationColumn')}
        />
      </Row>
    ) : null}
    <Row label={B('filterColumn')} hint={B('filterHint')}>
      <ColumnPick
        columns={rowsBoard?.columns ?? []}
        types={COLS.label}
        value={source.filter_column_key}
        onChange={(v) => onChange({ ...source, filter_column_key: v })}
        label={B('filterColumn')}
      />
    </Row>
    {source.filter_column_key ? (
      <Row label={B('filterValues')}>
        <Text
          value={source.filter_values.join(', ')}
          onChange={(v) =>
            onChange({
              ...source,
              filter_values: v
                .split(',')
                .map((x) => x.trim())
                .filter(Boolean)
                .slice(0, 50),
            })
          }
        />
      </Row>
    ) : null}
  </>
);

/** The mapping keys a row section of this mode needs, and the column each one is created as. */
const NEEDED: Record<keyof IdocLineMapping, { type: string; title: KeysUnder<'idoc.b.'> }> = {
  description: { type: 'long_text', title: 'col.description' },
  price: { type: 'numbers', title: 'col.price' },
  unit_price: { type: 'numbers', title: 'col.unitPrice' },
  recurring_price: { type: 'numbers', title: 'col.recurringPrice' },
  recurring_unit_price: { type: 'numbers', title: 'col.recurringUnitPrice' },
  quantity: { type: 'numbers', title: 'col.quantity' },
  selected: { type: 'checkbox', title: 'col.selected' },
  requires: { type: 'dependency', title: 'col.requires' },
  unit: { type: 'text', title: 'col.unit' },
};
const neededKeys = (s: IdocSectionOf<'lines'>): (keyof IdocLineMapping)[] => {
  const keys: (keyof IdocLineMapping)[] = ['description'];
  if (s.preset === 'subscription') keys.push('recurring_unit_price', 'quantity');
  else if (s.preset === 'third_party') keys.push('price', 'recurring_price');
  else keys.push('price');
  if (s.mode !== 'fixed') keys.push('selected');
  if (s.mode === 'multi') keys.push('requires');
  if (s.client_can_change_qty && !keys.includes('quantity')) keys.push('quantity', 'unit_price', 'unit');
  return keys;
};

const LinesForm = ({
  accountId,
  s,
  board,
  subBoard,
  sections,
  onChange,
  tokens,
}: {
  accountId: string;
  s: IdocSectionOf<'lines'>;
  board: BoardDetail | undefined;
  subBoard: BoardDetail | undefined;
  sections: IdocSection[];
  onChange: (next: IdocSection) => void;
  tokens: { label: string; token: string }[];
}) => {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<IdocSectionOf<'lines'>>) => onChange({ ...s, ...patch });
  const rowsBoard = s.source.kind === 'subitems' ? subBoard : undefined;
  const rowCols: Column[] = rowsBoard?.columns ?? [];
  const map = (key: keyof IdocLineMapping, v: string | null) => set({ mapping: { ...s.mapping, [key]: v } });
  const missing = neededKeys(s).filter((k) => !s.mapping[k]);
  const otherLines = sections.filter((x) => x.kind === 'lines' && x.id !== s.id);
  /** Creates the missing columns on the rows' board (and a "type" column to tell sections apart) and maps them. */
  const createColumns = async () => {
    if (!rowsBoard) return;
    setBusy(true);
    try {
      const mapping = { ...s.mapping };
      for (const k of missing) {
        const def = NEEDED[k];
        const col = await api(accountId).post<Column>(`/boards/${rowsBoard.id}/columns`, {
          title: B(def.title),
          type: def.type,
        });
        mapping[k] = col.id;
      }
      let source = s.source;
      if (!source.filter_column_key && otherLines.length) {
        const existing = rowCols.find((c) => c.title === B('col.kind') && COLS.label.includes(c.type as never));
        const kind =
          existing ??
          (await api(accountId).post<Column>(`/boards/${rowsBoard.id}/columns`, {
            title: B('col.kind'),
            type: 'text',
          }));
        source = { ...source, filter_column_key: kind.id, filter_values: [s.title || B('col.kind')] };
      }
      set({ mapping, source });
      await qc.invalidateQueries({ queryKey: boardKeys.board(accountId, rowsBoard.id) });
      showToast({ message: B('columnsCreated', { n: missing.length }), seconds: 3 });
    } catch (e) {
      showToast({ message: errorMessage(e), tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  const pick = (k: keyof IdocLineMapping, types: readonly string[]) => (
    <Row label={B(`map.${k}`)}>
      <ColumnPick
        columns={rowCols}
        types={types}
        value={s.mapping[k]}
        onChange={(v) => map(k, v)}
        label={B(`map.${k}`)}
        testId={`idoc-map-${k}`}
      />
    </Row>
  );
  return (
    <>
      <Row label={B('title')}>
        <Text value={s.title} onChange={(v) => set({ title: v })} />
      </Row>
      <Row label={B('intro')}>
        <LongText value={s.intro} onChange={(v) => set({ intro: v })} rows={2} tokens={tokens} />
      </Row>
      <Row label={B('mode')}>
        <Segmented
          label={B('mode')}
          value={s.mode}
          onChange={(v) => set({ mode: v })}
          options={(['fixed', 'multi', 'single'] as const).map((v) => ({ value: v, label: B(`modes.${v}`) }))}
        />
      </Row>
      <SourceForm source={s.source} board={board} rowsBoard={rowsBoard} onChange={(source) => set({ source })} />
      {s.source.kind === 'subitems' && !subBoard ? <Notice tone="warn">{B('noSubBoard')}</Notice> : null}
      {missing.length && rowsBoard ? (
        <div className="flex items-center justify-between gap-2 rounded-[10px] bg-accent-soft px-3 py-2 text-xs text-accent-fg">
          {B('missingColumns', { n: missing.length })}
          <Button
            size="sm"
            variant="secondary"
            busy={busy}
            onClick={() => void createColumns()}
            data-testid="idoc-create-columns"
          >
            {B('createColumns')}
          </Button>
        </div>
      ) : null}
      <div className="grid gap-2 border-t border-line pt-3">
        <span className="text-xs text-muted">{B('mapping')}</span>
        {pick('description', COLS.text)}
        {pick('price', COLS.amount)}
        {pick('unit_price', COLS.amount)}
        {pick('recurring_price', COLS.amount)}
        {pick('recurring_unit_price', COLS.amount)}
        {pick('quantity', COLS.number)}
        {pick('selected', COLS.checkbox)}
        {pick('requires', COLS.requires)}
        {pick('unit', COLS.text)}
      </div>
      <div className="grid gap-2 border-t border-line pt-3">
        {s.mode !== 'fixed' ? (
          <Toggle
            label={B('clientSelects')}
            checked={s.client_can_select}
            onChange={(v) => set({ client_can_select: v })}
          />
        ) : null}
        {s.mode === 'multi' && s.client_can_select ? (
          <Toggle label={B('selectAll')} checked={s.select_all} onChange={(v) => set({ select_all: v })} />
        ) : null}
        <Toggle
          label={B('clientQty')}
          checked={s.client_can_change_qty}
          onChange={(v) => set({ client_can_change_qty: v })}
        />
        {s.client_can_change_qty ? (
          <div className="grid grid-cols-2 gap-2">
            <Row label={B('minQty')}>
              <NumberField value={s.min_qty} onChange={(v) => set({ min_qty: v ?? 0 })} />
            </Row>
            <Row label={B('maxQty')}>
              <NumberField value={s.max_qty} onChange={(v) => set({ max_qty: v ?? 10000 })} />
            </Row>
          </div>
        ) : null}
        <Row label={B('unitLabel')}>
          <Text value={s.unit_label} onChange={(v) => set({ unit_label: v })} />
        </Row>
        <Toggle label={B('showPrices')} checked={s.show_prices} onChange={(v) => set({ show_prices: v })} />
        <Toggle label={B('showUnselected')} checked={s.show_unselected} onChange={(v) => set({ show_unselected: v })} />
        <Row label={B('period')}>
          <Segmented
            label={B('period')}
            value={s.recurring_period}
            onChange={(v) => set({ recurring_period: v })}
            options={[
              { value: 'month' as const, label: B('month') },
              { value: 'year' as const, label: B('year') },
            ]}
          />
        </Row>
        <Row label={B('countsIn')}>
          <Segmented
            label={B('countsIn')}
            value={s.totals}
            onChange={(v) => set({ totals: v })}
            options={(['main', 'third_party', 'none'] as const).map((v) => ({ value: v, label: B(`totals.${v}`) }))}
          />
        </Row>
      </div>
    </>
  );
};

const SignatureForm = ({
  accountId,
  s,
  board,
  onChange,
  tokens,
}: {
  accountId: string;
  s: IdocSectionOf<'signature'>;
  board: BoardDetail | undefined;
  onChange: (next: IdocSection) => void;
  tokens: { label: string; token: string }[];
}) => {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<IdocSectionOf<'signature'>>) => onChange({ ...s, ...patch });
  const cols = board?.columns ?? [];
  const status = cols.find((c) => c.id === s.status_column_key);
  const labels = ((status?.settings.labels as { label?: string }[] | undefined) ?? [])
    .map((l) => l.label ?? '')
    .filter(Boolean);
  const createColumns = async () => {
    if (!board) return;
    setBusy(true);
    try {
      const patch: Partial<IdocSectionOf<'signature'>> = {};
      if (!s.signature_column_key)
        patch.signature_column_key = (
          await api(accountId).post<Column>(`/boards/${board.id}/columns`, {
            title: B('col.signature'),
            type: 'signature',
          })
        ).id;
      if (!s.file_column_key)
        patch.file_column_key = (
          await api(accountId).post<Column>(`/boards/${board.id}/columns`, { title: B('col.signedCopy'), type: 'file' })
        ).id;
      set(patch);
      await qc.invalidateQueries({ queryKey: boardKeys.board(accountId, board.id) });
    } catch (e) {
      showToast({ message: errorMessage(e), tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Row label={B('title')}>
        <Text value={s.title} onChange={(v) => set({ title: v })} />
      </Row>
      <Row label={B('intro')}>
        <LongText value={s.intro} onChange={(v) => set({ intro: v })} rows={2} tokens={tokens} />
      </Row>
      <Row label={B('signMode')}>
        <Segmented
          label={B('signMode')}
          value={s.mode}
          onChange={(v) => set({ mode: v })}
          options={[
            { value: 'sign' as const, label: B('signModes.sign') },
            { value: 'approve' as const, label: B('signModes.approve') },
          ]}
        />
      </Row>
      {s.mode === 'sign' ? (
        <Toggle label={B('requireDrawing')} checked={s.require_drawing} onChange={(v) => set({ require_drawing: v })} />
      ) : null}
      <Toggle label={B('askRole')} checked={s.ask_role} onChange={(v) => set({ ask_role: v })} />
      <Toggle label={B('senderSigns')} checked={s.sender_signs} onChange={(v) => set({ sender_signs: v })} />
      <Row label={B('buttonLabel')}>
        <Text value={s.button_label} onChange={(v) => set({ button_label: v })} />
      </Row>
      <Row label={B('consents')}>
        <ListEditor
          items={s.consents}
          onChange={(consents) => set({ consents })}
          blank={() => ({ key: newId().slice(-8).toLowerCase(), text: '', required: true })}
          addLabel={B('addConsent')}
          max={10}
          render={(c, put) => (
            <>
              <Input
                value={c.text}
                onChange={(e) => put({ ...c, text: e.target.value })}
                placeholder={B('consentText')}
                aria-label={B('consentText')}
              />
              <Toggle label={B('required')} checked={c.required} onChange={(v) => put({ ...c, required: v })} />
            </>
          )}
        />
      </Row>
      <div className="grid gap-2 border-t border-line pt-3">
        <span className="text-xs text-muted">{B('onSign')}</span>
        {(!s.signature_column_key || !s.file_column_key) && board ? (
          <div className="flex items-center justify-between gap-2 rounded-[10px] bg-accent-soft px-3 py-2 text-xs text-accent-fg">
            {B('signColumnsMissing')}
            <Button
              size="sm"
              variant="secondary"
              busy={busy}
              onClick={() => void createColumns()}
              data-testid="idoc-create-sign-columns"
            >
              {B('createColumns')}
            </Button>
          </div>
        ) : null}
        <Row label={B('signatureColumn')}>
          <ColumnPick
            columns={cols}
            types={COLS.signature}
            value={s.signature_column_key}
            onChange={(v) => set({ signature_column_key: v })}
            label={B('signatureColumn')}
          />
        </Row>
        <Row label={B('statusColumn')}>
          <ColumnPick
            columns={cols}
            types={COLS.status}
            value={s.status_column_key}
            onChange={(v) => set({ status_column_key: v, status_label: '' })}
            label={B('statusColumn')}
          />
        </Row>
        {s.status_column_key ? (
          <Row label={B('statusLabel')}>
            <Picker
              label={B('statusLabel')}
              value={s.status_label}
              placeholder={B('none')}
              options={[{ value: '', label: B('none') }, ...labels.map((l) => ({ value: l, label: l }))]}
              onChange={(v) => set({ status_label: v })}
            />
          </Row>
        ) : null}
        <Row label={B('copyColumn')}>
          <ColumnPick
            columns={cols}
            types={COLS.file}
            value={s.file_column_key}
            onChange={(v) => set({ file_column_key: v })}
            label={B('copyColumn')}
          />
        </Row>
      </div>
    </>
  );
};
