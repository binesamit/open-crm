// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { type Blueprint, type KitIllustration, type MyAccount, type OnboardingState, t } from '@bines/shared';
import { Badge, Button, cn, Notice, SkeletonRows } from '@bines/ui';
import { errorMessage } from '../../lib/api';
import { Icon } from '../../lib/icons';
import { showToast } from '../../lib/toast';
import { type AiMessage, useOnboarding, useOnboardingActions } from './onboarding-api';

/**
 * "How to start?" (canvas screens 1–2): a full template from the owner's gallery, or "Build with
 * AI" — a short conversation that proposes a structure, previewed here and built in one go. The account's admin
 * lands here after a self sign-up; anyone may come back from the sidebar's "+" menu.
 */
export const StartPage = ({ account }: { account: MyAccount }) => {
  const state = useOnboarding(account.id);
  const actions = useOnboardingActions(account.id);
  const navigate = useNavigate();
  const [blueprint, setBlueprint] = useState<Blueprint | null>(null);
  // Each proposal is a new preview (every board back in).
  const [revision, setRevision] = useState(0);
  const [busyKit, setBusyKit] = useState<string | null>(null);
  const [kitSample, setKitSample] = useState(true);
  const goWorkspace = (workspaceId: string | null) =>
    workspaceId
      ? navigate({ to: '/a/$accountSlug/w/$workspaceId', params: { accountSlug: account.slug, workspaceId } })
      : navigate({ to: '/a/$accountSlug', params: { accountSlug: account.slug } });

  const pickKit = async (key: string) => {
    setBusyKit(key);
    try {
      const out = await actions.installKit(key, kitSample);
      showToast({ message: t('onboarding.kit.built') });
      await goWorkspace(out.workspace_id);
    } catch (e) {
      showToast({ message: errorMessage(e), tone: 'error' });
    } finally {
      setBusyKit(null);
    }
  };
  const skip = async () => {
    try {
      await actions.skip();
    } catch {
      // Closing the screen never blocks the person.
    }
    await navigate({ to: '/a/$accountSlug', params: { accountSlug: account.slug } });
  };

  if (state.isPending) return <SkeletonRows rows={6} label={t('onboarding.loading')} />;
  if (state.isError) return <Notice tone="error">{errorMessage(state.error)}</Notice>;
  const s = state.data;
  if (!s.can_build)
    return (
      <main className="w-full px-4 py-5 md:px-6">
        <Notice>{t('onboarding.adminsOnly')}</Notice>
      </main>
    );

  return (
    <main className="w-full px-4 py-5 md:px-6" data-testid="start-page">
      <div className="mx-auto flex max-w-6xl flex-col gap-5">
        <header className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            <h1 className="font-display text-[1.625rem] leading-tight font-extrabold text-heading">
              {t('onboarding.title', { account: account.name })}
            </h1>
            <p className="text-sm text-muted">{t('onboarding.subtitle')}</p>
          </div>
          <Button variant="ghost" onClick={() => void skip()} data-testid="start-skip">
            {t('onboarding.skip')}
          </Button>
        </header>
        <div className="flex flex-wrap items-stretch gap-4">
          {s.ai.available ? (
            <AiPanel
              account={account}
              chips={s.ai.chips}
              blueprint={blueprint}
              onBlueprint={(b) => {
                setBlueprint(b);
                setRevision((r) => r + 1);
              }}
            />
          ) : null}
          {s.ai.available && s.kits.length && !blueprint ? (
            <div className="flex items-center max-lg:w-full max-lg:justify-center" aria-hidden="true">
              <span className="flex size-10 items-center justify-center rounded-full bg-primary text-xs text-on-primary">
                {t('onboarding.or')}
              </span>
            </div>
          ) : null}
          {blueprint ? (
            <BlueprintPreview
              key={revision}
              account={account}
              blueprint={blueprint}
              boardsLeft={s.boards_left}
              onBack={() => setBlueprint(null)}
              onBuilt={goWorkspace}
            />
          ) : s.kits.length ? (
            <Gallery
              state={s}
              busy={busyKit}
              sample={kitSample}
              onSample={setKitSample}
              onPick={(k) => void pickKit(k)}
            />
          ) : null}
        </div>
      </div>
    </main>
  );
};

// ---- the gallery ----

