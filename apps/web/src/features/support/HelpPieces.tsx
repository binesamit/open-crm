// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { HelpAnswer, HelpHit, HelpOptions } from '@bines/shared';
import { Button, Notice, Spinner } from '@bines/ui';
import { errorMessage } from '../../lib/api';
import { Icon } from '../../lib/icons';
import { askAssistant, sendFeedback, useHelpArticle } from './help-api';
import { t } from '@bines/shared';
import { useShowMe } from '../tours/TourHost';
import { GuideView, guideMeta } from './GuideView';

/** Server HTML that holds words or a picture (a guide's empty body is not shown). */
export const hasText = (html: string) => /<img\b/i.test(html) || html.replace(/<[^>]*>|&nbsp;|\s/g, '').length > 0;

/**
 * Pieces of the knowledge center shared by the "?" help panel and the ticket form: a list of
 * articles, one article with "did this help?", and the help assistant's step.
 */
export const HitList = <H extends Pick<HelpHit, 'id' | 'title' | 'excerpt'>>({
  hits,
  onOpen,
  testId = 'help-result',
}: {
  hits: H[];
  onOpen: (hit: H) => void;
  testId?: string;
}) => (
  <ul className="space-y-1">
    {hits.map((h) => (
      <li key={h.id}>
        <button
          type="button"
          data-testid={testId}
          data-id={h.id}
          onClick={() => onOpen(h)}
          className="w-full rounded-[8px] px-2.5 py-1.5 text-start hover:bg-surface-2"
        >
          <span className="block text-sm font-medium text-link" dir="auto">
            {h.title}
          </span>
          {h.excerpt ? (
            <span className="line-clamp-2 block text-xs text-muted" dir="auto">
              {h.excerpt}
            </span>
          ) : null}
        </button>
      </li>
    ))}
  </ul>
);

/** One published article, rendered from the server's allowlisted HTML, with "did this help? yes / no". */
export const ArticleView = ({
  accountId,
  id,
  onHelpful,
  onNotHelpful,
  onOpen,
  onTour,
  variant = 'panel',
}: {
  accountId: string;
  id: string;
  /** "Show me in the app" is about to start the guide's tour (the panel closes itself first). */
  onTour?: () => void;
  /** `page`: the knowledge center page — the article's title is the page's heading. */
  variant?: 'panel' | 'page';
  /** "Yes": the person found the answer. */
  onHelpful?: (id: string) => void;
  /** "No": back to the list / the next step. */
  onNotHelpful?: (id: string) => void;
  /** Another article (a translation). */
  onOpen?: (id: string) => void;
}) => {
  const article = useHelpArticle(accountId, id);
  const showMe = useShowMe(accountId, article.data?.tour_id);
  const [voted, setVoted] = useState<boolean | null>(null);
  const vote = (helpful: boolean) => {
    setVoted(helpful);
    void sendFeedback(accountId, id, helpful).catch(() => undefined);
    if (helpful) onHelpful?.(id);
    else onNotHelpful?.(id);
  };
  if (article.isPending) return <Spinner label={t('app.loading')} />;
  if (article.isError) return <Notice tone="error">{errorMessage(article.error)}</Notice>;
  const a = article.data;
  const meta = a.guide ? guideMeta(a.guide.video?.duration, a.guide.steps.length) : '';
  const tourButton = showMe ? (
    <Button
      size={variant === 'page' ? 'md' : 'sm'}
      variant="accent"
      className="shrink-0 font-normal"
      onClick={() => {
        onTour?.();
        showMe();
      }}
      data-testid="guide-show-me"
    >
      <Icon name="place" size={15} />
      {t('guide.showMe')}
    </Button>
  ) : null;
  return (
    <article className="space-y-3" data-testid="help-article" data-id={a.id} data-kind={a.kind}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          {variant === 'page' ? (
            <h2
              className="font-display text-xl leading-tight font-extrabold text-heading md:text-[1.375rem]"
              dir="auto"
            >
              {a.title}
            </h2>
          ) : (
            <h3 className="text-base font-semibold text-fg" dir="auto">
              {a.title}
            </h3>
          )}
          {meta ? (
            <p className="mt-1 text-[0.8125rem] text-muted" data-testid="guide-meta">
              {meta}
            </p>
          ) : null}
        </div>
        {tourButton}
      </div>
      {a.translations.length ? (
        <div className="flex flex-wrap gap-2 text-xs">
          {a.translations.map((x) => (
            <button
              key={x.slug}
              type="button"
              className="text-link hover:underline"
              onClick={() => onOpen?.(x.slug)}
              data-testid="help-translation"
            >
              {x.locale.toUpperCase()} · {x.title}
            </button>
          ))}
        </div>
      ) : null}
      {a.guide ? <GuideView guide={a.guide} /> : null}
      {a.guide && !hasText(a.html) ? null : (
        <div
          className="rich-content text-sm leading-relaxed text-fg"
          dir="auto"
          // Rendered on the server from the article's rich text through the shared allowlist (never browser HTML).
          dangerouslySetInnerHTML={{ __html: a.html }}
        />
      )}
      <div className="flex items-center gap-2 border-t border-line pt-2 text-sm" data-testid="help-feedback">
        {voted === null ? (
          <>
            <span className="text-fg-2">{t('help.helpful.question')}</span>
            <Button size="sm" variant="secondary" onClick={() => vote(true)} data-testid="help-helpful-yes">
              {t('help.helpful.yes')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => vote(false)} data-testid="help-helpful-no">
              {t('help.helpful.no')}
            </Button>
          </>
        ) : (
          <span className="text-muted" data-testid="help-feedback-thanks">
            {t('help.helpful.thanks')}
          </span>
        )}
      </div>
    </article>
  );
};

