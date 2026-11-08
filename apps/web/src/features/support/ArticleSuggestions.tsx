// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from 'react';
import { Button } from '@bines/ui';
import { Icon } from '../../lib/icons';
import { sendHelpEvent, useHelpSearch } from './help-api';
import { useDebounced } from '../../lib/use-debounced';
import { ArticleView, HitList } from './HelpPieces';
import { t } from '@bines/shared';

/**
 * The knowledge center in the ticket form (stage 3): while the person types the subject, matching
 * published articles in their language are offered (debounced; as many as the owner set). An article opens in place
 * with "did this help?": yes = the answer was found — a `deflected` event, and the form closes without a ticket; no =
 * back to the form (where the help assistant comes next, when available).
 */
export type ArticleSuggestion = { id: string; title: string; url: string; excerpt?: string };

/** Debounced suggestions for a subject (empty until it has a few letters, or when the platform turned them off). */
export const useArticleSuggestions = (accountId: string, subject: string, enabled: boolean, max = 3) => {
  const q = useDebounced(subject.trim(), 350);
  const res = useHelpSearch(accountId, q, { mode: 'typing', limit: max, enabled: enabled && q.length >= 3 });
  return enabled && q.length >= 3 ? (res.data?.data ?? []) : [];
};

export const ArticleSuggestions = ({
  accountId,
  subject,
  enabled,
  max,
  onHelped,
  onShown,
}: {
  accountId: string;
  subject: string;
  enabled: boolean;
  max?: number;
  /** The person found the answer: the form closes without a ticket. */
  onHelped?: () => void;
  /** Suggestions were shown (the form then reports a ticket opened "after help"). */
  onShown?: () => void;
}) => {
  const articles = useArticleSuggestions(accountId, subject, enabled, max);
  const [open, setOpen] = useState<string | null>(null);
  const shown = articles.length > 0;
  useEffect(() => {
    if (shown) onShown?.();
  }, [shown, onShown]);
  if (!shown) return null;
  return (
    <div data-testid="ticket-suggestions" className="space-y-1.5 rounded-[var(--radius)] bg-surface-2 p-2.5">
      {open ? (
        <>
          <Button size="sm" variant="ghost" onClick={() => setOpen(null)} data-testid="ticket-suggestion-back">
            <Icon name="back" size={14} />
            {t('help.back')}
          </Button>
          <ArticleView
            accountId={accountId}
            id={open}
            onOpen={setOpen}
            onHelpful={(id) => {
              sendHelpEvent(accountId, 'deflected', { article_id: id, query: subject.trim().slice(0, 200) });
              onHelped?.();
            }}
            onNotHelpful={() => setOpen(null)}
          />
        </>
      ) : (
        <>
          <p className="text-xs font-semibold text-fg-2">{t('help.suggestions.title')}</p>
          <HitList hits={articles} onOpen={(h) => setOpen(h.id)} testId="ticket-suggestion" />
        </>
      )}
    </div>
  );
};