/** A card's small drawing (no picture uploads: one of a few, chosen in the owner console). */
const KitArt = ({ kind }: { kind: KitIllustration }) => {
  const line = 'h-1.5 rounded-full bg-line-soft';
  return (
    <div className="flex h-24 items-end justify-center bg-primary-soft" aria-hidden="true">
      <div className="flex h-[76px] w-[78%] flex-col gap-1.5 rounded-t-md bg-surface p-2.5">
        {kind === 'chart' ? (
          <div className="flex h-full items-end gap-1">
            {[40, 70, 55, 90, 35, 65].map((h, i) => (
              <span key={i} className="flex-1 rounded-sm bg-primary/70" style={{ height: `${h}%` }} />
            ))}
          </div>
        ) : kind === 'kanban' ? (
          <div className="grid h-full grid-cols-3 gap-1.5">
            {[3, 2, 1].map((n, i) => (
              <div key={i} className="flex flex-col gap-1">
                {Array.from({ length: n }, (_, k) => (
                  <span key={k} className="h-3 rounded-sm border border-line" />
                ))}
              </div>
            ))}
          </div>
        ) : kind === 'timeline' ? (
          <div className="flex h-full flex-col justify-center gap-1.5">
            {[
              [0, 50],
              [25, 45],
              [45, 50],
            ].map(([s, w], i) => (
              <span
                key={i}
                className="h-2 rounded-full bg-accent"
                style={{ marginInlineStart: `${s}%`, width: `${w}%` }}
              />
            ))}
          </div>
        ) : kind === 'calendar' ? (
          <div className="grid h-full grid-cols-7 gap-0.5">
            {Array.from({ length: 21 }, (_, i) => (
              <span key={i} className={cn('rounded-[2px]', i % 5 === 2 ? 'bg-accent' : 'bg-line-soft')} />
            ))}
          </div>
        ) : kind === 'blank' ? (
          <div className="flex h-full items-center justify-center rounded border border-dashed border-line-strong">
            <Icon name="plus" size={16} />
          </div>
        ) : (
          <>
            <span className="h-1.5 w-1/2 rounded-full bg-primary/70" />
            <span className={cn(line, 'w-[90%]')} />
            <span className={cn(line, 'w-3/4')} />
            <span className={cn(line, 'w-[82%]')} />
          </>
        )}
      </div>
    </div>
  );
};

