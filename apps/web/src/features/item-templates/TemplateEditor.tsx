// SPDX-License-Identifier: AGPL-3.0-only
import { useRef, useState } from 'react';
import {
  columnTypes,
  ITEM_TEMPLATE_VAR_TYPES,
  ownWriter,
  t,
  type ItemTemplateCell,
  type ItemTemplateDto,
  type ItemTemplateNode,
  type ItemTemplateUpdate,
  type ItemTemplateVariable,
  type MessageKey,
} from '@bines/shared';
import { Button, cn, Dialog, Input, Notice, Picker, SkeletonRows, Switch } from '@bines/ui';
import { errorMessage } from '../../lib/api';
import { confirmDialog } from '../../lib/dialogs';
import { Icon } from '../../lib/icons';
import { columnTypeLabel } from '../../lib/locale';
import { showToast } from '../../lib/toast';
import { uploadFile } from '../../lib/upload';
import { type Column, useBoard, useMembers } from '../board/board-api';
import { useItemTemplate, useItemTemplateMutations } from './item-templates-api';
import {
  addChild,
  findNode,
  flatten,
  indentNode,
  locate,
  mapNode,
  moveNode,
  newNode,
  outdentNode,
  removeNode,
} from './tree';

type Kind = ItemTemplateCell['kind'] | 'empty';

/** Columns a template can set: plain cells (no computed, no relations), and file columns. */
const settable = (c: Column) => {
  const def = columnTypes.get(c.type);
  if (!def) return false;
  if (def.engine === 'files') return true;
  return def.storage === 'cell' && !def.readOnly && !ownWriter(def) && def.engine !== 'links' && c.type !== 'name';
};
const isDate = (c: Column) => c.type === 'date' || c.type === 'timeline';
const isText = (c: Column) => c.type === 'text' || c.type === 'long_text';
const kindsFor = (c: Column): Kind[] =>
  columnTypes.get(c.type)?.engine === 'files'
    ? ['empty', 'files']
    : [
        'empty',
        'value',
        ...(isDate(c) ? (['date'] as const) : []),
        ...(isDate(c) || isText(c) || c.type === 'people' ? (['var'] as const) : []),
        ...(isText(c) ? (['text'] as const) : []),
      ];

/** A cell's stored value as words (the column type's own text). */
const valueText = (c: Column, value: unknown, names: (id: string) => string | undefined) => {
  try {
    return columnTypes.get(c.type)?.toText(value as never, c.settings as never, { userName: names }) || '—';
  } catch {
    return '—';
  }
};

const FileList = ({
  files,
  onChange,
  accountId,
  testId,
}: {
  files: { asset_id: string; name: string }[];
  onChange: (f: { asset_id: string; name: string }[]) => void;
  accountId: string;
  testId: string;
}) => {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid={testId}>
      {files.map((f) => (
        <span key={f.asset_id} className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2.5 py-1 text-xs">
          <Icon name="file" size={12} />
          {f.name}
          <button
            type="button"
            aria-label={t('itemTemplates.removeFile', { name: f.name })}
            className="text-muted hover:text-danger-fg"
            onClick={() => onChange(files.filter((x) => x.asset_id !== f.asset_id))}
          >
            ✕
          </button>
        </span>
      ))}
      <button
        type="button"
        disabled={busy}
        onClick={() => input.current?.click()}
        className="rounded-full border border-dashed border-line-strong px-2.5 py-1 text-xs text-primary disabled:opacity-50"
      >
        + {t('itemTemplates.addFile')}
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={async (e) => {
          const chosen = [...(e.target.files ?? [])];
          e.target.value = '';
          if (!chosen.length) return;
          setBusy(true);
          try {
            const up = await Promise.all(chosen.map((f) => uploadFile(accountId, f)));
            onChange([...files, ...up.map((u) => ({ asset_id: u.id, name: u.name }))]);
          } catch (err) {
            showToast({ message: errorMessage(err), tone: 'error' });
          } finally {
            setBusy(false);
          }
        }}
      />
    </div>
  );
};

