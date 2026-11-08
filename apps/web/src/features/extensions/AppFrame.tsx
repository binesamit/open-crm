// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  APP_PAGE_BADGE_MAX,
  EXT_PROTOCOL,
  EXT_PROTOCOL_VERSION,
  t,
  type DraftRecipe,
  type ExtensionBlocks,
  type ExtensionBoardView,
} from '@bines/shared';
import { Dialog, Notice } from '@bines/ui';
import { useLocale } from '../../lib/locale';
import { api } from '../../lib/api';
import { useTheme } from '../../lib/theme';
import { showToast } from '../../lib/toast';
import { automationKeys } from '../automations/automations-api';
import { appPagesKey } from './app-pages';
import { mintFeatureToken, type TokenPlace } from './extensions-api';
import {
  automationBuilderRequest,
  automationToggleAllowed,
  automationToggleRequest,
  frameMessage,
  frameUrlOk,
  jsonCopy as copyJson,
  modalUrl,
} from './frame-protocol';
import {
  ExtensionAutomationBuilder,
  extensionTriggerDraft,
  type AutomationBuilderResult,
} from './ExtensionAutomationBuilder';

/**
 * An extension's page (D27 ת2–ת5) — the host side of `@bines/ext-sdk`, for every slot: a board view, an item tab,
 * a menu / batch action in a modal frame, a dashboard widget, a settings page. Three layers keep it apart from us
 * (MARKETPLACE §4.2):
 * 1. **Its own origin**: the page loads from the extension's origin (never ours — the server refuses that), so it
 *    has no access to our cookies, storage or DOM. `allow-same-origin` only gives it *its own* origin, so it can be
 *    told apart in postMessage and CORS; without it every extension would share the opaque origin "null".
 * 2. **sandbox** without top navigation, modals or popups escaping the sandbox; `referrerpolicy=no-referrer`;
 * no device permissions but keeping the screen on (`allow="screen-wake-lock"` — a workout timer).
 * 3. **CSP**: the page's `frame-src` lists only the account's enabled extension origins (server side).
 * Messages are accepted only from this frame's window **and** its origin, and sent only to that origin. The token
 * goes by postMessage (never in the URL), is minted for this place (a board / a widget / the settings page),
 * scoped, and minutes long. A modal it opens is another page of the **same origin**, in its own frame.
 */
const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads';
const MIN_H = 160;
const MAX_H = 6000;
/** Requests a frame may make per 10 seconds (anything above is ignored). */
const BUDGET = 80;
const ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
/** What `closeModal(result)` may hand back (JSON, this big at most). */
const RESULT_MAX = 64 * 1024;

/** The feature as the frame needs it (a board view, or any entry of GET /extensions/features). */
export type FrameView = Pick<
  ExtensionBoardView,
  'installation_id' | 'extension_key' | 'extension_name' | 'feature' | 'name' | 'url' | 'origin'
>;

/** What the page learns about where it is (on top of account, user, theme, language). */
export type FrameContext = {
  surface:
    | 'board_view'
    | 'item_view'
    | 'board_menu_action'
    | 'batch_action'
    | 'dashboard_widget'
    | 'account_settings_page'
    | 'user_settings_page'
    | 'panel'
    | 'app_page';
  board_id: string;
  item_id?: string | null;
  selection?: { item_ids: string[] };
  board_ids?: string[];
  dashboard_id?: string | null;
  widget_id?: string | null;
  modal?: boolean;
  params?: Record<string, unknown> | null;
};

const resolvedTheme = (theme: string): 'light' | 'dark' =>
  theme === 'dark' || (theme === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches)
    ? 'dark'
    : 'light';

