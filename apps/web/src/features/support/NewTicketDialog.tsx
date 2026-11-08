// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { MyAccount, TicketDetail, TicketPriority } from '@bines/shared';
import { Button, Dialog, Field, Input, Notice, Picker } from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { Icon } from '../../lib/icons';
import { collectTicketContext } from '../../lib/client-errors';
import { formatSize, uploadFile, type UploadedFile } from '../../lib/upload';
import { showToast } from '../../lib/toast';
import { ArticleSuggestions } from './ArticleSuggestions';
import { sendHelpEvent, useHelpOptions } from './help-api';
import { ArticleView, AssistantStep } from './HelpPieces';
import { priorityLabel, ticketKeys, useTicketOptions } from './support-api';
import { t } from '@bines/shared';

export const TEXTAREA =
  'min-h-28 w-full rounded-[10px] border border-line-strong bg-surface px-2.5 py-2 text-sm text-fg placeholder:text-muted focus:border-primary focus:outline-none focus:ring-3 focus:ring-[var(--accent-soft)]';

type ContextItem = { key: string; label: string; value: string };

/**
 * "Open a ticket": subject, description, category, priority and files — plus what the app attaches by
 * itself (the page, the browser, recent errors), each shown and removable before sending. The platform decides which
 * of these are offered at all (owner console → Support → Settings). The knowledge center comes first
 * article suggestions under the subject, then — when the plan includes AI and a connection is available — "ask the
 * assistant"; the form keeps what was typed. Skipping help is always possible: it is a suggestion, never a gate.
 */
