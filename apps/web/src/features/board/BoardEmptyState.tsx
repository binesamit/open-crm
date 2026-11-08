// SPDX-License-Identifier: AGPL-3.0-only
import { Link } from '@tanstack/react-router';
import { t } from '@bines/shared';
import { Button, EmptyState } from '@bines/ui';
import { Icon } from '../../lib/icons';
import type { MyAccount } from '../../lib/api';
import { useItemTemplates } from '../item-templates/item-templates-api';
import { openItemTemplates } from '../item-templates/store';

/**
 * The first "+ add item" field of the table (desktop or phone), which the empty state's button focuses; false when
 * there is none (no group yet, or the view has no add row) — the caller then creates the item itself.
 */
export const focusFirstAddItem = () => {
  const field = document.querySelector<HTMLElement>('[data-add-item]');
  if (!field) return false;
  field.scrollIntoView({ block: 'center' });
  // A board that computes names has a "+ new item" button there instead of a field: press it.
  if (field instanceof HTMLButtonElement) field.click();
  else field.focus();
  return true;
};

/**
 * A board with no items yet (11-UI §13; audit 2026-10-10 ux #12): "add a first item" (focuses the table's add field,
 * which stays below) and the way to the templates — Administration › Templates for admins, the home page for
 * everyone else (where the templates are listed). Not shown while a filter or a search hides items.
 */
export const BoardEmptyState = ({
  account,
  onCreate,
  boardId,
}: {
  account: MyAccount;
  /** no add field to go to (a board with no group yet) — create the first item (and group). */
  onCreate?: () => void;
  /** Prod (phase 2): the board — its item templates are offered when there are any and items may be added. */
  boardId?: string;
}) => {
  const admin = account.role === 'admin';
  const templates = useItemTemplates(account.id, boardId ?? '', !!boardId && !!onCreate).data ?? [];
  return (
    <EmptyState
      testId="board-empty"
      className="py-8"
      icon={<Icon name="board" size={28} />}
      title={t('board.emptyState.title')}
      action={
        <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
          <Button variant="accent" onClick={() => focusFirstAddItem() || onCreate?.()} data-testid="board-empty-add">
            <Icon name="plus" size={15} strokeWidth={2} />
            {t('board.emptyState.add')}
          </Button>
          {boardId && onCreate && templates.length ? (
            <Button
              variant="secondary"
              onClick={() => openItemTemplates({ kind: 'apply', boardId })}
              data-testid="board-empty-from-template"
            >
              <Icon name="template" size={15} />
              {t('board.emptyState.fromTemplate')}
            </Button>
          ) : null}
          {admin ? (
            <Link
              to="/a/$accountSlug/admin/$section"
              params={{ accountSlug: account.slug, section: 'templates' }}
              className="inline-flex h-9 items-center gap-1.5 rounded-[10px] border border-line-strong px-3.5 text-sm text-fg hover:bg-surface-2"
              data-testid="board-empty-templates"
            >
              <Icon name="template" size={15} />
              {t('board.emptyState.templates')}
            </Link>
          ) : (
            <Link
              to="/a/$accountSlug"
              params={{ accountSlug: account.slug }}
              className="inline-flex h-9 items-center gap-1.5 rounded-[10px] border border-line-strong px-3.5 text-sm text-fg hover:bg-surface-2"
              data-testid="board-empty-templates"
            >
              <Icon name="template" size={15} />
              {t('board.emptyState.templates')}
            </Link>
          )}
        </div>
      }
    >
      {t('board.emptyState.body')}
    </EmptyState>
  );
};