/** A blocked frame (the page's CSP was built before this extension was enabled here): reload once to get it. */
const reloadOnceFor = (origin: string) => {
  const key = `bines:ext-csp-reload:${origin}`;
  try {
    const last = Number(sessionStorage.getItem(key) ?? 0);
    if (Date.now() - last < 60_000) return false;
    sessionStorage.setItem(key, String(Date.now()));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
};

/** A JSON-safe copy of what a page handed us, or undefined (functions, cycles, too big). */
const jsonCopy = (v: unknown): unknown => copyJson(v, RESULT_MAX);

const clamp = (n: unknown, lo: number, hi: number, dflt: number) => {
  const x = Number(n);
  return Number.isFinite(x) ? Math.min(hi, Math.max(lo, Math.round(x))) : dflt;
};

/** The surfaces whose context names the boards their token reads. */
const BOARD_LIST_SURFACES: ReadonlySet<string> = new Set(['dashboard_widget', 'board_view', 'panel', 'app_page']);

/**
 * A widget's, a board view's, a panel's or a sidebar page's context names the boards its token reads
 * (`ExtContext.board_ids`), as the server minted them (a board view: its board plus the boards picked for the tab —
 * a panel or a sidebar page: the installation's boards this member reads).
 */
const withBoards = <C extends { surface: FrameContext['surface'] }>(c: C, boards: string[] | null) =>
  c.surface && BOARD_LIST_SURFACES.has(c.surface) && boards ? { ...c, board_ids: boards } : c;

/** `openAutomationBuilder`: the builder open over the page, answered when it closes. */
type BuilderState = { boardId: string; draft: DraftRecipe; replyId: number; locked: string[] };

type ModalState = {
  url: string;
  width: number;
  height: number;
  params: Record<string, unknown> | null;
  replyId: number;
};

export const AppFrame = ({
  accountId,
  view,
  place,
  context: where,
  user,
  onOpenItem,
  onCloseModal,
  initialHeight = 520,
  fill = false,
  onPickBoards,
}: {
  accountId: string;
  view: FrameView;
  /** Where the token is for: the board, the widget, or nothing (settings page). */
  place: TokenPlace;
  context: FrameContext;
  user: { id: string; name: string };
  onOpenItem?: (itemId: string) => void;
  /** Set when this frame is a modal: `closeModal(result)` from the page calls it. */
  onCloseModal?: (result: unknown) => void;
  initialHeight?: number;
  /** Fill the container's height (a widget) instead of following the page's own height. */
  fill?: boolean;
  /**
   * A board view's "which boards may this tab use": the app's own dialog, opened when the page asks
   * (`pickBoards`). Resolves with the chosen boards, or null when the person closed it.
   */
  onPickBoards?: () => Promise<string[] | null>;
}) => {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(initialHeight);
  const [blocked, setBlocked] = useState(false);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [builder, setBuilder] = useState<BuilderState | null>(null);
  const [theme] = useTheme();
  const locale = useLocale();
  const started = useRef(false);
  const qc = useQueryClient();
  const context = {
    account_id: accountId,
    installation_id: view.installation_id,
    extension_key: view.extension_key,
    feature: view.feature,
    user,
    theme: resolvedTheme(theme),
    locale,
    dir: locale === 'he' ? 'rtl' : 'ltr',
    ...where,
  };
  const ctxRef = useRef(context);
  /** A widget's boards, as its last token was minted for them (the context tells the page what it may read). */
  const boardsRef = useRef<string[] | null>(null);
  const openRef = useRef(onOpenItem);
  const closeRef = useRef(onCloseModal);
  const pickRef = useRef(onPickBoards);
  const sendRef = useRef<((msg: Record<string, unknown>) => void) | null>(null);
  const modalRef = useRef<ModalState | null>(null);
  const builderRef = useRef<BuilderState | null>(null);
  useEffect(() => {
    ctxRef.current = context;
    openRef.current = onOpenItem;
    closeRef.current = onCloseModal;
    pickRef.current = onPickBoards;
    modalRef.current = modal;
    builderRef.current = builder;
  });
  const placeKey = JSON.stringify(place);

  const urlOk = frameUrlOk(view.url, view.origin, window.location.origin);

  useEffect(() => {
    if (!urlOk) return;
    const origin = view.origin;
    const tokenPlace = JSON.parse(placeKey) as TokenPlace;
    const send = (msg: Record<string, unknown>) =>
      ref.current?.contentWindow?.postMessage({ protocol: EXT_PROTOCOL, v: EXT_PROTOCOL_VERSION, ...msg }, origin);
    sendRef.current = send;
    const token = async () => {
      const tok = await mintFeatureToken(accountId, view.installation_id, view.feature, tokenPlace);
      boardsRef.current = tok.board_ids;
      return { token: tok.token, expires_at: tok.expires_at, api_base: tok.api_base, scopes: tok.scopes };
    };
    let windowStart = Date.now();
    let used = 0;
    let notices = 0;
    let openingBuilder = false;
    const onMessage = async (e: MessageEvent) => {
      const m = frameMessage(e, ref.current?.contentWindow, origin);
      if (!m) return;
      if (Date.now() - windowStart > 10_000) {
        windowStart = Date.now();
        used = 0;
        notices = 0;
      }
      if (++used > BUDGET) return;
      if (m.type === 'ready') {
        try {
          const tok = await token();
          send({ type: 'init', context: withBoards(ctxRef.current, boardsRef.current), token: tok });
          started.current = true;
        } catch {
          setBlocked(true);
        }
        return;
      }
      if (m.type !== 'request' || typeof m.id !== 'number') return;
      const id = m.id;
      const reply = (ok: boolean, result?: unknown, error?: string) =>
        send({ type: 'reply', id, ok, ...(ok ? { result } : { error }) });
      const p = (m.payload ?? {}) as Record<string, unknown>;
      try {
        switch (m.action) {
          case 'token':
            return reply(true, await token());
          case 'resize': {
            const h = Number(p.height);
            if (Number.isFinite(h)) setHeight(Math.min(MAX_H, Math.max(MIN_H, Math.round(h))));
            return reply(true);
          }
          case 'notice':
          case 'notify': {
            const text = typeof p.text === 'string' ? p.text.slice(0, 200) : '';
            if (text && ++notices <= 3)
              showToast({ message: `${view.extension_name}: ${text}`, tone: p.tone === 'error' ? 'error' : 'default' });
            return reply(true);
          }
          case 'openItemCard': {
            // The card loads with the user's own rights; an id is all the extension can pass.
            if (typeof p.itemId !== 'string' || !ID_RE.test(p.itemId) || !openRef.current)
              return reply(false, undefined, 'bad_item');
            openRef.current(p.itemId);
            return reply(true);
          }
          case 'openModal': {
            // Another page of the same extension, on the same origin — never anywhere else.
            // One modal at a time, and never from a modal (EXT-RT12: no endless stack of dialogs over the app).
            if (modalRef.current || ctxRef.current.modal) return reply(false, undefined, 'modal_open');
            const url = modalUrl(p.path, view.url, origin);
            if (!url) return reply(false, undefined, 'bad_path');
            const params = jsonCopy(p.params);
            setModal({
              url,
              width: clamp(p.width, 320, 1200, 560),
              height: clamp(p.height, 160, 900, 420),
              params:
                params && typeof params === 'object' && !Array.isArray(params)
                  ? (params as Record<string, unknown>)
                  : null,
              replyId: id,
            });
            return; // answered when the modal closes
          }
          case 'openAutomationBuilder': {
            // the app's own builder over the page, its trigger one of this extension's own. Like
            // openModal: one at a time, never from a modal (EXT-RT12). The member's own rights decide (the board's
            // `automation.manage`, then the server on save); what it answers is only whether one was saved, and which.
            if (modalRef.current || builderRef.current || ctxRef.current.modal || openingBuilder)
              return reply(false, undefined, 'modal_open');
            const asked = automationBuilderRequest(p, {
              extensionKey: view.extension_key,
              boardId: ctxRef.current.board_id,
              tokenBoards: boardsRef.current,
            });
            if ('error' in asked) return reply(false, undefined, asked.error);
            const client = api(accountId);
            // A second call while this one is being checked is refused too (one at a time).
            openingBuilder = true;
            const [blocks, board] = await Promise.all([
              client.get<ExtensionBlocks>(
                `/extensions/automation-blocks?board_id=${encodeURIComponent(asked.boardId)}`,
              ),
              client.get<{ capabilities: Record<string, boolean> }>(`/boards/${encodeURIComponent(asked.boardId)}`),
            ]).finally(() => (openingBuilder = false));
            const trigger = blocks.triggers.find((b) => b.block === asked.block);
            if (!trigger) return reply(false, undefined, 'bad_trigger');
            // Prefilled inputs: only the trigger's own (its manifest `inputs`).
            const known = new Set(trigger.inputs.map((f) => f.key));
            if (Object.keys(asked.inputs).some((k) => !known.has(k))) return reply(false, undefined, 'bad_input');
            if (!board.capabilities['automation.manage']) {
              showToast({ message: t('error.forbidden'), tone: 'error' });
              return reply(false, undefined, 'forbidden');
            }
            const next = {
              boardId: asked.boardId,
              draft: extensionTriggerDraft(asked.block, { with_item: asked.withItem, inputs: asked.inputs }),
              replyId: id,
              locked: Object.keys(asked.inputs),
            };
            builderRef.current = next;
            setBuilder(next);
            return; // answered when the builder closes
          }
          case 'setAutomationActive': {
            // on / off for an automation on this extension's own trigger, on a board its token reads
            // with the member's own session and right (`automation.manage`; the server checks again).
            const asked = automationToggleRequest(p);
            if ('error' in asked) return reply(false, undefined, asked.error);
            const client = api(accountId);
            const auto = await client
              .get<{ board_id: string | null; recipe: { trigger: { type: string; block?: unknown } } }>(
                `/automations/${encodeURIComponent(asked.automationId)}`,
              )
              .catch(() => null);
            if (!auto) return reply(false, undefined, 'bad_automation');
            const ok = automationToggleAllowed(auto, {
              extensionKey: view.extension_key,
              tokenBoards: boardsRef.current ?? (ctxRef.current.board_id ? [ctxRef.current.board_id] : []),
            });
            if (ok !== 'ok') return reply(false, undefined, ok);
            const board = await client.get<{ capabilities: Record<string, boolean> }>(
              `/boards/${encodeURIComponent(auto.board_id!)}`,
            );
            if (!board.capabilities['automation.manage']) {
              showToast({ message: t('error.forbidden'), tone: 'error' });
              return reply(false, undefined, 'forbidden');
            }
            const saved = await client.post<{ is_active: boolean }>(
              `/automations/${encodeURIComponent(asked.automationId)}/${asked.active ? 'activate' : 'deactivate'}`,
              {},
            );
            // The app's own lists of this board's automations follow.
            void qc.invalidateQueries({ queryKey: automationKeys.list(accountId, auto.board_id!) });
            return reply(true, { active: saved.is_active });
          }
          case 'openWindow': {
            // A page of the same extension, top level (a sign-in page will not load in a sandboxed window), with no
            // opener: never anywhere else, and only on the user's click (the browser's pop-up rules see to that).
            const url = typeof p.path === 'string' && p.path ? modalUrl(p.path, view.url, origin) : null;
            if (!url) return reply(false, undefined, 'bad_path');
            const w = clamp(p.width, 320, 1200, 520);
            const h = clamp(p.height, 320, 1000, 680);
            window.open(url, '_blank', `popup,noopener,noreferrer,width=${w},height=${h}`);
            return reply(true);
          }
          case 'setBadge': {
            // the count beside one of this extension's sidebar pages — this member's own only (the
            // server checks the page is one of its `app_page`s). `key` defaults to this page's own.
            const key = typeof p.key === 'string' && p.key ? p.key : view.feature;
            const count = p.count === null ? null : Number(p.count);
            if (
              !/^[a-z][a-z0-9_-]{0,39}$/.test(key) ||
              (count !== null && (!Number.isInteger(count) || count < 0 || count > APP_PAGE_BADGE_MAX))
            )
              return reply(false, undefined, 'bad_badge');
            await api(accountId).put(
              `/extensions/installations/${encodeURIComponent(view.installation_id)}/app-pages/${key}/badge`,
              { count },
            );
            void qc.invalidateQueries({ queryKey: appPagesKey(accountId) });
            return reply(true);
          }
          case 'pickBoards': {
            // The person picks in our dialog; the extension only learns the result. A fresh token covers them.
            if (!pickRef.current || ctxRef.current.modal) return reply(false, undefined, 'not_here');
            const chosen = await pickRef.current();
            if (chosen === null) return reply(true, null);
            await token();
            const next = withBoards(ctxRef.current, boardsRef.current);
            send({ type: 'context', context: next });
            return reply(true, { board_ids: boardsRef.current ?? [] });
          }
          case 'closeModal': {
            if (!closeRef.current) return reply(false, undefined, 'not_modal');
            reply(true);
            closeRef.current(jsonCopy(p.result));
            return;
          }
          default:
            return reply(false, undefined, 'unknown_action');
        }
      } catch {
        return reply(false, undefined, 'failed');
      }
    };
    const onViolation = (e: SecurityPolicyViolationEvent) => {
      if (!e.effectiveDirective.startsWith('frame-src') || !e.blockedURI.startsWith(origin)) return;
      if (!reloadOnceFor(origin)) setBlocked(true);
    };
    const listener = (e: MessageEvent) => void onMessage(e);
    window.addEventListener('message', listener);
    document.addEventListener('securitypolicyviolation', onViolation);
    return () => {
      window.removeEventListener('message', listener);
      document.removeEventListener('securitypolicyviolation', onViolation);
    };
  }, [accountId, placeKey, view, urlOk, qc]);

  // Theme / language changes reach a running page — and a changed context (a panel's host params).
  const whereKey = JSON.stringify(where);
  useEffect(() => {
    if (!started.current) return;
    ref.current?.contentWindow?.postMessage(
      {
        protocol: EXT_PROTOCOL,
        v: EXT_PROTOCOL_VERSION,
        type: 'context',
        context: withBoards(ctxRef.current, boardsRef.current),
      },
      view.origin,
    );
  }, [theme, locale, view.origin, whereKey]);

  const closeBuilder = (result: AutomationBuilderResult) => {
    const b = builderRef.current;
    builderRef.current = null;
    setBuilder(null);
    if (b) sendRef.current?.({ type: 'reply', id: b.replyId, ok: true, result });
    ref.current?.focus();
  };

  const closeModal = (result: unknown) => {
    const m = modalRef.current;
    setModal(null);
    if (m) sendRef.current?.({ type: 'reply', id: m.replyId, ok: true, result });
  };

  if (!urlOk || blocked)
    return (
      <div className="p-4" data-testid="ext-frame-blocked">
        <Notice tone="warn">{t('ext.frame.unavailable')}</Notice>
      </div>
    );
  return (
    <>
      <iframe
        ref={ref}
        src={view.url}
        title={view.name}
        sandbox={SANDBOX}
        referrerPolicy="no-referrer"
        allow="screen-wake-lock"
        loading="lazy"
        data-testid="ext-frame"
        data-origin={view.origin}
        data-surface={where.surface}
        className="block w-full rounded-[var(--radius)] border border-line bg-surface"
        style={fill ? { height: '100%' } : { height }}
      />
      {modal ? (
        <ExtensionModal
          accountId={accountId}
          view={{ ...view, url: modal.url }}
          place={JSON.parse(placeKey) as TokenPlace}
          context={{ ...where, modal: true, params: modal.params }}
          user={user}
          width={modal.width}
          height={modal.height}
          onOpenItem={onOpenItem}
          onClose={closeModal}
        />
      ) : null}
      {builder ? (
        <ExtensionAutomationBuilder
          accountId={accountId}
          meId={user.id}
          boardId={builder.boardId}
          draft={builder.draft}
          lockedInputs={builder.locked}
          onDone={closeBuilder}
        />
      ) : null}
    </>
  );
};

/**
 * A page of an extension in a modal frame (ת3): a menu / batch action, or `openModal` from another of its pages.
 * Closing it (✕, Esc, or `closeModal(result)` from the page) hands the result to `onClose` (undefined = dismissed).
 */
export const ExtensionModal = ({
  accountId,
  view,
  place,
  context,
  user,
  width,
  height,
  onOpenItem,
  onClose,
}: {
  accountId: string;
  view: FrameView;
  place: TokenPlace;
  context: FrameContext;
  user: { id: string; name: string };
  width: number;
  height: number;
  onOpenItem?: (itemId: string) => void;
  onClose: (result: unknown) => void;
}) => (
  <Dialog
    open
    title={view.name}
    subtitle={view.extension_name}
    onClose={() => onClose(undefined)}
    className="max-w-[min(96vw,1200px)]"
  >
    <div data-testid="ext-modal" style={{ width: `min(${width}px, 100%)` }} className="mx-auto">
      <AppFrame
        accountId={accountId}
        view={view}
        place={place}
        context={{ ...context, modal: true }}
        user={user}
        onOpenItem={onOpenItem}
        onCloseModal={onClose}
        initialHeight={height}
      />
    </div>
  </Dialog>
);
