// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, type RefObject } from 'react';

/**
 * Stack of open floating layers (popovers, menus, flyouts). Layers render in a portal on <body>, so they never sit
 * under later rows of a table — but then a nested layer is no longer a DOM descendant of the one that opened it.
 * The stack restores the nesting: an outside press closes a layer only if it landed outside that layer and every
 * layer opened after it, and Esc goes to the top layer only.
 *
 * Round 9 ("a menu that stays open when I click elsewhere disturbs"): every menu and popover closes on a
 * press anywhere outside it — the press still does its own thing (nothing is swallowed), so clicking another
 * button both closes the menu and presses that button, and only one menu stays open. A press is taken at
 * `pointerdown` (an element that cancels pointerdown — a drag handle — suppresses the mouse events after it) and
 * at `mousedown` (synthetic presses), once. Focus moving into an iframe (an embedded preview) closes them too.
 * r25: on a touch screen the tap that closed a layer is swallowed (see `TAP_GUARD_MS`).
 */
type Layer = {
  els: () => (HTMLElement | null | undefined)[];
  close: () => void;
  /** Returns `false` when the layer leaves this Esc to the element that has the focus. */
  escape: () => boolean | void;
};
const stack: Layer[] = [];

/** A menu or popover is open: it gets Esc / outside clicks first (a dialog under it stays open). */
export const hasOpenLayers = () => stack.length > 0;

/**
 * A layer is open above this element — inside it or opened after it (a menu opened from a dialog). A layer that
 * was open before it (the sidebar flyout a dialog was opened from) is under it and leaves it its Esc and clicks.
 */
export const layersAbove = (el: Element | null | undefined) =>
  !el
    ? hasOpenLayers()
    : stack.some((layer) =>
        layer
          .els()
          .some(
            (own) =>
              !!own && (el.contains(own) || !!(el.compareDocumentPosition(own) & Node.DOCUMENT_POSITION_FOLLOWING)),
          ),
      );

/** Presses that closed a layer: they must not also close what is under it (a dialog's backdrop). */
const consumed = new WeakSet<Event>();
export const closedALayer = (e: Event) => consumed.has(e);

/**
 * The last press that closed a layer — a menu's trigger reads it (once, from the click of that press) so pressing
 * it again toggles the menu shut instead of reopening it.
 */
let lastPress: { target: Node; time: number } | null = null;
export const pressClosedLayer = (el: Element, withinMs = 1000) => {
  const hit = !!lastPress && el.contains(lastPress.target) && performance.now() - lastPress.time < withinMs;
  if (hit) lastPress = null; // one press, one click
  return hit;
};

/**
 * A press inside a modal opened after the layer (a dialog opened from a menu or from the sidebar flyout) counts as
 * inside: portals land at the end of <body>, so "after" is document order.
 */
const inLaterModal = (layer: Layer, target: Node) => {
  const modal = (target instanceof Element ? target : target.parentElement)?.closest(
    '[aria-modal="true"], [data-modal-root]',
  );
  if (!modal) return false;
  const own = layer.els().find((el): el is HTMLElement => !!el);
  return !!own && !modal.contains(own) && !!(own.compareDocumentPosition(modal) & Node.DOCUMENT_POSITION_FOLLOWING);
};

/**
 * r25 (product fix: "on the phone, a tap on the screen to close a menu opens another item"): on a touch
 * screen the tap that closes a layer (a menu, a popover, a cell's bottom sheet) is only that — its click (and the
 * compatibility mouse presses) never reach what lies under it (the row's item card, another cell). The next tap
 * does its own thing: tapping another cell on purpose opens it on the second tap. A mouse
 * keeps round 9 (the press closes the menu and presses what it landed on).
 * The guard is armed at the pointerdown that closed a layer and swallows the first click that follows, until
 * `TAP_GUARD_MS` after the finger lifts (or `TAP_GUARD_HOLD_MS` without a lift); a scroll (pointercancel) disarms it.
 */
