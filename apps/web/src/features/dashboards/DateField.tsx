// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { formatDate, t, type IsoDate } from '@bines/shared';
import { Calendar } from '@bines/ui';
import { Icon } from '../../lib/icons';
import { Popover } from '../board/cells/Popover';

/** A day picked from the system calendar (never a native date input). */
export const DateField = ({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string | null;
  onChange: (v: string | null) => void;
}) => {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative space-y-1.5">
      <span className="text-xs font-semibold text-fg-2">{label}</span>
      <button
        type="button"
        title={label}
        aria-label={label}
        onClick={() => setOpen(true)}
        className="flex h-9 w-full items-center gap-2 rounded-[10px] border border-line-strong bg-surface px-3 text-start text-sm text-fg hover:border-primary"
      >
        <Icon name="calendar" size={15} className="shrink-0 text-muted" />
        <span className="flex-1 truncate">{value ? formatDate(value) : t('dashboards.anyDay')}</span>
      </button>
      <Popover open={open} onClose={() => setOpen(false)}>
        <Calendar
          mode="single"
          value={(value as IsoDate | null) ?? null}
          onChange={(v) => {
            onChange(v);
            setOpen(false);
          }}
        />
      </Popover>
    </div>
  );
};
