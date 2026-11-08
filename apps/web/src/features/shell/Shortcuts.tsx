// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { type MessageKey, SHORTCUTS, t } from '@bines/shared';
import { Dialog } from '@bines/ui';
import { redoLast, undoLast } from '../../lib/undo';
import { isModLetter, isTyping } from '../../lib/keys';

const SCOPES = ['global', 'board', 'menu'] as const;

/**
 * App-wide shortcuts (14 §15): Shift+? lists them (from the shared registry), Ctrl+Z undoes the last action
 * within its minute, Ctrl+Shift+Z (or Ctrl+Y) redoes what was just undone. Board-only shortcuts (Ctrl+F, Ctrl+G) live on the board page. Letters
 * match on any keyboard layout (`isModLetter`).
 */
export const ShortcutsHost = () => {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setOpen(true);
      } else if (isModLetter(e, 'z')) {
        e.preventDefault();
        undoLast(qc);
      } else if (isModLetter(e, 'z', true) || isModLetter(e, 'y')) {
        e.preventDefault();
        void redoLast(qc);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [qc]);

  if (!open) return null;
  return (
    <Dialog open title={t('shortcuts.title')} onClose={() => setOpen(false)}>
      <div className="space-y-4" data-testid="shortcuts">
        {SCOPES.map((scope) => (
          <section key={scope}>
            <h3 className="mb-1 text-xs font-medium text-muted">{t(`shortcuts.scope.${scope}` as MessageKey)}</h3>
            <dl className="divide-y divide-[var(--line)]">
              {SHORTCUTS.filter((s) => s.scope === scope).map((s) => (
                <div key={`${s.keys}|${s.label}`} className="flex items-center justify-between gap-4 py-1.5 text-sm">
                  <dt>{t(s.label)}</dt>
                  <dd>
                    <kbd
                      dir="ltr"
                      className="rounded border border-line bg-surface-2 px-1.5 py-0.5 font-sans text-xs text-muted"
                    >
                      {s.keys}
                    </kbd>
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
};