export const TAP_GUARD_MS = 350;
export const TAP_GUARD_HOLD_MS = 1500;
export type TapGuard = { down: number; up: number | null } | null;
export const tapGuardArm = (now: number): TapGuard => ({ down: now, up: null });
export const tapGuardLift = (g: TapGuard, now: number): TapGuard => (g && g.up === null ? { ...g, up: now } : g);
/** Whether a click (or mouse press) at `now` belongs to the tap that closed a layer. */
export const tapGuardActive = (g: TapGuard, now: number) =>
  !!g && (g.up === null ? now - g.down < TAP_GUARD_HOLD_MS : now - g.up < TAP_GUARD_MS);

let tapGuard: TapGuard = null;
const GUARD_EVENTS = ['click', 'mousedown', 'mouseup'] as const;
let guardTimer: ReturnType<typeof setTimeout> | undefined;
const disarmTapGuard = () => {
  tapGuard = null;
  clearTimeout(guardTimer);
  for (const type of GUARD_EVENTS) window.removeEventListener(type, swallowTap, true);
  window.removeEventListener('pointerup', onGuardUp, true);
  window.removeEventListener('pointercancel', disarmTapGuard, true);
};
function swallowTap(e: Event) {
  if (!tapGuardActive(tapGuard, performance.now())) return disarmTapGuard();
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
  if (e.type === 'click') disarmTapGuard();
}
function onGuardUp() {
  tapGuard = tapGuardLift(tapGuard, performance.now());
}
const armTapGuard = () => {
  disarmTapGuard();
  tapGuard = tapGuardArm(performance.now());
  // Window, capture: before React's root listener and anything else on the page.
  for (const type of GUARD_EVENTS) window.addEventListener(type, swallowTap, true);
  window.addEventListener('pointerup', onGuardUp, true);
  window.addEventListener('pointercancel', disarmTapGuard, true);
  // No click came (a long press, a drag): the guard never outlives the tap.
  guardTimer = setTimeout(disarmTapGuard, TAP_GUARD_HOLD_MS + TAP_GUARD_MS);
};

/** The pointerdown already handled (its mousedown follows with the same target). */
let handled: { target: EventTarget | null; time: number; closed: boolean } | null = null;

const closeFrom = (target: Node, e: Event) => {
  let closed = false;
  // Top-down: close layers until one contains the press (it and those below it stay open).
  for (let i = stack.length - 1; i >= 0; i--) {
    const layer = stack[i]!;
    if (layer.els().some((el) => el?.contains(target)) || inLaterModal(layer, target)) break;
    consumed.add(e);
    closed = true;
    layer.close();
  }
  if (closed) lastPress = { target, time: performance.now() };
  return closed;
};

const onPointerDown = (e: PointerEvent) => {
  const closed = closeFrom(e.target as Node, e);
  handled = { target: e.target, time: performance.now(), closed };
  // r25: a tap that closed a layer on a touch screen does nothing else.
  if (closed && e.pointerType !== 'mouse') armTapGuard();
};
const onMouseDown = (e: MouseEvent) => {
  const prev = handled;
  handled = null;
  if (prev && prev.target === e.target && performance.now() - prev.time < 1500) {
    if (prev.closed) consumed.add(e);
    return;
  }
  closeFrom(e.target as Node, e);
};
const onKey = (e: KeyboardEvent) => {
  if (e.key !== 'Escape' || !stack.length) return;
  // The focus is in a dialog opened above the top layer: the dialog takes its Esc.
  const focused = document.activeElement;
  if (focused && inLaterModal(stack.at(-1)!, focused)) return;
  if (stack.at(-1)!.escape() === false) return;
  e.stopPropagation(); // not the item card drawer behind
  e.preventDefault();
};
/** The window lost focus to an iframe inside it: a press there never reaches the document. */
const onBlur = () =>
  setTimeout(() => {
    if (document.activeElement?.tagName !== 'IFRAME') return;
    for (let i = stack.length - 1; i >= 0; i--) stack[i]!.close();
  }, 0);

