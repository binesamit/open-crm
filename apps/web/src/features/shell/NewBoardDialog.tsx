// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { t, type BoardDetail, type MessageKey, type MyAccount } from '@bines/shared';
import { Button, Dialog, Field, Input, Notice, Picker, RadioCard } from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { Icon } from '../../lib/icons';
import { boardKeys, type WorkspaceTree } from '../board/board-api';
import { addBoardToTree } from './tree-cache';

/**
 * "בורד חדש" (F4 canvas Dlg-NewBoard, N13): name, template + folder side by side (stacked on phones), the board kind
 * as radio cards. Opened from the "+" next to the workspace heading and from a folder's "new board here".
 */
type Kind = 'main' | 'private' | 'shareable';

// The same icons as the board kinds elsewhere (building / lock / people).
const KINDS: { kind: Kind; icon: ReactNode }[] = [
  { kind: 'main', icon: <Icon name="building" size={15} /> },
  { kind: 'private', icon: <Icon name="lock" size={15} /> },
  { kind: 'shareable', icon: <Icon name="people" size={15} /> },
];

export const NewBoardDialog = ({
  account,
  tree,
  folderId: initialFolder,
  fromTemplate = false,
  onClose,
}: {
  account: MyAccount;
  tree: WorkspaceTree;
  folderId: string | null;
  /** "בורד מתבנית" (Fix: , the "+" menu): a template is chosen (the first one until another is picked). */
  fromTemplate?: boolean;
  onClose: () => void;
}) => {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const templates = useQuery({
    queryKey: boardKeys.templates(account.id),
    queryFn: () => api(account.id).get<{ data: { key: string; name: string }[] }>('/templates'),
  });
  const [name, setName] = useState('');
  const [folderId, setFolderId] = useState(initialFolder ?? '');
  // undefined = not picked yet: "empty board", or — from a template — the first template.
  const [picked, setTemplate] = useState<string | undefined>(undefined);
  const template = picked ?? (fromTemplate ? (templates.data?.data[0]?.key ?? '') : '');
  const [kind, setKind] = useState<Kind>('main');
  const create = useMutation({
    mutationFn: () =>
      api(account.id).post<BoardDetail>('/boards', {
        name: name.trim() || undefined,
        workspace_id: tree.workspace.id,
        folder_id: folderId || null,
        template_key: template || undefined,
        kind,
      }),
    onSuccess: async (board) => {
      // Shown in the sidebar at once (s4f-side): only the new row renders; the reload behind it confirms the tree.
      addBoardToTree(qc, account.id, board);
      void qc.invalidateQueries({ queryKey: ['account', account.id, 'tree'] });
      onClose();
      await navigate({ to: '/a/$accountSlug/b/$boardId', params: { accountSlug: account.slug, boardId: board.id } });
    },
  });
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!create.isPending) create.mutate();
  };
  // Folder paths ("01 · מכירות / ארכיון"), so nested folders with the same name stay apart.
  const pathOf = (f: WorkspaceTree['folders'][number]): string => {
    const parent = tree.folders.find((p) => p.id === f.parent_folder_id);
    return parent ? `${pathOf(parent)} / ${f.name}` : f.name;
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={fromTemplate ? t('sidebar.add.fromTemplate') : t('board.new')}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose} data-testid="new-board-cancel">
            {t('common.cancel')}
          </Button>
          <Button
            type="submit"
            form="new-board-form"
            variant="accent"
            busy={create.isPending}
            data-testid="new-board-submit"
          >
            {t('board.create')}
          </Button>
        </>
      }
    >
      <form
        id="new-board-form"
        data-testid="new-board-dialog"
        data-mode={fromTemplate ? 'template' : 'blank'}
        className="space-y-3.5"
        onSubmit={onSubmit}
      >
        <Field label={t('board.new.name')}>
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            data-testid="new-board-name"
            className="h-11 w-full text-[0.9375rem]"
          />
        </Field>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label={t('board.new.template')}>
            <Picker
              label={t('board.new.template')}
              value={template}
              onChange={setTemplate}
              testId="new-board-template"
              options={[
                ...(fromTemplate ? [] : [{ value: '', label: t('board.new.empty') }]),
                ...(templates.data?.data.map((tp) => ({
                  value: tp.key,
                  label: tp.name,
                  testId: 'new-board-template-option',
                })) ?? []),
              ]}
            />
          </Field>
          <Field label={t('board.new.folder')}>
            <Picker
              label={t('board.new.folder')}
              value={folderId}
              onChange={setFolderId}
              testId="new-board-folder"
              options={[
                { value: '', label: t('board.new.noFolder') },
                ...tree.folders
                  .map((f) => ({ value: f.id, label: pathOf(f) }))
                  .sort((a, b) => a.label.localeCompare(b.label)),
              ]}
            />
          </Field>
        </div>
        <fieldset className="space-y-1.5">
          <legend className="mb-1.5 text-xs font-semibold text-fg-2">{t('board.new.kind')}</legend>
          <div className="flex flex-col gap-2">
            {KINDS.map((k) => (
              <RadioCard
                key={k.kind}
                name="new-board-kind"
                checked={kind === k.kind}
                onSelect={() => setKind(k.kind)}
                icon={k.icon}
                title={t(`board.kind.${k.kind}.title` as MessageKey)}
                hint={t(`board.kind.${k.kind}.hint` as MessageKey)}
                testId={`new-board-kind-${k.kind}`}
              />
            ))}
          </div>
        </fieldset>
        {create.isError ? <Notice tone="error">{errorMessage(create.error)}</Notice> : null}
      </form>
    </Dialog>
  );
};
