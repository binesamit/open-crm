// SPDX-License-Identifier: AGPL-3.0-only
import { t } from '@bines/shared';
import { Card, Switch } from '@bines/ui';

/**
 * Administration → כללי → guests: may guests change a board's structure — add, edit, reorder or
 * delete its columns and groups (a connect-boards column's boards included)? Off by default: a guest edits items
 * only, whatever the board's permission set gives its other subscribers.
 */
export const GuestsSection = ({
  editStructure,
  busy,
  onChange,
}: {
  editStructure: boolean;
  busy: boolean;
  onChange: (on: boolean) => void;
}) => (
  <Card className="p-0">
    <div className="space-y-0.5 border-b border-line-soft px-3.5 pt-3.5 pb-3" data-testid="admin-general-guests">
      <h2 className="font-display text-[1rem] leading-snug font-extrabold text-heading">{t('admin.guests.title')}</h2>
    </div>
    <div className="flex items-center gap-3 px-3.5 py-3 max-sm:flex-col max-sm:items-stretch max-sm:gap-2">
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="text-sm font-semibold text-fg">{t('admin.guests.editStructure')}</div>
        <p className="text-xs text-muted">{t('admin.guests.editStructureHint')}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2 max-sm:shrink">
        <Switch
          checked={editStructure}
          disabled={busy}
          label={t('admin.guests.editStructure')}
          testId="admin-guests-edit-structure"
          onChange={onChange}
        />
      </div>
    </div>
  </Card>
);
