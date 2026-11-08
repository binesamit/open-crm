// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import {
  columnTypes,
  computeIdocTotals,
  idocSectionsOf,
  idocSettingsOf,
  mergedIdocSummary,
  mergeIdocText,
  type IdocAccountThemes,
  type IdocLinesSection,
  type IdocRowSource,
  type IdocSection,
  type IdocSettings,
  type IdocTotals,
  type PublicIdocData,
  type PublicIdocInput,
  type PublicIdocRow,
  type PublicIdocSection,
} from '@bines/shared';
import type { AppDeps } from '../../types';
import type { ColumnRow } from '../boards/boards.repo';
import { listColumns } from '../boards/boards.repo';
import { loadSettings } from '../accounts/accounts.service';
import { findAsset } from '../files/files.repo';
import { childItemsOf, itemsByIds } from '../items/items.repo';
import { calculatorFor, loadItem, visibleColumns, type Actor } from '../items/items.service';
import type { CellDto } from '../items/computed';
import { visibleAcrossBoards } from '../items/visibility';
import type { ItemRow } from '../items/items.repo';
import { findUserById } from '../users/users.repo';
import type { IdocDocRow } from './idocs.repo';

/**
 * Builds what an interactive document shows from its item — for the public page and the editor's preview alike:
 * merge fields, the rows of row sections (subitems or linked items) with their amounts and choices, the client's
 * inputs, people, files and dates. Everything is read with the identity given (the document's sender on the public
 * page), so a hidden column or an item they may not see never shows. Column keys never leave this file: the page
 * gets texts, opaque row keys and file references only.
 */

type Deps = Pick<AppDeps, 'db' | 'storage'>;

/** A choice kept on the document for rows that have no "selected" / "quantity" column. */
type RowState = { s?: boolean; q?: number };
export type DocState = { salt?: string; rows?: Record<string, Record<string, RowState>> };

export const docStateOf = (doc: Pick<IdocDocRow, 'state'>): DocState => (doc.state ?? {}) as DocState;

/** Opaque key of a row / file for this document (never the item or asset id). */
export const refOf = (salt: string, id: string) =>
  createHash('sha256').update(`${salt}:${id}`).digest('base64url').slice(0, 14);

export type ResolvedRow = PublicIdocRow & { itemId: string; boardId: string };
export type ResolvedLines = { section: IdocLinesSection; rows: ResolvedRow[] };
export type ResolvedInput = {
  sectionId: string;
  input: PublicIdocInput;
  column: ColumnRow;
};

export type DocView = {
  item: ItemRow;
  settings: IdocSettings;
  sections: IdocSection[];
  publicSections: PublicIdocSection[];
  lines: ResolvedLines[];
  inputs: ResolvedInput[];
  totals: IdocTotals;
  /** ref → asset id: what the page may download through this document. */
  files: Map<string, string>;
  itemColumns: ColumnRow[];
  lookup: (token: string) => string | undefined;
  accountName: string;
  logoRef: string | null;
  timezone: string;
  /** The account's default looks (guests / members). */
  accountThemes: IdocAccountThemes;
};

const INPUT_KINDS: Record<string, PublicIdocInput['kind']> = {
  text: 'text',
  long_text: 'long_text',
  email: 'email',
  phone: 'phone',
  numbers: 'number',
  date: 'date',
  checkbox: 'checkbox',
  link: 'link',
};

/** An input's value as the page shows it, from the cell. */
const inputValue = (kind: PublicIdocInput['kind'], value: unknown): PublicIdocInput['value'] => {
  const v = (value ?? null) as Record<string, unknown> | string | number | null;
  if (v === null) return kind === 'checkbox' ? false : null;
  switch (kind) {
    case 'text':
      return typeof v === 'string' ? v : null;
    case 'long_text':
      return typeof v === 'object' ? String(v.text ?? '') : null;
    case 'email':
      return typeof v === 'object' ? String(v.email ?? '') : null;
    case 'phone':
      return typeof v === 'object' ? String(v.phone ?? '') : null;
    case 'number':
      return typeof v === 'number' ? v : null;
    case 'date':
      return typeof v === 'object' ? String(v.date ?? '') : null;
    case 'checkbox':
      return typeof v === 'object' ? v.checked === true : false;
    case 'link':
      return typeof v === 'object' ? String(v.url ?? '') : null;
  }
};

