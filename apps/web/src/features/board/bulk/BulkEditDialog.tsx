// SPDX-License-Identifier: AGPL-3.0-only
import { type DragEvent, useContext, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '@bines/sdk';
import {
  buildBulkEdit,
  buildSubitems,
  BULK_EDIT_MAX_BYTES,
  type BulkDecisions,
  type BulkEditRequest,
  type BulkEnv,
  type BulkEditResult,
  defaultDecisions,
  type Draft,
  draftChanges,
  EMPTY_DRAFT,
  type ImportTable,
  mainRowRef,
  mergeReviews,
  planParents,
  type Query,
  reviewDraft,
  reviewSubitems,
  type SheetColumn,
  type SheetRow,
  type SheetState,
  subEnv,
  t,
} from '@bines/shared';
import { Button, Dialog, Notice, SkeletonRows, Tabs } from '@bines/ui';
import { api, errorMessage } from '../../../lib/api';
import { confirmDialog } from '../../../lib/dialogs';
import { showToast } from '../../../lib/toast';
import { useUndoToast } from '../../../lib/undo';
import { type BoardDetail, boardKeys } from '../board-api';
import { BoardAccountContext } from '../board-context';
import type { FilterCtx } from '../toolbar/FilterPanel';
import { BulkImportPanel, type ImportMapping, initialMapping, planImport } from './BulkImport';
import { BulkReviewPanel, canInvite, type InviteRole } from './BulkReview';
import { BulkSheet, type Cell } from './BulkSheet';
import { IMPORT_ACCEPT, ImportFileError, readImportFile } from './read-file';
import { useSecretStepUp } from '../../secrets/step-up';
import { Icon } from '../../../lib/icons';
import { useSheet } from './use-sheet';

/** The two sheets (B4): the items, and — on a board with subitems — the subitems. */
type Tab = 'main' | 'sub';
/** Both sheets' drafts: one history, one "finish", one batch. */
type Drafts = Record<Tab, Draft>;
const NO_DRAFTS: Drafts = { main: EMPTY_DRAFT, sub: EMPTY_DRAFT };

/** Draft history: the sheet's own Ctrl+Z / Ctrl+Y step through it (nothing is written before "finish"). */
type History = { past: Drafts[]; draft: Drafts; future: Drafts[] };
const HISTORY_MAX = 100;

type Importing = { tables: ImportTable[]; fileName: string; mapping: ImportMapping; tab: Tab };

/**
 * "ייבוא ועריכה" (12-ROADMAP; B1–B4; the menu says "ייבוא" —, "עריכה גדולה" before): it opens on the
 * choice of a file ("ייבוא קובץ", or one dropped on the dialog) or "עריכה בגיליון". The view's items as a sheet of
 * text cells, edited as a draft — typed, pasted, or imported from an Excel / CSV file (mapping screen → the draft).
 * Secret columns are write-only there: their values are never loaded, a new one is sent once and
 * encrypted by the server; cells that have a value are replaced only when the review says so (with a fresh code
 * when the column asks for one).
 * On a board with subitems a second tab, "תתי-פריטים", holds the subitems of those items with the sub-board's
 * columns and a "parent item" column (typed by name — an item of the first tab, new ones included). "סיום" opens
 * the review of both tabs (new labels / tags, invalid values and parents, people not found) and "אישור" writes
 * everything — new columns of the import included — as one batch that one Ctrl+Z / "ביטול" / undo in the activity
 * log takes back. Board owners and admins only (the menu entry checks `board.update`).
 */
export const BulkEditDialog = ({
  board,
  filterCtx,
  view,
  onClose,
}: {
  board: BoardDetail;
  filterCtx: FilterCtx;
  /** The current view's query and visible columns, as when the dialog opened. */
  view: { query?: Partial<Query>; columns?: string[] };
  onClose: () => void;
}) => {
  const { id: accountId, slug } = useContext(BoardAccountContext);
  const stepUp = useSecretStepUp({ id: accountId, slug });
  const qc = useQueryClient();
  const undoToast = useUndoToast(accountId);
  const sheet = useSheet(accountId, board, filterCtx, view);
  // The rows as they were when the sheet opened: live changes of others do not move the draft under the user.
  const [bases, setBases] = useState<{ main: SheetRow[]; sub: SheetRow[] | null } | null>(null);
  const ready = !!sheet.rows && (!sheet.sub || (!!sheet.sub.rows && !!sheet.sub.columns));
  if (!bases && ready) setBases({ main: sheet.rows!, sub: sheet.sub?.rows ?? null });
  const base = bases?.main ?? null;
  const subBase = bases?.sub ?? null;
  const [history, setHistory] = useState<History>({ past: [], draft: NO_DRAFTS, future: [] });
  const drafts = history.draft;
  const [tab, setTab] = useState<Tab>('main');
  // "ייבוא" opens on the choice of a file (or the sheet without one).
  const [step, setStep] = useState<'start' | 'sheet' | 'import' | 'review'>('start');
  const [replaceSecrets, setReplaceSecrets] = useState(false);
  const [focus, setFocus] = useState<Cell | null>(null);
  const [decisions, setDecisions] = useState<BulkDecisions>({ labels: {}, tags: {} });
  const [invites, setInvites] = useState<Record<string, InviteRole>>({});
  // Columns a file import adds (created on "finish"), per sheet, before its last column (group / parent).
  const [newColumns, setNewColumns] = useState<Record<Tab, SheetColumn[]>>({ main: [], sub: [] });
  const [importing, setImporting] = useState<Importing | null>(null);
  const [reading, setReading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const withNew = (cols: SheetColumn[], added: SheetColumn[]) => [...cols.slice(0, -1), ...added, ...cols.slice(-1)];
  const columns = useMemo(() => withNew(sheet.columns, newColumns.main), [sheet.columns, newColumns.main]);
  const subColumns = useMemo(
    () => (sheet.sub?.columns ? withNew(sheet.sub.columns, newColumns.sub) : null),
    [sheet.sub?.columns, newColumns.sub],
  );

  // The two sheets, and where every subitem row hangs (its parent typed by name, matched across both drafts).
  const mainState = useMemo<SheetState | null>(
    () => (base ? { base, draft: drafts.main, columns } : null),
    [base, drafts.main, columns],
  );
  const subState = useMemo<SheetState | null>(
    () => (subBase && subColumns ? { base: subBase, draft: drafts.sub, columns: subColumns } : null),
    [subBase, drafts.sub, subColumns],
  );
  const maxDepth = sheet.sub?.maxDepth ?? 1;
  const parents = useMemo(
    () => (mainState && subState ? planParents(mainState, subState, maxDepth) : null),
    [mainState, subState, maxDepth],
  );
  const env = sheet.env;
  const subSheetEnv = useMemo(() => (parents ? subEnv(env, parents) : env), [env, parents]);

  const mainChanges = useMemo(
    () => (mainState ? draftChanges(mainState.base, mainState.draft, mainState.columns) : []),
    [mainState],
  );
  const subChanges = useMemo(
    () => (subState ? draftChanges(subState.base, subState.draft, subState.columns) : []),
    [subState],
  );
  const changes = [...mainChanges, ...subChanges];
  const newRows = countNew(mainChanges, base?.length ?? 0) + countNew(subChanges, subBase?.length ?? 0);
  const review = useMemo(
    () => (mainState && step === 'review' ? reviewBoth(mainState, subState, env, subSheetEnv) : null),
    [mainState, subState, env, subSheetEnv, step],
  );
  const allColumns = useMemo(() => [...columns, ...(subColumns ?? [])], [columns, subColumns]);

  const change = (next: Drafts) =>
    setHistory((h) =>
      next === h.draft ? h : { past: [...h.past, h.draft].slice(-HISTORY_MAX), draft: next, future: [] },
    );
  const changeTab = (which: Tab, next: Draft) => change({ ...drafts, [which]: next });
  const undo = () =>
    setHistory((h) =>
      h.past.length ? { past: h.past.slice(0, -1), draft: h.past.at(-1)!, future: [h.draft, ...h.future] } : h,
    );
  const redo = () =>
    setHistory((h) =>
      h.future.length ? { past: [...h.past, h.draft], draft: h.future[0]!, future: h.future.slice(1) } : h,
    );

  const close = async () => {
    if (changes.length && !write.isPending) {
      const ok = await confirmDialog({
        title: t('bulk.discard.title'),
        message: t('bulk.discard.message'),
        confirmLabel: t('bulk.discard.confirm'),
        danger: true,
      });
      if (!ok) return;
    }
    onClose();
  };

  // ---- file import (B3), into the sheet of the open tab ----
  const stateOf = (which: Tab) => (which === 'sub' ? subState : mainState);
  const openFile = async (file: File | undefined) => {
    const s = stateOf(tab);
    if (!file || !s || reading) return;
    setReading(true);
    try {
      const tables = await readImportFile(file);
      setImporting({ tables, fileName: file.name, mapping: initialMapping(tables, s.columns, s.base), tab });
      setStep('import');
    } catch (err) {
      const code = err instanceof ImportFileError ? err.code : 'read';
      showToast({ message: t(`bulk.import.error.${code}`), tone: 'error' });
    } finally {
      setReading(false);
    }
  };
  const nextNewId = newColumns.main.length + newColumns.sub.length + 1;
  const importState = importing ? stateOf(importing.tab) : null;
  const importPlan = useMemo(() => {
    if (!importing || !importState) return null;
    const table = importing.tables[importing.mapping.sheet] ?? importing.tables[0]!;
    const data = importing.mapping.header ? table.rows.slice(1) : table.rows;
    return planImport(importState.base, importState.draft, importState.columns, data, importing.mapping, nextNewId);
  }, [importing, importState, nextNewId]);
  const canApply =
    !!importPlan &&
    !importPlan.result.tooMany &&
    importing!.mapping.targets.some((x) => x.kind !== 'ignore') &&
    (importPlan.result.created > 0 || importPlan.result.updated > 0);
  const applyImport = () => {
    if (!importPlan || !canApply || !importing || !importState) return;
    const which = importing.tab;
    // Only new columns some row writes into (a mapped column with no values makes nothing).
    const written = new Set(
      draftChanges(importState.base, importPlan.result.draft, importPlan.all).map((c) => c.column.id),
    );
    setNewColumns((cols) => ({
      ...cols,
      [which]: [...cols[which], ...importPlan.columns.filter((c) => written.has(c.id))],
    }));
    changeTab(which, importPlan.result.draft);
    setImporting(null);
    setStep('sheet');
    showToast({
      message: t('bulk.import.applied', { updated: importPlan.result.updated, created: importPlan.result.created }),
      seconds: 6,
    });
  };
  const onDragOver = (e: DragEvent) => {
    if ((step !== 'sheet' && step !== 'start') || !e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!dragOver) setDragOver(true);
  };
  const onDrop = (e: DragEvent) => {
    if ((step !== 'sheet' && step !== 'start') || !e.dataTransfer.files.length) return;
    e.preventDefault();
    setDragOver(false);
    void openFile(e.dataTransfer.files[0]);
  };

  // ---- finish ----
  const finish = () => {
    if (!mainState) return;
    const r = reviewBoth(mainState, subState, env, subSheetEnv);
    // Answers given before (back to the sheet and again) stay; new values get the defaults.
    const defaults = defaultDecisions(r, allColumns);
    setDecisions((prev) => ({
      labels: { ...defaults.labels, ...pick(prev.labels, defaults.labels) },
      tags: { ...defaults.tags, ...pick(prev.tags, defaults.tags) },
    }));
    setStep('review');
  };

  const built = useMemo(() => {
    if (!mainState || step !== 'review') return null;
    const lastGroup = [...mainState.base].reverse().find((r) => r.groupId)?.groupId ?? board.groups[0]?.id ?? null;
    const name = board.item_terminology === 'item' ? t('board.itemDefault') : board.item_terminology;
    const out = buildBulkEdit(mainState.base, mainState.draft, mainState.columns, env, decisions, {
      groupId: lastGroup,
      name,
      ref: mainRowRef,
    });
    // New columns of the import that some cell or label still uses are created first, in the same batch.
    const newOf = (list: SheetColumn[], used: Set<string>) =>
      list
        .filter((c) => used.has(c.id))
        .map((c) => ({ ref: c.id, title: c.title, type: c.type, settings: c.settings }));
    const cols = newOf(
      newColumns.main,
      new Set([
        ...out.request.rows.flatMap((r) => Object.keys(r.cells)),
        ...out.request.labels.map((l) => l.column_id),
      ]),
    );
    let request: BulkEditRequest = cols.length ? { ...out.request, columns: cols } : out.request;
    if (replaceSecrets) request = { ...request, secrets_mode: 'replace' };
    let skipped = out.skipped;
    if (subState) {
      const refs = new Set(out.request.rows.flatMap((r) => (r.ref ? [r.ref] : [])));
      const s = buildSubitems(subState, subSheetEnv, decisions, { name: t('bulk.subitemDefault') }, refs);
      skipped += s.skipped;
      const subCols = newOf(
        newColumns.sub,
        new Set([
          ...s.subitems.rows.flatMap((r) => Object.keys(r.cells)),
          ...s.subitems.labels.map((l) => l.column_id),
        ]),
      );
      if (s.subitems.rows.length || s.subitems.labels.length)
        request = { ...request, subitems: subCols.length ? { ...s.subitems, columns: subCols } : s.subitems };
    }
    const bytes = new TextEncoder().encode(JSON.stringify(request)).length;
    return { request, skipped, bytes };
  }, [
    mainState,
    subState,
    step,
    env,
    subSheetEnv,
    decisions,
    board.groups,
    board.item_terminology,
    newColumns,
    replaceSecrets,
  ]);
  const tooBig = !!built && built.bytes > BULK_EDIT_MAX_BYTES;
  const nothingToWrite =
    !built ||
    (!built.request.rows.length &&
      !built.request.labels.length &&
      !built.request.subitems?.rows.length &&
      !built.request.subitems?.labels.length);
  const newColumnTitles = [...(built?.request.columns ?? []), ...(built?.request.subitems?.columns ?? [])].map(
    (c) => c.title,
  );

  const write = useMutation({
    mutationFn: async () => {
      const client = api(accountId);
      // Invitations first (decision 4): they are sent, the cells still skip the people until they join.
      const byRole = new Map<string, string[]>();
      for (const [name, role] of Object.entries(invites))
        if (role !== 'skip' && canInvite(name)) byRole.set(role, [...(byRole.get(role) ?? []), name.trim()]);
      for (const [role, emails] of byRole) await client.post('/users/invite', { emails, role });
      // Replacing secrets may need a fresh two-factor code first: asked once, then sent again.
      return stepUp.run(() => client.post<BulkEditResult>(`/boards/${board.id}/items/bulk-edit`, built!.request), {
        change: true,
      });
    },
    onSuccess: async (res) => {
      if (!res) return; // the code was not given: nothing was written, the review stays
      const subId = sheet.sub?.boardId;
      await Promise.all([
        qc.invalidateQueries({ queryKey: boardKeys.items(accountId, board.id) }),
        qc.invalidateQueries({ queryKey: boardKeys.board(accountId, board.id) }),
        ...(subId
          ? [
              qc.invalidateQueries({ queryKey: boardKeys.items(accountId, subId) }),
              qc.invalidateQueries({ queryKey: boardKeys.board(accountId, subId) }),
            ]
          : []),
        qc.invalidateQueries({ queryKey: ['account', accountId, 'tags'] }),
      ]);
      onClose();
      // The batch's summary event: its undo (toast, Ctrl+Z, activity log) takes back the whole batch.
      undoToast(
        t('bulk.done', {
          updated: res.updated + res.sub_updated + res.reparented,
          created: res.created + res.sub_created,
        }),
        res.event_id,
      );
    },
    onError: (err) => {
      // The board changed under the draft (someone added a label): reload it; the review is built again.
      if (err instanceof ApiError && err.body.code === 'conflict') {
        void qc.invalidateQueries({ queryKey: boardKeys.board(accountId, board.id) });
        if (sheet.sub) void qc.invalidateQueries({ queryKey: boardKeys.board(accountId, sheet.sub.boardId) });
      }
    },
  });

  const fix = (row: number, columnId: string, which?: 'sub') => {
    const target: Tab = which === 'sub' ? 'sub' : 'main';
    const cols = (target === 'sub' ? subColumns : columns) ?? [];
    setTab(target);
    setStep('sheet');
    setFocus({
      row,
      col: Math.max(
        0,
        cols.findIndex((c) => c.id === columnId),
      ),
    });
  };
  const switchTab = (next: Tab) => {
    if (next === tab) return;
    setFocus(null);
    setTab(next);
  };

  const pickFile = () => fileInput.current?.click();
  const fileField = (
    <input
      ref={fileInput}
      type="file"
      accept={IMPORT_ACCEPT}
      hidden
      data-testid="bulk-import-file"
      onChange={(e) => {
        void openFile(e.target.files?.[0]);
        e.target.value = '';
      }}
    />
  );
  const footer =
    step === 'start' ? (
      <>
        {fileField}
        <Button variant="secondary" className="ms-auto" onClick={() => void close()} data-testid="bulk-cancel">
          {t('common.cancel')}
        </Button>
      </>
    ) : step === 'sheet' ? (
      <>
        <Button variant="secondary" busy={reading} disabled={!bases} onClick={pickFile} data-testid="bulk-import-open">
          {t('bulk.import.button')}
        </Button>
        {fileField}
        <span
          className="me-auto self-center text-xs text-muted"
          data-testid="bulk-status"
          data-changes={changes.length}
        >
          {changes.length
            ? `${t('bulk.changed', { n: changes.length })}${newRows ? ` · ${t('bulk.newRows', { n: newRows })}` : ''}`
            : t('bulk.hint')}
        </span>
        <Button variant="secondary" onClick={() => void close()} data-testid="bulk-cancel">
          {t('common.cancel')}
        </Button>
        <Button variant="accent" disabled={!changes.length} onClick={finish} data-testid="bulk-finish">
          {t('bulk.finish')}
        </Button>
      </>
    ) : step === 'import' ? (
      <>
        <Button
          variant="secondary"
          className="me-auto"
          onClick={() => {
            setImporting(null);
            setStep('sheet');
          }}
          data-testid="bulk-import-back"
        >
          {t('bulk.review.back')}
        </Button>
        <Button variant="accent" disabled={!canApply} onClick={applyImport} data-testid="bulk-import-apply">
          {t('bulk.import.apply')}
        </Button>
      </>
    ) : (
      <>
        <Button variant="secondary" className="me-auto" onClick={() => setStep('sheet')} data-testid="bulk-back">
          {t('bulk.review.back')}
        </Button>
        <Button
          variant="accent"
          busy={write.isPending}
          disabled={tooBig || nothingToWrite}
          onClick={() => write.mutate()}
          data-testid="bulk-approve"
        >
          {t('bulk.review.approve')}
        </Button>
      </>
    );

  const current = tab === 'sub' && subState ? subState : mainState;
  const tabCount = (n: number, label: string) => (n ? `${label} · ${n}` : label);

  return (
    <Dialog
      open
      title={
        step === 'sheet' || step === 'start'
          ? t('bulk.title')
          : step === 'import'
            ? t('bulk.import.title')
            : t('bulk.review.title')
      }
      subtitle={`${board.name} · ${t('bulk.rows', { n: base?.length ?? 0 })} · ${t('bulk.subtitle')}`}
      onClose={() => void close()}
      footer={footer}
      className="h-[calc(100dvh-5rem)] max-w-[min(1440px,calc(100vw-2rem))]!"
    >
      <div
        className="relative flex h-full min-h-[320px] flex-col gap-3"
        data-testid="bulk-sheet"
        data-step={step}
        data-tab={tab}
        onDragOver={onDragOver}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
        }}
        onDrop={onDrop}
      >
        {step === 'start' ? (
          <div className="flex flex-1 items-center justify-center" data-testid="bulk-start">
            <div className="flex w-full max-w-md flex-col items-stretch gap-3 text-center">
              <button
                type="button"
                disabled={!bases || reading}
                onClick={pickFile}
                data-testid="bulk-start-file"
                className="flex flex-col items-center gap-2 rounded-[var(--radius)] border-2 border-dashed border-line-strong px-6 py-10 text-sm text-fg-2 hover:border-primary hover:text-primary disabled:opacity-60"
              >
                <Icon name="upload" size={22} />
                <span className="text-[0.9375rem] font-semibold text-heading">{t('bulk.start.file')}</span>
                <span className="text-xs text-muted">{t('bulk.start.fileHint')}</span>
              </button>
              <Button variant="ghost" disabled={!bases} onClick={() => setStep('sheet')} data-testid="bulk-start-sheet">
                {t('bulk.start.sheet')}
              </Button>
              {!bases ? <p className="text-xs text-muted">{t('bulk.loading')}</p> : null}
            </div>
            {dragOver ? (
              <div
                data-testid="bulk-drop"
                className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center rounded-[var(--radius)] border-2 border-dashed border-primary bg-primary-soft/80 text-sm font-semibold text-heading"
              >
                {t('bulk.import.drop')}
              </div>
            ) : null}
          </div>
        ) : !current ? (
          <SkeletonRows rows={8} label={t('bulk.loading')} />
        ) : step === 'sheet' ? (
          <>
            {subState ? (
              <Tabs<Tab>
                value={tab}
                onChange={switchTab}
                className="-mt-1 shrink-0"
                tabs={[
                  { value: 'main', label: tabCount(mainChanges.length, t('bulk.tab.items')), testId: 'bulk-tab-main' },
                  {
                    value: 'sub',
                    label: tabCount(subChanges.length, `${t('bulk.tab.subitems')} (${subState.base.length})`),
                    testId: 'bulk-tab-sub',
                  },
                ]}
              />
            ) : null}
            <BulkSheet
              key={tab}
              columns={current.columns}
              base={current.base}
              draft={current.draft}
              env={tab === 'sub' ? subSheetEnv : env}
              levels={tab === 'sub' ? parents?.depth : undefined}
              label={tab === 'sub' ? t('bulk.tab.subitems') : t('bulk.tab.items')}
              onChange={(next) => changeTab(tab, next)}
              onUndo={undo}
              onRedo={redo}
              onSkipped={(n) => showToast({ message: t('bulk.pasteSkipped', { n }), seconds: 4 })}
              focus={focus}
            />
            {dragOver ? (
              <div
                data-testid="bulk-drop"
                className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center rounded-[var(--radius)] border-2 border-dashed border-primary bg-primary-soft/80 text-sm font-semibold text-heading"
              >
                {t('bulk.import.drop')}
              </div>
            ) : null}
          </>
        ) : step === 'import' && importing && importState ? (
          <div className="min-h-0 flex-1 overflow-auto">
            <BulkImportPanel
              tables={importing.tables}
              fileName={importing.fileName}
              columns={importState.columns}
              base={importState.base}
              plan={importPlan!}
              mapping={importing.mapping}
              onMapping={(mapping) => setImporting((x) => (x ? { ...x, mapping } : x))}
            />
          </div>
        ) : review ? (
          <div className="min-h-0 flex-1 space-y-3 overflow-auto">
            <BulkReviewPanel
              review={review}
              columns={allColumns}
              decisions={decisions}
              onDecisions={setDecisions}
              invites={invites}
              onInvites={setInvites}
              onFix={fix}
              skipped={built?.skipped ?? 0}
              sheets={!!subState}
              replaceSecrets={replaceSecrets}
              onReplaceSecrets={setReplaceSecrets}
            />
            {newColumnTitles.length ? (
              <div className="mx-auto w-full max-w-3xl" data-testid="bulk-review-columns">
                <Notice tone="info">{t('bulk.review.newColumns', { names: newColumnTitles.join(', ') })}</Notice>
              </div>
            ) : null}
            {tooBig ? (
              <div className="mx-auto w-full max-w-3xl">
                <Notice tone="error">
                  <span data-testid="bulk-too-big">
                    {t('bulk.tooBig', {
                      mb: (built!.bytes / 1024 / 1024).toFixed(1),
                      max: BULK_EDIT_MAX_BYTES / 1024 / 1024,
                    })}
                  </span>
                </Notice>
              </div>
            ) : null}
            {write.isError ? (
              <div className="mx-auto w-full max-w-3xl">
                <Notice tone="error">
                  {write.error instanceof ApiError && write.error.body.code === 'conflict'
                    ? t('bulk.labelsChanged')
                    : errorMessage(write.error)}
                </Notice>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      {stepUp.dialog}
    </Dialog>
  );
};

/** New rows of a sheet that hold some text. */
const countNew = (list: { row: number }[], loaded: number) =>
  new Set(list.filter((c) => c.row >= loaded).map((c) => c.row)).size;

/** The review of both sheets (the subitems one with its parents resolved). */
const reviewBoth = (main: SheetState, sub: SheetState | null, env: BulkEnv, subSheetEnv: BulkEnv) => {
  const r = reviewDraft(main.base, main.draft, main.columns, env);
  return sub ? mergeReviews(r, reviewSubitems(sub, subSheetEnv)) : r;
};

/** The entries of `prev` whose keys are still asked about. */
const pick = <V,>(prev: Record<string, V>, keys: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(prev).filter(([k]) => k in keys));
