// SPDX-License-Identifier: AGPL-3.0-only
import { labelColor, STATUS_COLORS, t, type MirrorDisplay, type MirrorLabel } from '@bines/shared';
import { cn } from '@bines/ui';
import { fill, tagVars } from '../../../lib/label-color';
import type { CellProps } from './index';

/**
 * r15cols — a mirror of labels (status / dropdown) as its column settings say: the joined text (default), a
 * coloured chip per label, or the coloured distribution bar of the group footers. Any other mirror shows its text.
 */
const base = 'relative flex h-full w-full items-center px-2 text-sm';

const share = (l: MirrorLabel, total: number) =>
  `${l.label.trim() || t('filter.blank')} · ${l.count} (${total ? Math.round((l.count / total) * 100) : 0}%)`;

/** The settings dialog's live preview: the chosen look with up to three labels of the source column. */
export const MirrorDisplayPreview = ({
  display,
  source,
}: {
  display: MirrorDisplay;
  source?: { id: string; title: string; type: string; settings: Record<string, unknown> };
}) => {
  const own = (
    (source?.settings.labels as { id: number; label: string; color?: string; is_deactivated?: boolean }[]) ?? []
  ).filter((l) => !l.is_deactivated);
  const sample: MirrorLabel[] = (
    own.length ? own : STATUS_COLORS.slice(0, 3).map((color, id) => ({ id, label: `${id + 1}`, color }))
  )
    .slice(0, 3)
    .map((l, i) => ({ label: l.label, color: labelColor(l), count: 3 - i }));
  const column = { id: 'preview', title: '', type: 'mirror', settings: { display } } as unknown as CellProps['column'];
  return (
    <div
      className="flex items-center gap-2 rounded-[10px] border border-line bg-surface-2 p-1.5"
      data-testid="mirror-preview"
    >
      <span className="shrink-0 text-xs text-muted">{t('r15cols.preview')}</span>
      <div className="h-8 min-w-0 flex-1 rounded-[6px] bg-surface">
        <MirrorCell
          {...({} as CellProps)}
          column={column}
          value={{ labels: sample }}
          text={sample.map((l) => Array(l.count).fill(l.label).join(', ')).join(', ')}
        />
      </div>
    </div>
  );
};

export const MirrorCell = ({ column, value, text }: CellProps) => {
  const display = (column.settings.display as MirrorDisplay | undefined) ?? 'text';
  const labels = (value as { labels?: MirrorLabel[] } | null)?.labels;
  if (display === 'text' || !labels?.length) {
    return (
      <div className={cn(base, 'text-muted')} title={t('board.readOnly')}>
        <span className="truncate" dir="auto">
          {text}
        </span>
      </div>
    );
  }
  const total = labels.reduce((s, l) => s + l.count, 0);
  if (display === 'bar') {
    return (
      <div className={base} data-testid="mirror-bar" title={labels.map((l) => share(l, total)).join('\n')}>
        <div
          className="flex h-2.5 min-w-0 flex-1 gap-px overflow-hidden rounded-full"
          role="img"
          aria-label={labels.map((l) => share(l, total)).join(', ')}
        >
          {labels.map((l) => (
            <div
              key={`${l.label}-${l.color}`}
              data-testid="mirror-bar-segment"
              title={share(l, total)}
              data-color={l.color}
              style={{ flexGrow: l.count, ...fill(l.color) }}
            />
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className={cn(base, 'gap-1 overflow-hidden')} data-testid="mirror-chips" title={text ?? undefined}>
      {labels.map((l) => (
        <span
          key={`${l.label}-${l.color}`}
          data-testid="mirror-chip"
          data-color={l.color}
          className="label-tag h-5 max-w-full shrink-0 gap-1 truncate text-xs"
          style={tagVars(l.color)}
        >
          <span className="truncate">{l.label}</span>
          {l.count > 1 ? <span className="tabular-nums opacity-80">×{l.count}</span> : null}
        </span>
      ))}
    </div>
  );
};