const CellRow = ({
  column,
  spec,
  vars,
  onChange,
  accountId,
  names,
}: {
  column: Column;
  spec: ItemTemplateCell | undefined;
  vars: ItemTemplateVariable[];
  onChange: (s: ItemTemplateCell | undefined) => void;
  accountId: string;
  names: (id: string) => string | undefined;
}) => {
  const kind: Kind = spec?.kind ?? 'empty';
  const dateVars = vars.filter((v) => v.type === 'date');
  const fit = vars.filter((v) =>
    column.type === 'people' ? v.type === 'person' : isDate(column) ? v.type === 'date' : v.type === 'text',
  );
  const setKind = (k: Kind) => {
    if (k === 'empty') return onChange(undefined);
    if (k === 'value') return onChange({ kind: 'value', value: spec?.kind === 'value' ? spec.value : null });
    if (k === 'date')
      return onChange({ kind: 'date', var: dateVars[0]?.key ?? 'start', from: 0, to: null, time: null });
    if (k === 'var') return onChange({ kind: 'var', var: fit[0]?.key ?? '' });
    if (k === 'text') return onChange({ kind: 'text', text: '' });
    return onChange({ kind: 'files', files: [] });
  };
  return (
    <div
      className="grid grid-cols-1 items-start gap-2 border-b border-line-soft py-2 sm:grid-cols-[9rem_10rem_minmax(0,1fr)]"
      data-testid="item-template-cell"
      data-column={column.id}
    >
      <span className="truncate pt-1.5 text-sm text-fg" title={columnTypeLabel(column.type)}>
        {column.title}
      </span>
      <Picker
        label={t('itemTemplates.valueKind', { column: column.title })}
        value={kind}
        options={kindsFor(column).map((k) => ({ value: k, label: t(`itemTemplates.kind.${k}` as MessageKey) }))}
        onChange={setKind}
        testId={`item-template-kind-${column.id}`}
      />
      <div className="min-w-0">
        {spec?.kind === 'value' ? (
          isText(column) || column.type === 'numbers' ? (
            <Input
              value={
                spec.value == null
                  ? ''
                  : column.type === 'long_text'
                    ? String((spec.value as { text?: string }).text ?? '')
                    : String(spec.value)
              }
              inputMode={column.type === 'numbers' ? 'decimal' : undefined}
              onChange={(e) =>
                onChange({
                  kind: 'value',
                  value:
                    column.type === 'long_text'
                      ? { text: e.target.value }
                      : column.type === 'numbers'
                        ? e.target.value === ''
                          ? null
                          : Number(e.target.value)
                        : e.target.value,
                })
              }
            />
          ) : column.type === 'status' ? (
            <Picker
              label={column.title}
              value={String((spec.value as { index?: number } | null)?.index ?? '')}
              options={((column.settings.labels as { id: number; label: string; is_deactivated?: boolean }[]) ?? [])
                .filter((l) => !l.is_deactivated)
                .map((l) => ({ value: String(l.id), label: l.label || '—' }))}
              onChange={(id) => onChange({ kind: 'value', value: { index: Number(id) } })}
            />
          ) : (
            <span className="block truncate pt-1.5 text-sm text-fg-2">{valueText(column, spec.value, names)}</span>
          )
        ) : spec?.kind === 'date' ? (
          <div className="flex flex-wrap items-center gap-1.5 text-sm">
            <Picker
              label={t('itemTemplates.dateVar')}
              value={spec.var}
              options={dateVars.map((v) => ({ value: v.key, label: v.label }))}
              onChange={(v) => onChange({ ...spec, var: v })}
              className="w-36"
            />
            <span className="text-muted">+</span>
            <Input
              value={String(spec.from)}
              inputMode="numeric"
              className="w-16 text-center"
              aria-label={t('itemTemplates.days')}
              onChange={(e) => onChange({ ...spec, from: Number(e.target.value.replace(/[^\d-]/g, '')) || 0 })}
              data-testid={`item-template-from-${column.id}`}
            />
            <span className="text-muted">{t('itemTemplates.workdays')}</span>
            {column.type === 'timeline' ? (
              <>
                <span className="text-muted">{t('itemTemplates.until')}</span>
                <Input
                  value={spec.to == null ? '' : String(spec.to)}
                  inputMode="numeric"
                  className="w-16 text-center"
                  aria-label={t('itemTemplates.untilDays')}
                  onChange={(e) =>
                    onChange({ ...spec, to: e.target.value === '' ? null : Number(e.target.value) || 0 })
                  }
                />
              </>
            ) : null}
          </div>
        ) : spec?.kind === 'var' ? (
          fit.length ? (
            <Picker
              label={t('itemTemplates.variable')}
              value={spec.var}
              options={fit.map((v) => ({ value: v.key, label: v.label }))}
              onChange={(v) => onChange({ kind: 'var', var: v })}
            />
          ) : (
            <span className="block pt-1.5 text-xs text-muted">{t('itemTemplates.noFittingVar')}</span>
          )
        ) : spec?.kind === 'text' ? (
          <Input
            value={spec.text}
            onChange={(e) => onChange({ kind: 'text', text: e.target.value })}
            placeholder={t('itemTemplates.textHint')}
          />
        ) : spec?.kind === 'files' ? (
          <FileList
            files={spec.files}
            accountId={accountId}
            testId={`item-template-files-${column.id}`}
            onChange={(files) => onChange({ kind: 'files', files })}
          />
        ) : (
          <span className="block pt-1.5 text-xs text-muted">{t('itemTemplates.leftEmpty')}</span>
        )}
      </div>
    </div>
  );
};

