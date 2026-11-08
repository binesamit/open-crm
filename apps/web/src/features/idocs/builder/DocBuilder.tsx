// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  IDOC_GROUP_LABELS,
  IDOC_GROUPS,
  IDOC_PRESETS,
  idocPreset,
  newId,
  sectionFromPreset,
  t,
  type IdocDoc,
  type IdocSection,
  type IdocSettings,
  type MessageKey,
} from '@bines/shared';
import { Badge, Button, cn, Dialog, Menu, Segmented, SkeletonRows, useActionMenu, type MenuEntry } from '@bines/ui';
import { api, errorMessage } from '../../../lib/api';
import { Icon } from '../../../lib/icons';
import { showToast } from '../../../lib/toast';
import { useBoard } from '../../board/board-api';
import { idocKeys, previewDoc, useDocMutations, useTemplateMutations } from '../idocs-api';
import { DocView } from '../render/DocView';
import { PdfButton } from '../PdfButton';
import { ShareLinkButton } from '../ShareLink';
import { B, IconBtn } from './fields';
import { DocSettingsForm } from './DocSettingsForm';
import { SectionForm } from './SectionForm';

/**
 * The document builder (canvas part 2): the sections on the start side (drag to reorder, add from the catalog), the
 * page as the client will see it in the middle (with the item's real data, unsaved changes included), the selected
 * section's settings — or the document's — on the end side. Saves the document; can save it as / update a template.
 */
export const sectionLabel = (s: IdocSection) => {
  const title = 'title' in s && typeof s.title === 'string' ? s.title : '';
  const preset = s.preset ? idocPreset(s.preset) : undefined;
  // A title made only of merge fields ("{item.name}") reads as the section's name in the list.
  const readable = title.replace(/\{[^}]*\}/g, '').trim() ? title : '';
  return readable || preset?.label.he || t(`idoc.kind.${s.kind}` as MessageKey);
};

export const DocBuilder = ({
  accountId,
  itemId,
  boardId,
  docId,
  onClose,
}: {
  accountId: string;
  itemId: string;
  boardId: string;
  docId: string;
  onClose: () => void;
}) => {
  const doc = useQuery({
    queryKey: idocKeys.doc(accountId, docId),
    queryFn: () => api(accountId).get<IdocDoc>(`/idocs/${docId}`),
  });
  if (!doc.data)
    return (
      <Shell onClose={onClose} title="…">
        <div className="p-6">
          <SkeletonRows rows={8} label="…" />
        </div>
      </Shell>
    );
  return <Builder accountId={accountId} itemId={itemId} boardId={boardId} doc={doc.data} onClose={onClose} />;
};