export const NewTicketDialog = ({
  account,
  onClose,
  initialSubject = '',
  initialDescription = '',
}: {
  account: MyAccount;
  onClose: () => void;
  /** From the help panel ("still need help"): what the person already wrote. */
  initialSubject?: string;
  initialDescription?: string;
}) => {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const options = useTicketOptions(account.id);
  const o = options.data;
  const [subject, setSubject] = useState(initialSubject);
  const [description, setDescription] = useState(initialDescription);
  const help = useHelpOptions(account.id);
  // Help was offered before this ticket (suggestions shown, or the assistant): the ticket counts as "opened after help".
  const helpShown = useRef(!!initialSubject);
  const markShown = useCallback(() => {
    helpShown.current = true;
  }, []);
  const [reading, setReading] = useState<string | null>(null);
  const deflect = (articleId?: string) => {
    sendHelpEvent(account.id, 'deflected', { article_id: articleId ?? null, query: subject.trim().slice(0, 200) });
    showToast({ message: t('help.deflected') });
    onClose();
  };
  const [category, setCategory] = useState<string>('');
  const [priority, setPriority] = useState<TicketPriority | ''>('');
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  // Collected once when the form opens: the page the person was on, not this dialog's later state.
  const [collected] = useState(() => collectTicketContext(20));
  const [removed, setRemoved] = useState<Set<string>>(() => new Set());

  const items: ContextItem[] = o
    ? [
        ...(o.context.page && collected.page_url
          ? [{ key: 'page_url', label: t('tickets.context.page'), value: collected.page_url }]
          : []),
        ...(o.context.browser
          ? [
              {
                key: 'browser',
                label: t('tickets.context.browser'),
                value: `${collected.browser} · ${collected.os} · ${collected.screen}`,
              },
            ]
          : []),
        ...(o.context.errors
          ? collected.errors
              .slice(-o.context.max_errors)
              .map((e, i) => ({ key: `error:${i}`, label: t('tickets.context.error'), value: e.message }))
          : []),
      ]
    : [];
  const kept = (key: string) => !removed.has(key);

  const create = useMutation({
    mutationFn: () => {
      const errors = o?.context.errors
        ? collected.errors.slice(-o.context.max_errors).filter((_, i) => kept(`error:${i}`))
        : [];
      return api(account.id).post<TicketDetail>('/support/tickets', {
        subject,
        description,
        category_id: category || null,
        ...(priority ? { priority } : {}),
        attachment_ids: files.map((f) => f.id),
        context: {
          ...(kept('page_url') && o?.context.page ? { page_url: collected.page_url } : {}),
          ...(kept('browser') && o?.context.browser
            ? {
                user_agent: collected.user_agent,
                browser: collected.browser,
                os: collected.os,
                screen: collected.screen,
              }
            : {}),
          ...(errors.length ? { errors } : {}),
        },
      });
    },
    onSuccess: async (ticket) => {
      if (helpShown.current) sendHelpEvent(account.id, 'ticket_opened', { query: subject.trim().slice(0, 200) });
      await qc.invalidateQueries({ queryKey: ticketKeys.all(account.id) });
      showToast({ message: t('tickets.created', { number: ticket.number }) });
      onClose();
      void navigate({
        to: '/a/$accountSlug/support/$ticketId',
        params: { accountSlug: account.slug, ticketId: ticket.id },
      } as never);
    },
  });

  const addFiles = async (list: FileList | null) => {
    if (!list?.length) return;
    setUploading(true);
    try {
      for (const f of [...list].slice(0, 10 - files.length)) {
        const up = await uploadFile(account.id, f);
        setFiles((cur) => [...cur, up]);
      }
    } catch (err) {
      showToast({ message: errorMessage(err), tone: 'error' });
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (subject.trim() && description.trim()) create.mutate();
  };

  const categoryOptions = [
    { value: '', label: t('tickets.category.none') },
    ...(o?.categories ?? []).map((c) => ({ value: c.id, label: c.name, testId: `ticket-category-${c.id}` })),
  ];
  const chosen = o?.categories.find((c) => c.id === category);
  const defaultPriority = chosen?.default_priority ?? o?.default_priority ?? 'normal';

  return (
    <Dialog open onClose={onClose} title={t('tickets.new.title')} subtitle={account.name} className="max-w-xl!">
      {o && !o.may_open ? (
        <Notice tone="warn">{t(o.enabled ? 'tickets.new.adminsOnly' : 'tickets.new.disabled')}</Notice>
      ) : (
        <form className="space-y-3" onSubmit={submit} data-testid="ticket-new-form">
          <Field label={t('tickets.field.subject')}>
            <Input
              required
              maxLength={200}
              value={subject}
              autoFocus
              data-testid="ticket-subject"
              onChange={(e) => setSubject(e.target.value)}
            />
          </Field>
          <ArticleSuggestions
            accountId={account.id}
            subject={subject}
            enabled={!!o?.suggest_articles}
            max={help.data?.max_suggestions}
            onHelped={() => {
              showToast({ message: t('help.deflected') });
              onClose();
            }}
            onShown={markShown}
          />
          <Field label={t('tickets.field.description')}>
            <textarea
              required
              maxLength={20_000}
              className={TEXTAREA}
              value={description}
              data-testid="ticket-description"
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          {o?.suggest_articles && subject.trim().length >= 3 ? (
            <div onFocusCapture={markShown} onClickCapture={markShown}>
              <AssistantStep
                accountId={account.id}
                options={help.data}
                question={[subject, description].filter((x) => x.trim()).join('\n')}
                onOpenArticle={setReading}
                onSolved={() => deflect()}
              />
            </div>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('tickets.field.category')}>
              <Picker
                label={t('tickets.field.category')}
                value={category}
                options={categoryOptions}
                onChange={setCategory}
                testId="ticket-category"
              />
            </Field>
            <Field label={t('tickets.field.priority')}>
              <Picker
                label={t('tickets.field.priority')}
                value={priority || defaultPriority}
                options={(o?.priorities ?? []).map((p) => ({
                  value: p,
                  label: priorityLabel(p),
                  testId: `ticket-priority-${p}`,
                }))}
                onChange={(v) => setPriority(v as TicketPriority)}
                testId="ticket-priority"
              />
            </Field>
          </div>
          {account.role !== 'viewer' ? (
            <div className="space-y-1.5">
              <span className="text-xs font-semibold text-fg-2">{t('tickets.field.files')}</span>
              <ul className="flex flex-wrap gap-1.5">
                {files.map((f) => (
                  <li
                    key={f.id}
                    data-testid="ticket-file"
                    className="inline-flex h-7 items-center gap-1 rounded-full bg-surface-2 ps-2.5 pe-1 text-xs text-fg-2"
                  >
                    <Icon name="clip" size={12} />
                    <span className="max-w-40 truncate">{f.name}</span>
                    <span className="text-muted">{formatSize(f.size)}</span>
                    <button
                      type="button"
                      aria-label={t('tickets.file.remove', { name: f.name })}
                      onClick={() => setFiles((cur) => cur.filter((x) => x.id !== f.id))}
                      className="grid size-5 place-items-center rounded-full text-muted hover:bg-surface-3 hover:text-fg"
                    >
                      <Icon name="x" size={11} />
                    </button>
                  </li>
                ))}
              </ul>
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                data-testid="ticket-file-input"
                onChange={(e) => void addFiles(e.target.files)}
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                busy={uploading}
                disabled={files.length >= 10}
                onClick={() => fileInput.current?.click()}
              >
                <Icon name="upload" size={14} />
                {t('tickets.file.add')}
              </Button>
            </div>
          ) : null}
          {items.length ? (
            <div className="space-y-1.5" data-testid="ticket-context">
              <span className="text-xs font-semibold text-fg-2">{t('tickets.context.title')}</span>
              <p className="text-xs text-muted">{t('tickets.context.hint')}</p>
              <ul className="space-y-1">
                {items.map((item) => (
                  <li
                    key={item.key}
                    data-testid="ticket-context-item"
                    data-key={item.key}
                    data-kept={kept(item.key) ? 'true' : 'false'}
                    className="flex items-start gap-2 rounded-[8px] bg-surface-2 px-2.5 py-1.5 text-xs"
                  >
                    <span className="shrink-0 font-semibold text-fg-2">{item.label}</span>
                    <span
                      className={
                        kept(item.key)
                          ? 'min-w-0 flex-1 break-all text-fg'
                          : 'min-w-0 flex-1 break-all text-muted line-through'
                      }
                      dir="auto"
                    >
                      {item.value}
                    </span>
                    <button
                      type="button"
                      data-testid="ticket-context-toggle"
                      className="shrink-0 text-link hover:underline"
                      onClick={() =>
                        setRemoved((cur) => {
                          const next = new Set(cur);
                          if (next.has(item.key)) next.delete(item.key);
                          else next.add(item.key);
                          return next;
                        })
                      }
                    >
                      {kept(item.key) ? t('tickets.context.remove') : t('tickets.context.keep')}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {create.isError ? <Notice tone="error">{errorMessage(create.error)}</Notice> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              variant="accent"
              busy={create.isPending}
              disabled={!subject.trim() || !description.trim() || uploading}
              data-testid="ticket-submit"
            >
              <Icon name="send" size={14} />
              {t('tickets.new.submit')}
            </Button>
          </div>
        </form>
      )}
      {reading ? (
        <Dialog open onClose={() => setReading(null)} title={t('help.title')} className="max-w-xl!">
          <ArticleView
            accountId={account.id}
            id={reading}
            onOpen={setReading}
            onHelpful={(id) => deflect(id)}
            onNotHelpful={() => setReading(null)}
          />
        </Dialog>
      ) : null}
    </Dialog>
  );
};