const UpdatesEditor = ({
  updates,
  onChange,
  accountId,
}: {
  updates: ItemTemplateUpdate[];
  onChange: (u: ItemTemplateUpdate[]) => void;
  accountId: string;
}) => (
  <div className="space-y-2" data-testid="item-template-updates">
    {updates.map((u, i) => (
      <div key={i} className="space-y-2 rounded-[12px] border border-line p-3">
        {u.doc ? <p className="text-xs text-muted">{t('itemTemplates.richUpdate')}</p> : null}
        <textarea
          value={u.text}
          onChange={(e) => onChange(updates.map((x, k) => (k === i ? { ...x, text: e.target.value, doc: null } : x)))}
          rows={3}
          className="w-full rounded-[10px] border border-line-strong bg-surface p-2 text-sm"
          aria-label={t('itemTemplates.updateText')}
          data-testid="item-template-update-text"
        />
        <div className="flex flex-wrap items-center gap-3">
          <FileList
            files={u.files}
            accountId={accountId}
            testId="item-template-update-files"
            onChange={(files) => onChange(updates.map((x, k) => (k === i ? { ...x, files } : x)))}
          />
          <label className="ms-auto flex items-center gap-2 text-xs text-fg-2">
            {t('itemTemplates.pinned')}
            <Switch
              checked={u.pinned}
              onChange={(pinned) => onChange(updates.map((x, k) => (k === i ? { ...x, pinned } : x)))}
            />
          </label>
          <button
            type="button"
            className="text-xs text-danger-fg"
            onClick={() => onChange(updates.filter((_, k) => k !== i))}
          >
            {t('itemTemplates.removeUpdate')}
          </button>
        </div>
      </div>
    ))}
    <Button
      variant="secondary"
      size="sm"
      onClick={() => onChange([...updates, { text: '', doc: null, pinned: false, files: [] }])}
      data-testid="item-template-add-update"
    >
      + {t('itemTemplates.addUpdate')}
    </Button>
  </div>
);

