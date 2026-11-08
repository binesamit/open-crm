// SPDX-License-Identifier: AGPL-3.0-only
import { useRef, useState } from 'react';
import {
  type Agent,
  type AgentKnowledge,
  KNOWLEDGE_FILE_EXTENSIONS,
  KNOWLEDGE_LIMITS,
  t,
  tDynamic,
} from '@bines/shared';
import { Badge, Button, Card, EmptyState, Field, Input, Notice, Picker, SkeletonRows } from '@bines/ui';
import { errorMessage, type MyAccount } from '../../lib/api';
import { confirmDialog } from '../../lib/dialogs';
import { Icon } from '../../lib/icons';
import { showToast } from '../../lib/toast';
import { uploadFile } from '../../lib/upload';
import { fail } from './agent-parts';
import { useAgentKnowledge, useBoardChoices, useDocChoices, useKnowledgeMutations } from './agents-api';

/**
 * The agent's knowledge base (the planning notes "AGENTS-MCP" §6 "ידע", מ9): files (PDF / DOCX / TXT / MD — the text is
 * extracted on the server), docs, boards (read with the agent's tools) and notes; each with its indexing status.
 * The agent searches it with `search_knowledge`, only in what its creator can read.
 */
const textareaClass =
  'w-full rounded-[10px] border border-line-strong bg-surface px-2.5 py-2 text-sm text-fg placeholder:text-muted focus:border-primary focus:ring-3 focus:ring-[var(--accent-soft)] focus:outline-none';

const STATUS_TONE = { indexing: 'info', ready: 'ok', error: 'danger' } as const;
const ACCEPT = KNOWLEDGE_FILE_EXTENSIONS.map((e) => `.${e}`).join(',');

type Adding = null | 'doc' | 'board' | 'note';