/**
 * "Ask the assistant": answers only from the published articles, with links to them; "not found" says so. Shown only
 * when the options say the assistant is available (the plan includes AI, a connection, under the cap); otherwise
 * the cap message (if that is why) and the person goes on to the form.
 */
export const AssistantStep = ({
  accountId,
  options,
  question,
  onOpenArticle,
  onSolved,
}: {
  accountId: string;
  options: HelpOptions | undefined;
  question: string;
  onOpenArticle: (id: string) => void;
  onSolved?: () => void;
}) => {
  const ask = useMutation({ mutationFn: (q: string) => askAssistant(accountId, q) });
  if (!options) return null;
  if (!options.assistant)
    return options.assistant_off_reason === 'cap_reached' ? (
      <Notice tone="info">
        <span data-testid="help-ai-cap">{options.cap_message || t('help.ai.capReached')}</span>
      </Notice>
    ) : null;
  const answer: HelpAnswer | undefined = ask.data;
  return (
    <div className="space-y-2 rounded-[var(--radius)] bg-surface-2 p-2.5" data-testid="help-assistant">
      {!answer ? (
        <Button
          size="sm"
          variant="secondary"
          busy={ask.isPending}
          disabled={question.trim().length < 3}
          onClick={() => ask.mutate(question.trim())}
          data-testid="help-ask"
        >
          <Icon name="sparkle" size={14} />
          {t('help.ai.ask')}
        </Button>
      ) : answer.found ? (
        <div className="space-y-1.5" data-testid="help-answer">
          <p className="text-sm whitespace-pre-line text-fg" dir="auto">
            {answer.answer}
          </p>
          <p className="flex flex-wrap gap-x-2 text-xs text-muted">
            <span>{t('help.ai.from')}</span>
            {answer.citations.map((c) => (
              <button
                key={c.id}
                type="button"
                className="text-link hover:underline"
                onClick={() => onOpenArticle(c.id)}
                data-testid="help-citation"
                dir="auto"
              >
                {c.title}
              </button>
            ))}
          </p>
          {onSolved ? (
            <Button size="sm" variant="ghost" onClick={onSolved} data-testid="help-answer-solved">
              {t('help.ai.solved')}
            </Button>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-fg-2" data-testid="help-answer-not-found">
          {t('help.ai.notFound')}
        </p>
      )}
      {ask.isError ? <Notice tone="error">{errorMessage(ask.error)}</Notice> : null}
    </div>
  );
};