const VariablesEditor = ({
  vars,
  onChange,
}: {
  vars: ItemTemplateVariable[];
  onChange: (v: ItemTemplateVariable[]) => void;
}) => (
  <div className="space-y-2" data-testid="item-template-variables">
    {vars.map((v, i) => (
      <div key={i} className="space-y-1.5 rounded-[12px] border border-line p-2.5">
        <div className="flex items-center gap-1.5">
          <Input
            value={v.label}
            onChange={(e) => onChange(vars.map((x, k) => (k === i ? { ...x, label: e.target.value } : x)))}
            aria-label={t('itemTemplates.varLabel')}
            className="flex-1"
          />
          <button
            type="button"
            aria-label={t('itemTemplates.removeVar', { name: v.label })}
            className="px-1 text-muted hover:text-danger-fg"
            onClick={() => onChange(vars.filter((_, k) => k !== i))}
          >
            ✕
          </button>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted">
          <code dir="ltr">{`{${v.key}}`}</code>
          <Picker
            label={t('itemTemplates.varType')}
            value={v.type}
            options={ITEM_TEMPLATE_VAR_TYPES.map((x) => ({
              value: x,
              label: t(`itemTemplates.varType.${x}` as MessageKey),
            }))}
            onChange={(type) => onChange(vars.map((x, k) => (k === i ? { ...x, type } : x)))}
            className="w-28"
          />
          <label className="ms-auto flex items-center gap-1.5">
            {t('itemTemplates.required')}
            <Switch
              checked={v.required}
              onChange={(required) => onChange(vars.map((x, k) => (k === i ? { ...x, required } : x)))}
            />
          </label>
        </div>
      </div>
    ))}
    <Button
      variant="secondary"
      size="sm"
      onClick={() => {
        let n = vars.length + 1;
        while (vars.some((v) => v.key === `field${n}`)) n++;
        onChange([
          ...vars,
          { key: `field${n}`, label: t('itemTemplates.newVar'), type: 'text', required: false, default: null },
        ]);
      }}
      data-testid="item-template-add-var"
    >
      + {t('itemTemplates.addVar')}
    </Button>
    <p className="text-xs text-muted">{t('itemTemplates.varsHint')}</p>
  </div>
);

const BLANK_VARS: ItemTemplateVariable[] = [
  { key: 'name', label: 'שם', type: 'text', required: true, default: null },
  { key: 'start', label: 'תאריך התחלה', type: 'date', required: true, default: 'today' },
];

/**
 * The template editor (canvas "עורך התבנית"): the tree on the start side (add, rename, reorder
 * indent / outdent at every depth), the chosen item's values per column (the board's columns for the top item, the
 * subitems columns below), its updates and files, and the variables asked when the template is applied.
 */
export const TemplateEditor = ({
  accountId,
  boardId,
  templateId,
  onClose,
}: {
  accountId: string;
  boardId: string;
  templateId: string | null;
  onClose: () => void;
}) => {
  const tpl = useItemTemplate(accountId, templateId);
  if (templateId && !tpl.data)
    return (
      <Dialog open onClose={onClose} title={t('itemTemplates.editorTitle')}>
        {tpl.isError ? (
          <Notice tone="error">{errorMessage(tpl.error)}</Notice>
        ) : (
          <SkeletonRows rows={6} label={t('app.loading')} />
        )}
      </Dialog>
    );
  return <Editor accountId={accountId} boardId={boardId} initial={tpl.data ?? null} onClose={onClose} />;
};

