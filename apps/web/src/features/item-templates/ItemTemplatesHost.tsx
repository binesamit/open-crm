// SPDX-License-Identifier: AGPL-3.0-only
import { t, type MyAccount } from '@bines/shared';
import { Button, Dialog, SkeletonRows } from '@bines/ui';
import { confirmDelete } from '../../lib/dialogs';
import { useBoard } from '../board/board-api';
import { ApplyTemplateDialog } from './ApplyTemplateDialog';
import { useItemTemplateMutations, useItemTemplates } from './item-templates-api';
import { SaveTemplateDialog } from './SaveTemplateDialog';
import { closeItemTemplates, openItemTemplates, useItemTemplatesView } from './store';
import { TemplateEditor } from './TemplateEditor';

/** A board's templates: make an item from one, edit, delete, or start a new one. */
const ManageDialog = ({ accountId, boardId }: { accountId: string; boardId: string }) => {
  const list = useItemTemplates(accountId, boardId);
  const board = useBoard(accountId, boardId).data;
  const m = useItemTemplateMutations(accountId, boardId);
  const canEdit = !!board?.capabilities['column.create'];
  return (
    <Dialog
      open
      onClose={closeItemTemplates}
      title={t('itemTemplates.manageTitle')}
      subtitle={board?.name}
      footer={
        <>
          <Button variant="ghost" onClick={closeItemTemplates}>
            {t('common.close')}
          </Button>
          {canEdit ? (
            <Button
              onClick={() => openItemTemplates({ kind: 'edit', boardId, templateId: null })}
              data-testid="item-template-new"
            >
              + {t('itemTemplates.newTemplate')}
            </Button>
          ) : null}
        </>
      }
    >
      <div data-testid="item-template-manage">
        {list.isPending ? (
          <SkeletonRows rows={4} label={t('app.loading')} />
        ) : !list.data?.length ? (
          <p className="text-sm text-muted">{t('itemTemplates.noneYet')}</p>
        ) : (
          <ul className="divide-y divide-line-soft">
            {list.data.map((x) => (
              <li
                key={x.id}
                className="flex flex-wrap items-center gap-2 py-2"
                data-testid="item-template-row"
                data-name={x.name}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-fg">{x.name}</span>
                  <span className="block text-xs text-muted">
                    {x.category ? `${x.category} · ` : ''}
                    {t('itemTemplates.items', { n: x.nodes })} · {t('itemTemplates.version', { n: x.version })}
                  </span>
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => openItemTemplates({ kind: 'apply', boardId, templateId: x.id })}
                >
                  {t('itemTemplates.create')}
                </Button>
                {canEdit ? (
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => openItemTemplates({ kind: 'edit', boardId, templateId: x.id })}
                      data-testid="item-template-edit"
                    >
                      {t('itemTemplates.edit')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-danger-fg"
                      onClick={() =>
                        void confirmDelete(x.name).then((ok) => ok && m.remove.mutate({ id: x.id, name: x.name }))
                      }
                    >
                      {t('menu.delete')}
                    </Button>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
};

/** Mounted once in the shell: whichever item-template screen was opened (save, apply, manage, edit). */
export const ItemTemplatesHost = ({ account }: { account: MyAccount }) => {
  const view = useItemTemplatesView();
  if (!view) return null;
  switch (view.kind) {
    case 'save':
      return (
        <SaveTemplateDialog
          accountId={account.id}
          boardId={view.boardId}
          itemId={view.itemId}
          itemName={view.itemName}
          onClose={closeItemTemplates}
        />
      );
    case 'apply':
      return (
        <ApplyTemplateDialog
          accountId={account.id}
          boardId={view.boardId}
          templateId={view.templateId}
          groupId={view.groupId}
          parentItemId={view.parentItemId}
          onClose={closeItemTemplates}
        />
      );
    case 'manage':
      return <ManageDialog accountId={account.id} boardId={view.boardId} />;
    case 'edit':
      return (
        <TemplateEditor
          accountId={account.id}
          boardId={view.boardId}
          templateId={view.templateId}
          onClose={() => openItemTemplates({ kind: 'manage', boardId: view.boardId })}
        />
      );
  }
};