const Shell = ({
  title,
  onClose,
  children,
  actions,
}: {
  title: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) => (
  <div
    className="fixed inset-0 z-modal flex flex-col bg-bg"
    role="dialog"
    aria-modal="true"
    aria-label={B('editorTitle')}
    data-testid="idoc-builder"
  >
    <header
      className="flex items-center gap-3 border-b border-line bg-surface px-4 py-2.5"
      style={{ paddingTop: 'max(0.625rem, env(safe-area-inset-top))' }}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label={B('close')}
        className="grid size-8 place-items-center rounded-[var(--radius-sm)] text-muted hover:bg-surface-2 hover:text-fg"
        data-testid="idoc-builder-close"
      >
        <Icon name="x" size={16} />
      </button>
      <div className="min-w-0 flex-1">{title}</div>
      {actions}
    </header>
    {children}
  </div>
);

const Builder = ({
  accountId,
  itemId,
  boardId,
  doc,
  onClose,
}: {
  accountId: string;
  itemId: string;
  boardId: string;
  doc: IdocDoc;
  onClose: () => void;
}) => {
  const [name, setName] = useState(doc.name);
  const [sections, setSections] = useState<IdocSection[]>(doc.sections);
  const [settings, setSettings] = useState<IdocSettings>(doc.settings);
  const [selected, setSelected] = useState<string | null>(doc.sections[0]?.id ?? null);
  const [pane, setPane] = useState<'section' | 'doc'>('section');
  const [mobile, setMobile] = useState<'list' | 'preview' | 'settings'>('preview');
  const [dirty, setDirty] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const m = useDocMutations(accountId, itemId);
  const tm = useTemplateMutations(accountId);
  const board = useBoard(accountId, boardId).data;
  const subBoard = useBoard(accountId, board?.subitems_board_id ?? '').data;
  const locked = doc.status === 'signed' && doc.settings.lock_after_sign;

  // The preview follows the edits after a short pause (the server resolves the item's data).
  // Whose default look the preview shows: the client's (a guest) or a member's.
  const [audience, setAudience] = useState<'guests' | 'members'>('guests');
  const [draft, setDraft] = useState({ sections, settings });
  useEffect(() => {
    const id = setTimeout(() => setDraft({ sections, settings }), 600);
    return () => clearTimeout(id);
  }, [sections, settings]);
  const preview = useQuery({
    queryKey: ['account', accountId, 'idoc', doc.id, 'preview', JSON.stringify(draft), audience],
    queryFn: () => previewDoc(accountId, doc.id, { ...draft, audience }),
    placeholderData: (prev) => prev,
    staleTime: 30_000,
  });

  const change = (next: IdocSection[]) => {
    setSections(next);
    setDirty(true);
  };
  const patchSection = (id: string, next: IdocSection) => change(sections.map((s) => (s.id === id ? next : s)));
  const add = (presetKey: string) => {
    const s = sectionFromPreset(presetKey, newId().slice(-10).toLowerCase());
    if (!s) return;
    const at = selected ? sections.findIndex((x) => x.id === selected) + 1 : sections.length;
    change([...sections.slice(0, at), s, ...sections.slice(at)]);
    setSelected(s.id);
    setPane('section');
    setMobile('settings');
  };
  const save = () =>
    m.save.mutate(
      { id: doc.id, name, sections, settings },
      {
        onSuccess: () => {
          setDirty(false);
          showToast({ message: B('saved'), seconds: 2 });
        },
        onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
      },
    );
  const updateTemplate = () =>
    doc.template_id &&
    tm.save.mutate(
      { id: doc.template_id, sections, settings },
      {
        onSuccess: () => showToast({ message: B('templateUpdated'), seconds: 3 }),
        onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
      },
    );
  const current = sections.find((s) => s.id === selected) ?? null;

  const catalog = useActionMenu();
  const catalogItems: MenuEntry[] = IDOC_GROUPS.flatMap((g) => [
    { kind: 'label' as const, label: IDOC_GROUP_LABELS[g].he },
    ...IDOC_PRESETS.filter((p) => p.group === g).map((p) => ({
      label: p.label.he,
      hint: p.soon ? B('soon') : p.description.he,
      keywords: `${p.label.en} ${p.description.he}`,
      disabled: !!p.soon,
      testId: `idoc-add-${p.key}`,
      onSelect: () => add(p.key),
    })),
  ]);

  const pick = (id: string) => {
    setSelected(id);
    setPane('section');
    setMobile('settings');
  };
  const list = (
    <SectionList
      sections={sections}
      selected={selected}
      onSelect={pick}
      onChange={change}
      onAdd={catalog.fromTrigger}
    />
  );
  const previewPane = (
    <div className="grid gap-3 p-3 sm:p-6" data-testid="idoc-preview">
      <Segmented
        label={B('previewAs')}
        value={audience}
        onChange={setAudience}
        className="justify-self-center"
        options={[
          { value: 'guests' as const, label: B('previewGuest') },
          { value: 'members' as const, label: B('previewMember') },
        ]}
      />
      {preview.data ? (
        <div className="mx-auto max-w-[860px] overflow-hidden rounded-[var(--radius-panel)] bg-surface shadow-[var(--shadow-panel)]">
          <DocView
            key={JSON.stringify(draft).length + preview.dataUpdatedAt}
            doc={preview.data}
            testId="idoc-preview-page"
            showEmpty
            pick={{
              selected: pane === 'section' ? selected : null,
              onSelect: pick,
              label: (id) => {
                const s = sections.find((x) => x.id === id);
                return B('editSection', { name: s ? sectionLabel(s) : '' });
              },
            }}
          />
        </div>
      ) : preview.isError ? (
        <p className="text-sm text-danger-fg">{errorMessage(preview.error)}</p>
      ) : (
        <SkeletonRows rows={8} label="…" />
      )}
    </div>
  );
  const settingsPane = (
    <div className="p-4">
      <Segmented
        label={B('settings')}
        value={pane}
        onChange={setPane}
        options={[
          { value: 'section', label: B('sectionTab'), testId: 'idoc-pane-section' },
          { value: 'doc', label: B('docTab'), testId: 'idoc-pane-doc' },
        ]}
        className="mb-4"
      />
      {pane === 'doc' ? (
        <DocSettingsForm
          accountId={accountId}
          settings={settings}
          columns={board?.columns ?? []}
          onChange={(s) => {
            setSettings(s);
            setDirty(true);
          }}
        />
      ) : current ? (
        <SectionForm
          key={current.id}
          accountId={accountId}
          section={current}
          board={board}
          subBoard={subBoard}
          sections={sections}
          onChange={(next) => patchSection(current.id, next)}
        />
      ) : (
        <p className="text-sm text-muted">{B('pickSection')}</p>
      )}
    </div>
  );

  return (
    <Shell
      onClose={() => (dirty ? setConfirmClose(true) : onClose())}
      title={
        <div className="flex min-w-0 items-center gap-2">
          <input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setDirty(true);
            }}
            aria-label={B('docName')}
            className="min-w-0 flex-1 truncate rounded-[8px] bg-transparent px-1.5 py-1 font-[family-name:var(--font-display)] text-[0.95rem] text-heading hover:bg-surface-2 focus:bg-surface-2 focus:outline-none"
            data-testid="idoc-builder-name"
          />
          <Badge tone={doc.status === 'signed' ? 'ok' : 'neutral'}>
            {t(`idoc.status.${doc.status}` as MessageKey)}
          </Badge>
        </div>
      }
      actions={
        <div className="flex shrink-0 items-center gap-1.5">
          <ShareLinkButton accountId={accountId} itemId={itemId} doc={doc} />
          <PdfButton accountId={accountId} doc={doc} stale={dirty} className="hidden sm:inline-flex" />
          {doc.template_id ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={updateTemplate}
              busy={tm.save.isPending}
              className="hidden sm:inline-flex"
            >
              {B('updateTemplate')}
            </Button>
          ) : null}
          <Button
            size="sm"
            onClick={save}
            busy={m.save.isPending}
            disabled={!dirty || locked}
            data-testid="idoc-builder-save"
          >
            {B('save')}
          </Button>
        </div>
      }
    >
      {locked ? <div className="bg-ok-soft px-4 py-2 text-sm text-ok-fg">{B('lockedSigned')}</div> : null}
      <div className="flex justify-center border-b border-line bg-surface p-2 lg:hidden">
        <Segmented
          label={B('view')}
          value={mobile}
          onChange={setMobile}
          options={[
            { value: 'list', label: B('sections') },
            { value: 'preview', label: B('preview') },
            { value: 'settings', label: B('settings') },
          ]}
        />
      </div>
      {/* One row capped at the space left (product owner: "the left side does not scroll"): each pane scrolls on its
          own, on desktop (three panes) and phones (one at a time). Each pane is a named, focusable region so the keyboard
          scrolls it too. */}
      <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] lg:grid-cols-[17rem_minmax(0,1fr)_22rem]">
        <section
          aria-label={B('sections')}
          tabIndex={0}
          data-testid="idoc-pane-list"
          className={cn(
            'min-h-0 overflow-y-auto overscroll-contain border-line bg-surface focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--focus-ring)] lg:block lg:border-e',
            mobile === 'list' ? 'block' : 'hidden',
          )}
        >
          {list}
        </section>
        <section
          aria-label={B('preview')}
          tabIndex={0}
          className={cn(
            'min-h-0 overflow-y-auto overscroll-contain bg-bg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--focus-ring)] lg:block',
            mobile === 'preview' ? 'block' : 'hidden',
          )}
        >
          {previewPane}
        </section>
        <section
          aria-label={B('settings')}
          tabIndex={0}
          data-testid="idoc-pane-settings"
          className={cn(
            'min-h-0 overflow-y-auto overscroll-contain border-line bg-surface focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--focus-ring)] lg:block lg:border-s',
            mobile === 'settings' ? 'block' : 'hidden',
          )}
        >
          {settingsPane}
        </section>
      </div>
      <Menu
        at={catalog.at}
        onClose={catalog.close}
        items={catalogItems}
        label={B('addSection')}
        searchable
        testId="idoc-catalog"
      />
      <Dialog
        open={confirmClose}
        onClose={() => setConfirmClose(false)}
        role="alertdialog"
        title={B('unsavedTitle')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmClose(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger-outline" onClick={onClose} data-testid="idoc-discard">
              {B('discard')}
            </Button>
            <Button
              onClick={() => {
                setConfirmClose(false);
                m.save.mutate({ id: doc.id, name, sections, settings }, { onSuccess: onClose });
              }}
            >
              {B('saveAndClose')}
            </Button>
          </>
        }
      >
        <p className="text-sm text-fg-2">{B('unsavedText')}</p>
      </Dialog>
    </Shell>
  );
};