/**
 * Registers an open layer; `onEscape` defaults to `onClose` (a menu uses it to leave a submenu first; returning
 * `false` lets the Esc go on to the focused element, e.g. an inline rename field inside a flyout).
 * `anchor` counts as inside: clicking the button that opened a panel lets that button close it, instead of the
 * outside click closing it and the button's click opening it again.
 */
export const useLayer = (
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onClose: () => void,
  onEscape?: () => boolean | void,
  anchor?: () => HTMLElement | null | undefined,
) => {
  const handlers = useRef({ onClose, onEscape, anchor });
  useEffect(() => {
    handlers.current = { onClose, onEscape, anchor };
  });
  useEffect(() => {
    if (!open) return;
    const layer: Layer = {
      els: () => [ref.current, handlers.current.anchor?.()],
      close: () => handlers.current.onClose(),
      escape: () => (handlers.current.onEscape ?? handlers.current.onClose)(),
    };
    if (!stack.length) {
      // Capture phase: an ancestor that stops mousedown/keydown (the item card) must not keep layers open.
      document.addEventListener('pointerdown', onPointerDown, true);
      document.addEventListener('mousedown', onMouseDown, true);
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('blur', onBlur);
    }
    stack.push(layer);
    return () => {
      stack.splice(stack.indexOf(layer), 1);
      if (!stack.length) {
        document.removeEventListener('pointerdown', onPointerDown, true);
        document.removeEventListener('mousedown', onMouseDown, true);
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('blur', onBlur);
        handled = null;
      }
    };
  }, [open, ref]);
};

/**
 * Round 13 ("Esc closes the open item / subitem card"): side panels that Esc closes — the item card, the doc
 * side panel. They are not menus: what has the focus inside them gets the Esc first, and the panel closes only
 * when nothing used it.
 * - an open menu / popover / picker closes first (the layer stack above, capture phase, stops the event);
 * - a field that handles Esc itself (the card's title, the editor's @-mention list) cancels first
 *   (`defaultPrevented`; a rich-text editor marks it — `markEscapeUsed`) and the panel stays;
 * - a text field / editor that ignores Esc — or a cell editor that cancelled and is gone — gives the focus back to
 *   the panel, so typing is never thrown away;
 * - the next Esc (the focus on the panel, or nowhere) closes the panel. Only the last opened panel reacts.
 * Listens on document in the bubble phase, after React's own key handlers.
 */
export type PanelEscape = 'close' | 'blur' | 'ignore';

/** The element the Esc came from, as far as the decision needs it (a plain object in unit tests). */
export type EscapeTarget = { tagName: string; type?: string; isContentEditable?: boolean };

const TEXT_INPUTS = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number', 'date', 'time']);

/** Whether this element takes typing (an editor that an Esc must not close the panel under). */
export const isTextField = (el: EscapeTarget | null | undefined) => {
  if (!el) return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  return el.tagName === 'INPUT' && TEXT_INPUTS.has((el.type ?? '').toLowerCase());
};

/**
 * What an Esc does to the top panel. `handled` = a field already used it (`defaultPrevented`); `layersOpen` = a
 * menu / popover is open over the panel; `dialogOver` = a modal dialog is (it takes its own Esc).
 */
export const panelEscape = (o: {
  target: EscapeTarget | null;
  handled: boolean;
  layersOpen: boolean;
  dialogOver: boolean;
}): PanelEscape => {
  if (o.handled || o.layersOpen || o.dialogOver) return 'ignore';
  return isTextField(o.target) ? 'blur' : 'close';
};

/**
 * Esc presses a rich-text editor really used (closed its @-mention list). ProseMirror cancels every Esc
 * (prosemirror-view's `captureKeyDown`), so for an editor `defaultPrevented` says nothing — it marks the ones it used.
 */
const usedEscapes = new WeakSet<Event>();
export const markEscapeUsed = (e: Event) => void usedEscapes.add(e);

