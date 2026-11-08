// SPDX-License-Identifier: AGPL-3.0-only
import type { TicketArticle } from '@bines/shared';
import { Icon } from '../../lib/icons';
import { HitList } from './HelpPieces';
import { t } from '@bines/shared';

/**
 * Knowledge-center articles support attached to a ticket reply: the help panel's article list (title +
 * short excerpt) in a card under the reply. The customer opens one in the app's knowledge center; the console opens
 * its help-center address. The server sends only articles the customer may read now, with their current titles.
 */
export const TicketArticleCards = ({
  articles,
  onOpen,
  testId = 'ticket-article',
}: {
  articles: TicketArticle[];
  onOpen: (article: TicketArticle) => void;
  testId?: string;
}) =>
  articles.length ? (
    <div className="mt-2 rounded-[10px] border border-line bg-surface p-1" data-testid="ticket-articles">
      <p className="flex items-center gap-1 px-2.5 pt-1 text-xs font-semibold text-fg-2">
        <Icon name="book" size={12} />
        {t('tickets.article.label')}
      </p>
      <HitList hits={articles} onOpen={onOpen} testId={testId} />
    </div>
  ) : null;