const SectionList = ({
  sections,
  selected,
  onSelect,
  onChange,
  onAdd,
}: {
  sections: IdocSection[];
  selected: string | null;
  onSelect: (id: string) => void;
  onChange: (next: IdocSection[]) => void;
  onAdd: (e: React.MouseEvent<HTMLElement>) => void;
}) => {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const from = sections.findIndex((s) => s.id === e.active.id);
    const to = sections.findIndex((s) => s.id === e.over!.id);
    onChange(arrayMove(sections, from, to));
  };
  const ids = useMemo(() => sections.map((s) => s.id), [sections]);
  return (
    <div className="grid gap-3 p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted">{B('sectionsCount', { n: sections.length })}</span>
        <Button size="sm" variant="secondary" onClick={onAdd} data-testid="idoc-add-section">
          <Icon name="plus" size={13} />
          {B('addSection')}
        </Button>
      </div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <ul className="grid gap-1.5" data-testid="idoc-section-list">
            {sections.map((s) => (
              <SortableSection
                key={s.id}
                section={s}
                active={s.id === selected}
                onSelect={() => onSelect(s.id)}
                onToggle={() =>
                  onChange(sections.map((x) => (x.id === s.id ? ({ ...x, hidden: !x.hidden } as IdocSection) : x)))
                }
                onDuplicate={() => {
                  const i = sections.findIndex((x) => x.id === s.id);
                  const copy = { ...structuredClone(s), id: newId().slice(-10).toLowerCase() } as IdocSection;
                  onChange([...sections.slice(0, i + 1), copy, ...sections.slice(i + 1)]);
                }}
                onRemove={() => onChange(sections.filter((x) => x.id !== s.id))}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
    </div>
  );
};

const SortableSection = ({
  section,
  active,
  onSelect,
  onToggle,
  onDuplicate,
  onRemove,
}: {
  section: IdocSection;
  active: boolean;
  onSelect: () => void;
  onToggle: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
}) => {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: section.id,
  });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-testid="idoc-section-row"
      data-kind={section.kind}
      data-section={section.id}
      className={cn(
        'grid grid-cols-[auto_1fr_auto] items-center gap-1.5 rounded-[var(--radius-sm)] border px-1.5 py-1.5 text-[0.8125rem]',
        active ? 'border-primary bg-primary-soft' : 'border-line bg-surface hover:bg-surface-2',
        isDragging && 'relative z-10 shadow-[var(--shadow-pop)]',
        section.hidden && 'opacity-55',
      )}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-label={B('drag')}
        className="cursor-grab px-0.5 text-muted active:cursor-grabbing"
      >
        ⋮⋮
      </button>
      <button type="button" onClick={onSelect} aria-current={active || undefined} className="min-w-0 text-start">
        <span className="block truncate text-fg">{sectionLabel(section)}</span>
        <span className={cn('block truncate text-[0.7rem]', active ? 'text-fg-2' : 'text-muted')}>
          {t(`idoc.kind.${section.kind}` as MessageKey)}
        </span>
      </button>
      <span className="flex">
        <IconBtn
          label={section.hidden ? B('show') : B('hide')}
          icon={section.hidden ? 'eyeOff' : 'eye'}
          onClick={onToggle}
        />
        <IconBtn label={B('duplicate')} icon="duplicate" onClick={onDuplicate} />
        <IconBtn label={B('remove')} icon="trash" onClick={onRemove} />
      </span>
    </li>
  );
};