/** A page value → the column's stored value (null clears). Undefined = not valid for the column. */
export const inputToCell = (kind: PublicIdocInput['kind'], raw: unknown): unknown => {
  if (raw === null || raw === '' || raw === undefined) return kind === 'checkbox' ? { checked: false } : null;
  switch (kind) {
    case 'text':
      return String(raw).slice(0, 2000);
    case 'long_text':
      return { text: String(raw).slice(0, 20000) };
    case 'email':
      return { email: String(raw).trim() };
    case 'phone':
      return { phone: String(raw).trim() };
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/,/g, ''));
      return Number.isFinite(n) ? n : undefined;
    }
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(String(raw)) ? { date: String(raw) } : undefined;
    case 'checkbox':
      return { checked: raw === true };
    case 'link':
      return /^https?:\/\//i.test(String(raw)) ? { url: String(raw) } : undefined;
  }
};

const numberOf = (cell: CellDto | null | undefined): number | null => {
  if (!cell) return null;
  if (typeof cell.value === 'number' && Number.isFinite(cell.value)) return cell.value;
  const t = (cell.text ?? '').replace(/[^\d.,-]/g, '').replace(/,/g, '');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

const idsOf = (cell: CellDto | null | undefined): string[] => {
  const v = cell?.value as { item_ids?: unknown } | null | undefined;
  return Array.isArray(v?.item_ids) ? v.item_ids.filter((x): x is string => typeof x === 'string') : [];
};

const dateParts = (cell: CellDto | null | undefined): { start: string | null; end: string | null } => {
  const v = cell?.value as { date?: string; from?: string; to?: string } | null | undefined;
  if (!v) return { start: null, end: null };
  if (v.from) return { start: v.from, end: v.to ?? null };
  return { start: v.date ?? null, end: null };
};

/** Every string of a section's settings goes through merge fields; keys of columns are blanked for the page. */
const COLUMN_KEY = /(^|_)column_key$/;
const forPage = (value: unknown, merge: (s: string) => string, key = ''): unknown => {
  if (key === 'mapping' || key === 'source') return null;
  if (COLUMN_KEY.test(key)) return null;
  if (typeof value === 'string') return key === 'id' || key === 'kind' || key === 'preset' ? value : merge(value);
  if (Array.isArray(value)) return value.map((v) => forPage(v, merge));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, forPage(v, merge, k)]));
  return value;
};