const Editor = ({
  accountId,
  boardId,
  initial,
  onClose,
}: {
  accountId: string;
  boardId: string;
  initial: ItemTemplateDto | null;
  onClose: () => void;
}) => {
  const board = useBoard(accountId, boardId).data;
  const sub = useBoard(accountId, board?.subitems_board_id ?? '').data;
  const members = useMembers(accountId).data?.data ?? [];
  const names = (id: string) => members.find((m) => m.user_id === id)?.name;
  const m = useItemTemplateMutations(accountId, boardId);
  const [name, setName] = useState(initial?.name ?? '');
  const [category, setCategory] = useState(initial?.category ?? '');
  const [root, setRoot] = useState<ItemTemplateNode>(initial?.root ?? { ...newNode('{name}'), id: 'root' });
  const [vars, setVars] = useState<ItemTemplateVariable[]>(initial?.variables ?? BLANK_VARS);
  const [selected, setSelected] = useState(root.id);
  const [dirty, setDirty] = useState(false);
  const change = (next: ItemTemplateNode) => {
    setRoot(next);
    setDirty(true);
  };
  const node = findNode(root, selected) ?? root;
  const where = locate(root, node.id);
  const depth = where?.depth ?? 0;
  const maxDepth = board?.hierarchy_depth_max ?? 2;
  const columns = (depth === 0 ? board?.columns : (sub?.columns ?? board?.columns))?.filter(settable) ?? [];
  const patch = (fn: (n: ItemTemplateNode) => ItemTemplateNode) => change(mapNode(root, node.id, fn));
  const save = () => {
    const body = {
      name: name.trim() || t('itemTemplates.unnamed'),
      category: category.trim(),
      description: '',
      variables: vars,
      root,
    };
    if (initial)
      m.update.mutate(
        { id: initial.id, ...body },
        {
          onSuccess: () => {
            setDirty(false);
            showToast({ message: t('itemTemplates.savedVersion'), seconds: 2 });
          },
        },
      );
    else
      m.create.mutate(body, {
        onSuccess: () => {
          setDirty(false);
          onClose();
        },
      });
  };
  const rows = flatten(root);
  return (
    <div
      className="fixed inset-0 z-modal flex flex-col bg-surface-3"
      role="dialog"
      aria-modal="true"
      aria-label={t('itemTemplates.editorTitle')}
      data-testid="item-template-editor"
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-2.5">
        <button
          type="button"
          onClick={() =>
            dirty
              ? void confirmDialog({
                  title: t('itemTemplates.unsavedTitle'),
                  message: t('itemTemplates.unsavedText'),
                  confirmLabel: t('itemTemplates.discard'),
                  danger: true,
                }).then((ok) => ok && onClose())
              : onClose()
          }
          aria-label={t('common.close')}
          className="grid size-8 place-items-center rounded-[var(--radius-sm)] text-muted hover:bg-surface-2 hover:text-fg"
          data-testid="item-template-editor-close"
        >
          <Icon name="x" size={16} />
        </button>
        <Input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setDirty(true);
          }}
          placeholder={t('itemTemplates.name')}
          aria-label={t('itemTemplates.name')}
          className="min-w-0 max-w-xs flex-1"
          data-testid="item-template-editor-name"
        />
        <Input
          value={category}
          onChange={(e) => {
            setCategory(e.target.value);
            setDirty(true);
          }}
          placeholder={t('itemTemplates.category')}
          aria-label={t('itemTemplates.category')}
          className="w-40"
        />
        <span className="text-xs text-muted">
          {initial ? t('itemTemplates.version', { n: initial.version }) : t('itemTemplates.newTemplate')}
        </span>
        <span className="flex-1" />
        <Button
          busy={m.update.isPending || m.create.isPending}
          disabled={!dirty && !!initial}
          onClick={save}
          data-testid="item-template-editor-save"
        >
          {t('common.save')}
        </Button>
      </header>
      <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] lg:grid-cols-[18rem_minmax(0,1fr)_17rem]">
        <section
          aria-label={t('itemTemplates.structure')}
          className="min-h-0 overflow-y-auto border-line bg-surface p-3 lg:border-e"
          data-testid="item-template-tree"
        >
          <ul className="grid gap-0.5">
            {rows.map(({ node: n, depth: d }) => (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => setSelected(n.id)}
                  aria-current={n.id === node.id || undefined}
                  className={cn(
                    'flex w-full items-center gap-1.5 rounded-[8px] px-2 py-1.5 text-start text-[0.8125rem]',
                    n.id === node.id ? 'bg-primary-soft text-fg' : 'hover:bg-surface-2',
                  )}
                  style={{ paddingInlineStart: `${8 + d * 16}px` }}
                  data-testid="item-template-node"
                  data-name={n.name}
                >
                  <span className="min-w-0 flex-1 truncate">{n.name || t('itemTemplates.unnamed')}</span>
                  {n.children.length ? <span className="text-xs text-muted">{n.children.length}</span> : null}
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap gap-1.5">
            <Button
              size="sm"
              variant="secondary"
              disabled={depth >= maxDepth}
              onClick={() => {
                const c = newNode(t('itemTemplates.newSubitem'));
                change(addChild(root, node.id, c));
                setSelected(c.id);
              }}
              data-testid="item-template-add-child"
            >
              + {t('itemTemplates.addSubitem')}
            </Button>
            {node.id !== root.id ? (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t('itemTemplates.up')}
                  onClick={() => change(moveNode(root, node.id, -1))}
                >
                  ↑
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t('itemTemplates.down')}
                  onClick={() => change(moveNode(root, node.id, 1))}
                >
                  ↓
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t('itemTemplates.indent')}
                  title={t('itemTemplates.indent')}
                  onClick={() => change(indentNode(root, node.id))}
                >
                  ⇤
                </Button>
                {depth > 1 ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t('itemTemplates.outdent')}
                    title={t('itemTemplates.outdent')}
                    onClick={() => change(outdentNode(root, node.id))}
                  >
                    ⇥
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-danger-fg"
                  onClick={() => {
                    const parent = where?.parent?.id ?? root.id;
                    change(removeNode(root, node.id));
                    setSelected(parent);
                  }}
                  data-testid="item-template-remove-node"
                >
                  {t('itemTemplates.removeNode')}
                </Button>
              </>
            ) : null}
          </div>
          <p className="mt-2 text-xs text-muted">{t('itemTemplates.depthHint', { n: maxDepth })}</p>
        </section>
        <section
          aria-label={t('itemTemplates.values')}
          className="min-h-0 space-y-4 overflow-y-auto bg-surface-3 p-4 sm:p-6"
        >
          <label className="block space-y-1.5">
            <span className="text-xs font-semibold text-fg-2">{t('itemTemplates.itemName')}</span>
            <Input
              value={node.name}
              onChange={(e) => patch((n) => ({ ...n, name: e.target.value }))}
              data-testid="item-template-node-name"
            />
            <span className="block text-xs text-muted">{t('itemTemplates.fieldsHint')}</span>
          </label>
          <div className="rounded-[14px] border border-line bg-surface px-3" data-testid="item-template-cells">
            {columns.map((c) => (
              <CellRow
                key={c.id}
                column={c}
                spec={node.cells[c.id]}
                vars={vars}
                accountId={accountId}
                names={names}
                onChange={(spec) =>
                  patch((n) => {
                    const cells = { ...n.cells };
                    if (spec) cells[c.id] = spec;
                    else delete cells[c.id];
                    return { ...n, cells };
                  })
                }
              />
            ))}
          </div>
          <div className="space-y-2">
            <p className="text-sm font-semibold text-heading">{t('itemTemplates.updates')}</p>
            <UpdatesEditor
              updates={node.updates}
              accountId={accountId}
              onChange={(updates) => patch((n) => ({ ...n, updates }))}
            />
          </div>
        </section>
        <aside
          aria-label={t('itemTemplates.variables')}
          className="min-h-0 overflow-y-auto border-line bg-surface p-3 lg:border-s"
        >
          <p className="mb-2 text-sm font-semibold text-heading">{t('itemTemplates.variables')}</p>
          <VariablesEditor
            vars={vars}
            onChange={(v) => {
              setVars(v);
              setDirty(true);
            }}
          />
        </aside>
      </div>
    </div>
  );
};