/** Whether a field already used this Esc: it cancelled it — or, inside a rich-text editor, marked it. */
export const escapeUsed = (o: { defaultPrevented: boolean; marked: boolean; inRichEditor: boolean }) =>
  o.marked || (o.defaultPrevented && !o.inRichEditor);

type EscPanel = { el: () => HTMLElement | null; close: () => void };
const panels: EscPanel[] = [];

/** The z-index of the fixed layer an element is in (its own or its nearest fixed ancestor's); 0 when none. */
const stackZ = (el: Element) => {
  for (let n: Element | null = el; n; n = n.parentElement) {
    const s = getComputedStyle(n);
    if (s.position === 'fixed') return Number(s.zIndex) || 0;
  }
  return 0;
};

const onPanelKey = (e: KeyboardEvent) => {
  if (e.key !== 'Escape' || !panels.length) return;
  const top = panels.at(-1)!;
  const el = top.el();
  const target = e.target instanceof HTMLElement ? e.target : null;
  const action = panelEscape({
    target,
    handled: escapeUsed({
      defaultPrevented: e.defaultPrevented,
      marked: usedEscapes.has(e),
      inRichEditor: !!target?.closest('.ProseMirror'),
    }),
    // Layers other than the panel itself (the doc panel is a layer too, for its outside clicks).
    layersOpen: stack.some((layer) => !layer.els().includes(el)),
    // P1-03: a dialog the panel sits over (an item card opened from a popup, `z-panel-over-modal`) is under it.
    dialogOver:
      !!el &&
      Array.from(document.querySelectorAll('[data-modal-root], [aria-modal="true"]')).some(
        (m) =>
          !m.contains(el) &&
          !!(el.compareDocumentPosition(m) & Node.DOCUMENT_POSITION_FOLLOWING) &&
          stackZ(m) >= stackZ(el),
      ),
  });
  if (action === 'ignore') return;
  e.preventDefault();
  if (action === 'blur') {
    // Back to the panel: the next Esc closes it.
    if (target?.isConnected) target.blur();
    el?.focus({ preventScroll: true });
    return;
  }
  top.close();
};

/** Registers an open side panel that Esc closes (see above). `ref` = the panel (focusable: `tabIndex={-1}`). */
export const useEscapeClose = (ref: RefObject<HTMLElement | null>, open: boolean, onClose: () => void) => {
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    if (!open) return;
    const panel: EscPanel = { el: () => ref.current, close: () => close.current() };
    if (!panels.length) document.addEventListener('keydown', onPanelKey);
    panels.push(panel);
    return () => {
      panels.splice(panels.indexOf(panel), 1);
      if (!panels.length) document.removeEventListener('keydown', onPanelKey);
    };
  }, [open, ref]);
};

/**
 * P1-03 — panels over dialogs: an item card opened while a dialog is open (a linked item clicked in a popup) goes
 * over that dialog, which stays open under it. Every dialog and such panel takes a number when it opens; a dialog
 * leaves its Esc and Tab to a panel opened after it, and a dialog opened after the panel (from the card) goes over it.
 */
let opened = 0;
const panelsOverModal: number[] = [];
export const nextLayerSeq = () => ++opened;
/** A card over a dialog is open now (a dialog opening now goes over it). */
export const panelOverModalOpen = () => panelsOverModal.length > 0;
/** A card over a dialog was opened after this dialog: the dialog leaves it its keys. */
export const panelOverDialog = (dialogSeq: number) => panelsOverModal.some((p) => p > dialogSeq);
/** For an item card: is a dialog open as it opens? Then it sits over it (`z-panel-over-modal`). */
export const dialogOpenNow = () => typeof document !== 'undefined' && !!document.querySelector('[data-modal-root]');
export const usePanelOverModal = (on: boolean) => {
  useEffect(() => {
    if (!on) return;
    const me = nextLayerSeq();
    panelsOverModal.push(me);
    return () => {
      panelsOverModal.splice(panelsOverModal.indexOf(me), 1);
    };
  }, [on]);
};