const formatDate = (d: Date | null | undefined, tz: string, language: 'he' | 'en') => {
  if (!d) return '';
  try {
    return new Intl.DateTimeFormat(language === 'he' ? 'he-IL' : 'en-GB', {
      timeZone: tz,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
};

const labelTextMatches = (cell: CellDto | null | undefined, values: string[]) => {
  if (!values.length) return true;
  const text = (cell?.text ?? '').trim();
  const parts = text ? text.split(',').map((x) => x.trim()) : [];
  return values.some((v) => parts.includes(v.trim()));
};

export const buildDocView = async (
  deps: Deps,
  a: Actor,
  doc: IdocDocRow,
  override?: { sections?: IdocSection[]; settings?: IdocSettings },
): Promise<DocView> => {
  const { db } = deps;
  const sections = override?.sections ?? idocSectionsOf(doc.sections);
  const settings = override?.settings ?? idocSettingsOf(doc.settings);
  const state = docStateOf(doc);
  const salt = state.salt ?? doc.id;
  const { item, access } = await loadItem(db, a, doc.itemId);
  const itemColumns = await visibleColumns(db, access);
  const byKey = (cols: ColumnRow[]) => new Map(cols.map((c) => [c.key, c]));
  const itemCols = byKey(itemColumns);
  const boardCols = new Map<string, Map<string, ColumnRow>>([[item.boardId, itemCols]]);
  const colsOf = async (boardId: string) => {
    let m = boardCols.get(boardId);
    if (!m) {
      m = byKey(await listColumns(db, boardId));
      boardCols.set(boardId, m);
    }
    return m;
  };

  // 1st pass: the item itself (its relation columns name the linked rows and the {col:rel.key} items).
  let calc = await calculatorFor(db, a, [item.id], [item]);
  const cellOn = (itemId: string, cols: Map<string, ColumnRow>, key: string | null | undefined) => {
    if (!key) return null;
    const col = cols.get(key);
    const def = col ? columnTypes.get(col.type) : undefined;
    return col && def ? calc.display(itemId, col, def) : null;
  };

  const visible = sections.filter((s) => !s.hidden);
  const rowSources = visible.flatMap((s) => (s.kind === 'lines' || s.kind === 'timeline' ? [s.source] : []));
  const needsChildren = rowSources.some((s) => s.kind === 'subitems');
  const linkedIds = new Set<string>();
  for (const s of rowSources)
    if (s.kind === 'linked')
      for (const id of idsOf(cellOn(item.id, itemCols, s.relation_column_key))) linkedIds.add(id);
  // {col:relation.key}: the first linked item of each relation named in any text.
  const relTokens = new Set<string>();
  JSON.stringify(visible).replace(/\{col:([a-z0-9_-]{1,64})\.[a-z0-9_-]{1,64}\}/gi, (_m, rel: string) => {
    relTokens.add(rel);
    return '';
  });
  const relFirst = new Map<string, string>();
  for (const rel of relTokens) {
    const first = idsOf(cellOn(item.id, itemCols, rel))[0];
    if (first) {
      relFirst.set(rel, first);
      linkedIds.add(first);
    }
  }
  const children = needsChildren ? (await childItemsOf(db, [item.id])).filter((c) => !c.archivedAt) : [];
  const linkedRows = linkedIds.size
    ? (await itemsByIds(db, a.ctx.accountId, [...linkedIds])).filter((i) => !i.archivedAt)
    : [];
  // Linked items of boards the sender cannot read (or rows hidden from them) are not there at all.
  const canSee = await visibleAcrossBoards(db, a, linkedRows);
  const linked = linkedRows.filter((i) => canSee.has(i.id));
  const rowItems = new Map<string, ItemRow>([...children, ...linked].map((i) => [i.id, i]));
  if (rowItems.size) calc = await calculatorFor(db, a, [item.id, ...rowItems.keys()], [item, ...rowItems.values()]);
  for (const i of rowItems.values()) await colsOf(i.boardId);
  const colsFor = (i: ItemRow) => boardCols.get(i.boardId)!;

  const sourceRows = (src: IdocRowSource): ItemRow[] => {
    const list =
      src.kind === 'subitems'
        ? children
        : idsOf(cellOn(item.id, itemCols, src.relation_column_key))
            .map((id) => rowItems.get(id))
            .filter((x): x is ItemRow => !!x);
    return list.filter(
      (r) =>
        !src.filter_column_key || labelTextMatches(cellOn(r.id, colsFor(r), src.filter_column_key), src.filter_values),
    );
  };

  const account = a.ctx.account;
  const accountSettings = await loadSettings(db, account.id);
  const tz = accountSettings.locale.timezone;
  const lookup = (token: string): string | undefined => {
    if (token === 'item.name') return item.name;
    if (token === 'account.name') return account.name;
    if (token === 'doc.name') return doc.name;
    if (token === 'doc.date') return formatDate(doc.sentAt ?? doc.createdAt, tz, settings.language);
    if (token === 'doc.expires') return formatDate(doc.expiresAt, tz, settings.language);
    if (token.startsWith('col:')) {
      const key = token.slice(4);
      const dot = key.indexOf('.');
      if (dot < 0) return cellOn(item.id, itemCols, key)?.text ?? '';
      const target = rowItems.get(relFirst.get(key.slice(0, dot)) ?? '');
      return target ? (cellOn(target.id, colsFor(target), key.slice(dot + 1))?.text ?? '') : '';
    }
    return undefined;
  };
  const merge = (s: string) => mergeIdocText(s, lookup, { keepTotals: true });

  const files = new Map<string, string>();
  const fileRef = (assetId: string) => {
    const ref = refOf(salt, assetId);
    files.set(ref, assetId);
    return ref;
  };
  const fileUrl = (ref: string) => `/api/v1/public/idocs/${doc.token}/files/${ref}`;
  const assetFile = async (assetId: string) => {
    const asset = await findAsset(db, a.ctx.accountId, assetId);
    if (!asset || asset.uploadStatus !== 'uploaded') return null;
    const ref = fileRef(asset.id);
    return { ref, name: asset.fileName, mime: asset.mime, url: fileUrl(ref) };
  };
  const logoId = settings.logo_asset_id ?? accountSettings.branding.logo_asset_id ?? account.logoAssetId ?? null;
  const logoRef = logoId && (await findAsset(db, a.ctx.accountId, logoId)) ? fileRef(logoId) : null;

  const lines: ResolvedLines[] = [];
  const inputs: ResolvedInput[] = [];
  const publicSections: PublicIdocSection[] = [];
  for (const s of visible) {
    const data: PublicIdocData = {};
    if (s.kind === 'header' || s.kind === 'fields')
      data.fields = s.fields
        .map((f) => ({ label: merge(f.label), value: merge(f.value) }))
        .filter((f) => f.value.trim());
    if (s.kind === 'header' && s.cover_asset_id) {
      const f = await assetFile(s.cover_asset_id);
      data.cover_url = f?.url ?? null;
    }
    if (s.kind === 'lines') {
      const items = sourceRows(s.source);
      const m = s.mapping;
      const sectionState = state.rows?.[s.id] ?? {};
      const keyOfItem = new Map(items.map((r) => [r.id, refOf(salt, r.id)]));
      const rows: ResolvedRow[] = items.slice(0, 300).map((r) => {
        const cols = colsFor(r);
        const st = sectionState[r.id] ?? {};
        const qtyCell = m.quantity ? cellOn(r.id, cols, m.quantity) : null;
        const selCell = m.selected ? cellOn(r.id, cols, m.selected) : null;
        const requiresIds = m.requires ? idsOf(cellOn(r.id, cols, m.requires)) : [];
        const requires = requiresIds.map((id) => keyOfItem.get(id)).filter((k): k is string => !!k);
        const qty = m.quantity ? (numberOf(qtyCell) ?? 0) : typeof st.q === 'number' ? st.q : null;
        const selected =
          s.mode === 'fixed'
            ? true
            : m.selected
              ? (selCell?.value as { checked?: boolean } | null)?.checked === true
              : st.s === true;
        return {
          key: keyOfItem.get(r.id)!,
          itemId: r.id,
          boardId: r.boardId,
          name: r.name,
          description: m.description ? (cellOn(r.id, cols, m.description)?.text ?? '') : '',
          price: m.price ? numberOf(cellOn(r.id, cols, m.price)) : null,
          unit_price: m.unit_price ? numberOf(cellOn(r.id, cols, m.unit_price)) : null,
          recurring_price: m.recurring_price ? numberOf(cellOn(r.id, cols, m.recurring_price)) : null,
          recurring_unit_price: m.recurring_unit_price ? numberOf(cellOn(r.id, cols, m.recurring_unit_price)) : null,
          qty,
          selected,
          requires,
          requires_names: requiresIds.map((id) => rowItems.get(id)?.name ?? '').filter(Boolean),
          unit: (m.unit ? cellOn(r.id, cols, m.unit)?.text : '') || s.unit_label,
        };
      });
      lines.push({ section: s, rows });
      data.rows = rows.map(({ itemId: _i, boardId: _b, ...pub }) => pub);
    }
    if (s.kind === 'inputs') {
      data.inputs = [];
      for (const inp of s.inputs) {
        const col = itemCols.get(inp.column_key);
        const kind = col ? INPUT_KINDS[col.type] : undefined;
        if (!col || !kind) continue;
        const pub: PublicIdocInput = {
          id: inp.id,
          label: merge(inp.label),
          kind,
          value: inputValue(kind, cellOn(item.id, itemCols, col.key)?.value),
          required: inp.required,
          help: merge(inp.help),
        };
        inputs.push({ sectionId: s.id, input: pub, column: col });
        data.inputs.push(pub);
      }
    }
    if (s.kind === 'people' && s.column_key) {
      const v = cellOn(item.id, itemCols, s.column_key)?.value as {
        persons_and_teams?: { id: string; kind: string }[];
      } | null;
      data.people = [];
      for (const p of (v?.persons_and_teams ?? []).filter((x) => x.kind === 'person').slice(0, 12)) {
        const u = await findUserById(db, p.id);
        if (!u) continue;
        const photo = u.avatarAssetId ? await assetFile(u.avatarAssetId) : null;
        data.people.push({
          name: u.name,
          email: s.show_email ? u.email : null,
          phone: s.show_phone ? (u.phone ?? null) : null,
          photo_url: photo?.url ?? null,
        });
      }
    }
    if (s.kind === 'media') {
      const out: NonNullable<PublicIdocData['files']> = [];
      for (const id of s.asset_ids) {
        const f = await assetFile(id);
        if (f) out.push(f);
      }
      if (s.column_key) {
        const v = cellOn(item.id, itemCols, s.column_key)?.value as { files?: { asset_id: string }[] } | null;
        for (const f of v?.files ?? []) {
          const got = await assetFile(f.asset_id);
          if (got) out.push(got);
        }
      }
      data.files = out;
    }
    if (s.kind === 'timeline') {
      data.dated = sourceRows(s.source).map((r) => {
        const cols = colsFor(r);
        const d = dateParts(cellOn(r.id, cols, s.date_column_key));
        return {
          name: r.name,
          ...d,
          description: s.description_column_key ? (cellOn(r.id, cols, s.description_column_key)?.text ?? '') : '',
        };
      });
    }
    if (s.kind === 'signature' && s.sender_signs) {
      const sender = doc.createdBy ? await findUserById(db, doc.createdBy) : null;
      data.sender_name = sender?.name ?? null;
    }
    publicSections.push({ ...(forPage(s, merge) as IdocSection), data });
  }

  const totals = computeIdocTotals(
    lines.map((l) => ({ section: l.section, rows: l.rows })),
    mergedIdocSummary(visible),
    settings,
  );
  return {
    item,
    settings,
    sections,
    publicSections,
    lines,
    inputs,
    totals,
    files,
    itemColumns,
    lookup,
    accountName: account.name,
    logoRef,
    timezone: tz,
    accountThemes: accountSettings.idoc_themes,
  };
};

export const fileUrlOf = (token: string, ref: string) => `/api/v1/public/idocs/${token}/files/${ref}`;