const Gallery = ({
  state,
  busy,
  sample,
  onSample,
  onPick,
}: {
  state: OnboardingState;
  busy: string | null;
  sample: boolean;
  onSample: (v: boolean) => void;
  onPick: (key: string) => void;
}) => (
  <section className="flex min-w-0 flex-[999_1_480px] flex-col gap-3" aria-labelledby="start-gallery">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h2 id="start-gallery" className="text-lg text-heading">
        {t('onboarding.gallery.title')}
      </h2>
      <label className="flex items-center gap-1.5 text-[13px] text-fg-2">
        <input
          type="checkbox"
          checked={sample}
          onChange={() => onSample(!sample)}
          className="accent-[var(--check)]"
          data-testid="start-kit-sample"
        />
        {t('onboarding.gallery.sample')}
      </label>
    </div>
    <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-3" data-testid="start-gallery">
      {state.kits.map((k) => {
        const tooMany = state.boards_left !== null && k.boards > state.boards_left;
        return (
          <button
            key={k.key}
            type="button"
            disabled={!!busy || k.installed || tooMany}
            onClick={() => onPick(k.key)}
            data-testid={`start-kit-${k.key}`}
            className="flex flex-col overflow-hidden rounded-xl border border-line bg-surface text-start transition-colors hover:border-line-strong disabled:opacity-60"
          >
            <KitArt kind={k.gallery.illustration} />
            <span className="flex flex-col gap-1 px-3.5 py-3">
              <span className="flex items-center gap-2">
                <span className="text-[15px] text-heading">{k.name}</span>
                {k.gallery.recommended ? <Badge tone="warn">{t('onboarding.gallery.recommended')}</Badge> : null}
              </span>
              {k.description ? <span className="text-[13px] leading-snug text-muted">{k.description}</span> : null}
              <span className="text-xs text-muted">
                {k.installed
                  ? t('onboarding.gallery.installed')
                  : tooMany
                    ? t('onboarding.gallery.tooMany', { n: k.boards })
                    : busy === k.key
                      ? t('onboarding.gallery.building')
                      : t('onboarding.gallery.boards', { n: k.boards })}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  </section>
);

// ---- build with AI ----

const AiPanel = ({
  account,
  chips,
  blueprint,
  onBlueprint,
}: {
  account: MyAccount;
  chips: string[];
  blueprint: Blueprint | null;
  onBlueprint: (b: Blueprint) => void;
}) => {
  const actions = useOnboardingActions(account.id);
  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView({ block: 'nearest' }), [messages.length]);
  const send = async (said: string) => {
    const line = said.trim();
    if (!line || busy) return;
    const next: AiMessage[] = [...messages, { role: 'user' as const, text: line }].slice(-16);
    setMessages(next);
    setText('');
    setBusy(true);
    try {
      const reply = await actions.ask(next, blueprint);
      if (reply.text) setMessages((m) => [...m, { role: 'assistant' as const, text: reply.text }].slice(-16));
      if (reply.blueprint) onBlueprint(reply.blueprint);
    } catch (e) {
      showToast({ message: errorMessage(e), tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="flex min-h-[420px] min-w-0 flex-[1_1_380px] flex-col rounded-xl border border-line bg-surface lg:max-w-[460px]"
      aria-labelledby="start-ai"
      data-testid="start-ai"
    >
      <div className="flex items-center gap-3 border-b border-line-soft px-4 py-3.5">
        <span className="flex size-10 items-center justify-center rounded-full bg-primary-soft text-heading">
          <Icon name="sparkle" size={20} />
        </span>
        <div className="flex min-w-0 flex-col">
          <h2 id="start-ai" className="text-lg text-heading">
            {t('onboarding.ai.title')}
          </h2>
          <span className="text-[13px] text-muted">{t('onboarding.ai.subtitle')}</span>
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-4" aria-live="polite">
        <p className="max-w-[90%] self-start rounded-xl bg-surface-2 px-3.5 py-2.5 text-[15px] leading-relaxed">
          {t('onboarding.ai.question')}
        </p>
        {messages.length === 0 ? (
          <div className="flex flex-wrap gap-2">
            {chips.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => void send(c)}
                className="rounded-full border border-line-strong bg-surface px-3.5 py-2 text-sm hover:bg-surface-2"
              >
                {c}
              </button>
            ))}
          </div>
        ) : null}
        {messages.map((m, i) => (
          <p
            key={i}
            className={cn(
              'max-w-[90%] rounded-xl px-3.5 py-2.5 text-[15px] leading-relaxed whitespace-pre-line',
              m.role === 'user' ? 'self-end bg-primary text-on-primary' : 'self-start bg-surface-2',
            )}
          >
            {m.text}
          </p>
        ))}
        {busy ? <p className="self-start text-sm text-muted">{t('onboarding.ai.thinking')}</p> : null}
        <div ref={end} />
      </div>
      <form
        className="flex items-center gap-2 border-t border-line-soft px-4 py-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send(text);
        }}
      >
        <label htmlFor="start-ai-input" className="sr-only">
          {t('onboarding.ai.inputLabel')}
        </label>
        <input
          id="start-ai-input"
          value={text}
          maxLength={2000}
          onChange={(e) => setText(e.target.value)}
          placeholder={blueprint ? t('onboarding.ai.changePlaceholder') : t('onboarding.ai.placeholder')}
          className="h-11 min-w-0 flex-1 rounded-[10px] border border-line-strong bg-surface px-3 text-sm"
          data-testid="start-ai-input"
        />
        <Button type="submit" variant="accent" busy={busy} aria-label={t('onboarding.ai.send')}>
          <Icon name="send" size={16} />
        </Button>
      </form>
    </section>
  );
};

const BlueprintPreview = ({
  account,
  blueprint,
  boardsLeft,
  onBack,
  onBuilt,
}: {
  account: MyAccount;
  blueprint: Blueprint;
  boardsLeft: number | null;
  onBack: () => void;
  onBuilt: (workspaceId: string) => unknown;
}) => {
  const actions = useOnboardingActions(account.id);
  const [skip, setSkip] = useState<string[]>([]);
  const [sample, setSample] = useState(true);
  const [busy, setBusy] = useState(false);
  const chosen = blueprint.boards.filter((b) => !skip.includes(b.key));
  const over = boardsLeft !== null && chosen.length > boardsLeft;
  const build = async () => {
    setBusy(true);
    try {
      const built = await actions.build(blueprint, skip, sample);
      showToast({
        message: t('onboarding.build.done'),
        seconds: 10,
        action: {
          label: t('onboarding.build.undo'),
          run: () =>
            actions
              .removeBuilt(built)
              .then(() => showToast({ message: t('onboarding.build.undone') }))
              .catch((e: unknown) => showToast({ message: errorMessage(e), tone: 'error' })),
        },
      });
      if (built.issues.length) showToast({ message: t('onboarding.build.partial') });
      await onBuilt(built.workspace_id);
    } catch (e) {
      showToast({ message: errorMessage(e), tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="flex min-w-0 flex-[999_1_480px] flex-col rounded-xl border border-line bg-surface"
      aria-labelledby="start-preview"
      data-testid="start-preview"
    >
      <div className="flex flex-wrap items-center gap-3 border-b border-line-soft px-5 py-3.5">
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 id="start-preview" className="text-lg text-heading">
            {t('onboarding.preview.title', { name: blueprint.workspace_name })}
          </h2>
          <span className="text-[13px] text-muted">
            {t('onboarding.preview.summary', {
              boards: chosen.length,
              widgets: blueprint.dashboard?.widgets.length ?? 0,
            })}
          </span>
        </div>
        {boardsLeft !== null ? (
          <span
            className={cn(
              'rounded-lg px-2.5 py-1 text-xs',
              over ? 'bg-danger-soft text-danger-fg' : 'bg-primary-soft text-fg-2',
            )}
          >
            {t('onboarding.preview.planBoards', { n: chosen.length, left: boardsLeft })}
          </span>
        ) : null}
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] content-start gap-3 px-5 py-4">
        {blueprint.boards.map((b) => {
          const on = !skip.includes(b.key);
          return (
            <div
              key={b.key}
              className={cn('flex flex-col gap-2 rounded-[10px] border border-line px-3.5 py-3', !on && 'opacity-55')}
              data-testid={`start-board-${b.key}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[15px] text-heading">{b.name}</span>
                <label className="flex items-center gap-1.5 text-xs text-muted">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => setSkip((s) => (on ? [...s, b.key] : s.filter((k) => k !== b.key)))}
                    className="accent-[var(--check)]"
                  />
                  {t('onboarding.preview.include')}
                </label>
              </div>
              <span className="text-xs text-muted">
                {t('onboarding.preview.groups', { groups: b.groups.map((g) => g.title).join(' · ') })}
              </span>
              {b.views?.length ? (
                <span className="text-xs text-muted">
                  {t('onboarding.preview.views', { views: b.views.map((v) => v.name).join(' · ') })}
                </span>
              ) : null}
              <div className="flex flex-wrap gap-1.5">
                {b.columns.map((c) => (
                  <span key={c.title} className="rounded-md bg-surface-2 px-2 py-0.5 text-xs text-fg-2">
                    {c.title}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
        {blueprint.automations?.length ? (
          <div
            className="flex flex-col gap-1.5 rounded-[10px] border border-line px-3.5 py-3"
            data-testid="start-automations"
          >
            <span className="text-[15px] text-heading">{t('onboarding.preview.automations')}</span>
            {blueprint.automations.map((au, i) => (
              <span key={i} className="text-[13px] text-fg-2">
                {au.title}
              </span>
            ))}
          </div>
        ) : null}
        {blueprint.docs?.length ? (
          <div className="flex flex-col gap-1.5 rounded-[10px] border border-line px-3.5 py-3">
            <span className="text-[15px] text-heading">{t('onboarding.preview.docs')}</span>
            {blueprint.docs.map((d) => (
              <span key={d.name} className="text-[13px] text-fg-2">
                {d.name}
              </span>
            ))}
          </div>
        ) : null}
        {blueprint.dashboard ? (
          <div className="flex flex-col gap-1.5 rounded-[10px] border border-line px-3.5 py-3">
            <span className="text-[15px] text-heading">
              {t('onboarding.preview.dashboard', { name: blueprint.dashboard.name })}
            </span>
            <span className="text-[13px] text-fg-2">{blueprint.dashboard.widgets.map((w) => w.title).join(' · ')}</span>
          </div>
        ) : null}
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-3 border-t border-line-soft px-5 py-3.5">
        <Button
          variant="accent"
          busy={busy}
          disabled={!chosen.length || over}
          onClick={() => void build()}
          data-testid="start-build"
        >
          {t('onboarding.preview.build')}
        </Button>
        <label className="flex items-center gap-1.5 text-[13px] text-fg-2">
          <input
            type="checkbox"
            checked={sample}
            onChange={() => setSample((v) => !v)}
            className="accent-[var(--check)]"
          />
          {t('onboarding.preview.sample')}
        </label>
        <Button variant="ghost" onClick={onBack}>
          {t('onboarding.preview.back')}
        </Button>
        <span className="ms-auto text-xs text-muted">{t('onboarding.preview.oneUndo')}</span>
      </div>
    </section>
  );
};