export const KnowledgeTab = ({ account, agent }: { account: MyAccount; agent: Agent }) => {
  const q = useAgentKnowledge(account.id, agent.id);
  const m = useKnowledgeMutations(account.id, agent.id);
  const [adding, setAdding] = useState<Adding>(null);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const sources = q.data?.data ?? [];
  const full = sources.length >= KNOWLEDGE_LIMITS.sources;

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > KNOWLEDGE_LIMITS.fileBytes) return fail(new Error(t('agents.knowledge.tooLarge')));
    setUploading(true);
    try {
      const up = await uploadFile(account.id, file);
      await m.add.mutateAsync({ kind: 'file', file_id: up.id });
      showToast({ message: t('agents.knowledge.added') });
    } catch (err) {
      fail(err);
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };
  const remove = async (s: AgentKnowledge) => {
    const ok = await confirmDialog({
      title: t('agents.knowledge.removeTitle', { name: s.title }),
      message: t('agents.knowledge.removeHint'),
      confirmLabel: t('common.delete'),
      danger: true,
    });
    if (ok) m.remove.mutate(s.id, { onError: fail });
  };

  return (
    <div className="flex flex-col gap-3" data-testid="agent-knowledge">
      <Card className="flex flex-col gap-3">
        <p className="text-xs text-muted">{t('agents.knowledge.hint')}</p>
        <div className="flex flex-wrap gap-2">
          <input
            ref={fileInput}
            type="file"
            accept={ACCEPT}
            hidden
            data-testid="agent-knowledge-file-input"
            onChange={(e) => void onFile(e.target.files?.[0])}
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={full}
            busy={uploading}
            onClick={() => fileInput.current?.click()}
            data-testid="agent-knowledge-add-file"
          >
            <Icon name="plus" size={14} />
            {t('agents.knowledge.addFile')}
          </Button>
          {(['doc', 'board', 'note'] as const).map((k) => (
            <Button
              key={k}
              size="sm"
              variant={adding === k ? 'primary' : 'secondary'}
              disabled={full}
              onClick={() => setAdding(adding === k ? null : k)}
              data-testid={`agent-knowledge-add-${k}`}
            >
              <Icon name="plus" size={14} />
              {t(`agents.knowledge.add.${k}`)}
            </Button>
          ))}
        </div>
        {full ? <Notice tone="warn">{t('agents.knowledge.full', { n: KNOWLEDGE_LIMITS.sources })}</Notice> : null}
        {adding === 'doc' ? <AddDoc account={account} agent={agent} done={() => setAdding(null)} /> : null}
        {adding === 'board' ? <AddBoard account={account} agent={agent} done={() => setAdding(null)} /> : null}
        {adding === 'note' ? <AddNote account={account} agent={agent} done={() => setAdding(null)} /> : null}
      </Card>
      <Card className="p-0">
        {q.isPending ? (
          <SkeletonRows rows={3} label={t('app.loading')} />
        ) : q.isError ? (
          <Notice tone="error">{errorMessage(q.error)}</Notice>
        ) : !sources.length ? (
          <EmptyState title={t('agents.knowledge.empty')} testId="agent-knowledge-empty" />
        ) : (
          <ul data-testid="agent-knowledge-list">
            {sources.map((s) => (
              <li
                key={s.id}
                className="flex flex-wrap items-center gap-2.5 border-b border-line-soft px-3.5 py-2.5 last:border-b-0"
                data-testid="agent-knowledge-source"
                data-kind={s.kind}
                data-status={s.status}
              >
                <Badge tone="neutral">{t(`agents.knowledge.kind.${s.kind}`)}</Badge>
                <span className="min-w-0 flex-1 truncate text-sm font-semibold text-fg">{s.title}</span>
                {s.kind !== 'board' && s.status === 'ready' ? (
                  <span className="text-xs text-muted">
                    {t('agents.knowledge.chunks', { n: s.chunks })}
                    {s.truncated ? ` · ${t('agents.knowledge.truncated')}` : ''}
                  </span>
                ) : null}
                <Badge tone={STATUS_TONE[s.status]}>
                  {s.status === 'error' && s.error
                    ? tDynamic(`agents.knowledge.error.${s.error}`)
                    : t(`agents.knowledge.status.${s.status}`)}
                </Badge>
                {s.kind === 'doc' || s.status === 'error' ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => m.reindex.mutate(s.id, { onError: fail })}
                    data-testid="agent-knowledge-reindex"
                  >
                    {t('agents.knowledge.reindex')}
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-muted hover:text-danger-fg"
                  onClick={() => void remove(s)}
                  data-testid="agent-knowledge-remove"
                >
                  {t('common.delete')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
};

type AddProps = { account: MyAccount; agent: Agent; done: () => void };

const AddDoc = ({ account, agent, done }: AddProps) => {
  const docs = useDocChoices(account.id);
  const m = useKnowledgeMutations(account.id, agent.id);
  return (
    <Field label={t('agents.knowledge.pickDoc')} hint={t('agents.knowledge.pickDocHint')}>
      <Picker
        value={'' as string}
        label={t('agents.knowledge.pickDoc')}
        placeholder={docs.isPending ? t('app.loading') : t('agents.knowledge.pickDoc')}
        testId="agent-knowledge-doc"
        onChange={(id) => id && m.add.mutate({ kind: 'doc', doc_id: id }, { onSuccess: done, onError: fail })}
        options={(docs.data ?? []).map((d) => ({
          value: d.id,
          label: `${d.name} · ${d.workspace}`,
          keywords: d.workspace,
        }))}
      />
    </Field>
  );
};

const AddBoard = ({ account, agent, done }: AddProps) => {
  const boards = useBoardChoices(account.id);
  const m = useKnowledgeMutations(account.id, agent.id);
  return (
    <Field label={t('agents.knowledge.pickBoard')} hint={t('agents.knowledge.pickBoardHint')}>
      <Picker
        value={'' as string}
        label={t('agents.knowledge.pickBoard')}
        placeholder={boards.isPending ? t('app.loading') : t('agents.knowledge.pickBoard')}
        testId="agent-knowledge-board"
        onChange={(id) => id && m.add.mutate({ kind: 'board', board_id: id }, { onSuccess: done, onError: fail })}
        options={(boards.data ?? []).map((b) => ({
          value: b.id,
          label: `${b.name} · ${b.workspace}`,
          keywords: b.workspace,
        }))}
      />
    </Field>
  );
};

const AddNote = ({ account, agent, done }: AddProps) => {
  const m = useKnowledgeMutations(account.id, agent.id);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  return (
    <div className="flex flex-col gap-2" data-testid="agent-knowledge-note">
      <Field label={t('agents.knowledge.noteTitle')}>
        <Input
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          data-testid="agent-note-title"
        />
      </Field>
      <Field label={t('agents.knowledge.noteText')}>
        <textarea
          rows={6}
          maxLength={KNOWLEDGE_LIMITS.noteChars}
          value={text}
          onChange={(e) => setText(e.target.value)}
          className={textareaClass}
          data-testid="agent-note-text"
        />
      </Field>
      <Button
        size="sm"
        className="self-end"
        disabled={!title.trim() || !text.trim()}
        busy={m.add.isPending}
        onClick={() =>
          m.add.mutate(
            { kind: 'note', title: title.trim(), text: text.trim() },
            {
              onSuccess: () => {
                showToast({ message: t('agents.knowledge.added') });
                done();
              },
              onError: fail,
            },
          )
        }
        data-testid="agent-note-save"
      >
        {t('common.save')}
      </Button>
    </div>
  );
};
