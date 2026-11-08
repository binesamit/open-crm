// SPDX-License-Identifier: AGPL-3.0-only
import {
  forwardRef,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { t, type MessageKey } from '@bines/shared';
import { cn } from './components';
import { pressClosedLayer, useLayer } from './layers';
import { placeFloating } from './position';
import { useExitRef } from './motion';
import { autoFocusSearch } from './touch';

/**
 * Action menu (14-CONTEXT-MENUS): the same menu opens from a ⋯ button or a right click (14 §0).
 * Rendered in a portal (fixed), so scrolling containers and later rows never clip or cover it; flips to stay
 * inside the viewport. Outside click / Esc go through the shared layer stack (`useLayer`).
 * Keyboard: ↑/↓ move, Enter/Space choose, Esc or Tab close; a submenu replaces the list with a "back" row.
 * Long lists get a search field (autofocused; ↑/↓ go on to the matches, Enter picks the first, Esc clears it).
 */
export type MenuEntry =
  | {
      kind?: 'item';
      label: string;
      onSelect: () => void;
      danger?: boolean;
      disabled?: boolean;
      /** Why the row is disabled (e.g. not in the account's plan): the system tooltip (`data-tip`). */
      hint?: string;
      checked?: boolean;
      /**
       * f9 views: the row is the one in use (the current view in the phone's views dropdown) — highlighted, its
       * icon kept, a check at its end and `aria-current`. Unlike `checked`, the row stays a plain menu item.
       */
      current?: boolean;
      /** Shown at the end of the row (14: `Kbd`), e.g. "F2". */
      shortcut?: string;
      /** A 16px icon at the start of the row (F4 menus). */
      icon?: ReactNode;
      testId?: string;
      /** More words the menu's search matches besides the label (e.g. a column's type). */
      keywords?: string;
      /**
       * r17ui: choosing it leaves the menu open — a value one tries and compares (a colour theme
       * a palette, a tone). The menu closes on an outside click, Esc or Tab as usual.
       */
      keepOpen?: boolean;
    }
  | { kind: 'submenu'; label: string; items: MenuEntry[]; icon?: ReactNode; testId?: string; keywords?: string }
  | { kind: 'label'; label: string }
  | { kind: 'separator' };

/**
 * `up`: open above the point (the bottom edge of the menu on it). `selection`: the text selected inside the element
 * whose own menu replaced the browser's — the menu then starts with "Copy selected text".
 */
type Point = { x: number; y: number; up?: boolean; selection?: string };

/** The text the user selected inside `el` (empty when the selection is elsewhere or collapsed). */
export const selectedTextIn = (el: Element): string => {
  const sel = typeof window === 'undefined' ? null : window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return '';
  const range = sel.getRangeAt(0);
  if (!el.contains(range.commonAncestorContainer) && !range.intersectsNode(el)) return '';
  // Only the part inside `el` (a selection may run on past it).
  const inside = range.cloneRange();
  const whole = document.createRange();
  whole.selectNodeContents(el);
  if (inside.compareBoundaryPoints(Range.START_TO_START, whole) < 0)
    inside.setStart(whole.startContainer, whole.startOffset);
  if (inside.compareBoundaryPoints(Range.END_TO_END, whole) > 0) inside.setEnd(whole.endContainer, whole.endOffset);
  return inside.toString().trim() ? inside.toString() : '';
};

/** Copies text: the async clipboard, else the old way through a hidden field (an insecure origin, an old browser). */
export const copyToClipboard = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const field = document.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.append(field);
    field.select();
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      field.remove();
    }
  }
};

/** The menu's first rows while text is selected. */
export const withSelectionCopy = (items: MenuEntry[], selection: string | undefined): MenuEntry[] =>
  selection
    ? [
        {
          label: t('menu.copySelection' as MessageKey),
          testId: 'menu-copy-selection',
          onSelect: () => void copyToClipboard(selection),
        },
        ...(items.length ? [{ kind: 'separator' } as const] : []),
        ...items,
      ]
    : items;

export const useActionMenu = () => {
  const [at, setAt] = useState<Point | null>(null);
  // The trigger that opened the menu and when it closed: pressing that trigger while the menu is open closes it
  // (the press closes it as an outside press; its click must not open it again).
  const trigger = useRef<Element | null>(null);
  const closedAt = useRef(0);
  const rtl = () => document.documentElement.dir === 'rtl';
  const toggledShut = (el: Element) =>
    trigger.current === el && performance.now() - closedAt.current < 1000 && pressClosedLayer(el);
  return {
    at,
    close: () => {
      closedAt.current = performance.now();
      setAt(null);
    },
    /** For the ⋯ button: anchors under it, aligned to its inline-start edge. */
    fromTrigger: (e: MouseEvent<HTMLElement>) => {
      e.preventDefault();
      e.stopPropagation();
      if (toggledShut(e.currentTarget)) return;
      trigger.current = e.currentTarget;
      const r = e.currentTarget.getBoundingClientRect();
      setAt({ x: rtl() ? r.right : r.left, y: r.bottom + 4 });
    },
    /**
     * For a trigger at the bottom of the screen (the sidebar's avatar): opens above it, aligned to its
     * inline-start edge (or its end with `end`).
     */
    above: (e: MouseEvent<HTMLElement>, end = false) => {
      e.preventDefault();
      e.stopPropagation();
      if (toggledShut(e.currentTarget)) return;
      trigger.current = e.currentTarget;
      const r = e.currentTarget.getBoundingClientRect();
      setAt({ x: rtl() !== end ? r.right : r.left, y: r.top - 4, up: true });
    },
    /** For onContextMenu on the row. Text selected in it: the menu offers to copy it (the browser's is replaced). */
    onContextMenu: (e: MouseEvent<HTMLElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const selection = selectedTextIn(e.currentTarget);
      setAt({ x: e.clientX, y: e.clientY, ...(selection ? { selection } : {}) });
    },
    /** For onKeyDown on the row: Shift+F10 or the Menu key opens the same menu under it (14 §0). */
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return;
      e.preventDefault();
      e.stopPropagation();
      const r = e.currentTarget.getBoundingClientRect();
      const selection = selectedTextIn(e.currentTarget);
      setAt({ x: rtl() ? r.right : r.left, y: r.top + Math.min(r.height, 32), ...(selection ? { selection } : {}) });
    },
  };
};

/**
 * Lists longer than this get a search field on top (fix7 #3: every list of columns / types / options is
 * searchable). Counts the rows one can pick — items and submenus, not section labels or separators.
 */
export const SEARCH_THRESHOLD = 7;

/** The needle of a search: trimmed and case-folded (Hebrew has no case; Latin column names do). */
export const searchNeedle = (query: string) => query.trim().toLocaleLowerCase();

/** Whether `text` matches a needle made by `searchNeedle` (empty needle = everything). */
export const matchesSearch = (text: string, needle: string) => !needle || text.toLocaleLowerCase().includes(needle);

const SearchIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    aria-hidden
    className="shrink-0"
  >
    <circle data-icon-part="b" cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </svg>
);

/**
 * Fix: — the "X" that clears a search box; shown only while it holds text. Any search input can use it
 * (`<ClearSearchButton value={q} onClear={() => setQ('')} />`): it keeps focus in the input (mousedown is
 * prevented) and is reachable by keyboard; Esc in the field is left to the field's owner.
 */
export const ClearSearchButton = ({
  value,
  onClear,
  className,
  testId = 'search-clear',
}: {
  value: string;
  onClear: () => void;
  className?: string;
  testId?: string;
}) =>
  value ? (
    <button
      type="button"
      data-testid={testId}
      data-search-clear=""
      aria-label={t('menu.clearSearch' as MessageKey)}
      title={t('menu.clearSearch' as MessageKey)}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        e.stopPropagation();
        onClear();
      }}
      className={cn(
        'grid size-6 shrink-0 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]',
        className,
      )}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        aria-hidden
      >
        <path d="M18 6 6 18M6 6l12 12" />
      </svg>
    </button>
  ) : null;

/**
 * The search field of a list (F4 Board-AddColumn look): a bordered 34px field with a magnifier, and an "X" that
 * clears it while it holds text. A plain text input — never `type="search"`, whose clear button is browser UI.
 */
export const SearchField = forwardRef<
  HTMLInputElement,
  {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
    testId?: string;
    className?: string;
    autoFocus?: boolean;
  }
>(({ value, onChange, placeholder, onKeyDown, testId, className, autoFocus }, ref) => {
  const label = placeholder ?? t('menu.search' as MessageKey);
  const inner = useRef<HTMLInputElement | null>(null);
  const setRef = (el: HTMLInputElement | null) => {
    inner.current = el;
    if (typeof ref === 'function') ref(el);
    else if (ref) ref.current = el;
  };
  return (
    <label
      className={cn(
        'flex h-[2.125rem] items-center gap-1.5 rounded-[10px] border border-line-strong bg-surface px-2.5 text-muted focus-within:border-heading focus-within:shadow-[0_0_0_3px_var(--accent-soft)]',
        className,
      )}
    >
      <SearchIcon />
      <input
        ref={setRef}
        type="text"
        value={value}
        autoFocus={!!autoFocus && autoFocusSearch()}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={label}
        aria-label={label}
        data-testid={testId}
        autoComplete="off"
        spellCheck={false}
        className="w-full min-w-0 bg-transparent text-sm text-fg outline-none placeholder:text-muted"
      />
      <ClearSearchButton
        value={value}
        testId={testId ? `${testId}-clear` : 'search-clear'}
        onClear={() => {
          onChange('');
          inner.current?.focus();
        }}
      />
    </label>
  );
});
SearchField.displayName = 'SearchField';

/** The "nothing matches" line under a search field. */
export const NoSearchResults = ({ className }: { className?: string }) => (
  <div className={cn('px-2.5 py-2 text-[0.8125rem] text-muted', className)} data-testid="list-no-results">
    {t('menu.noResults' as MessageKey)}
  </div>
);

/**
 * A search over a custom list (chips, check rows… in a popover) — for lists that are not a `Menu`. Renders the
 * field when there are more than `threshold` items (or `searchable` forces it), then `children(matches)`, then
 * "no results". The field is autofocused on desktop (phones: only on a tap, `autoFocusSearch`); ↑/↓ move between
 * it and the list's buttons, Enter clicks the first button of the list, Esc clears the search before it closes.
 */
export const SearchableList = <T,>({
  items,
  text,
  children,
  threshold = SEARCH_THRESHOLD,
  searchable,
  placeholder,
  className,
  testId,
  autoFocus = true,
  compact,
}: {
  items: T[];
  /** The words a search matches for one item (its label, and e.g. its type). */
  text: (item: T) => string;
  children: (shown: T[]) => ReactNode;
  threshold?: number;
  searchable?: boolean;
  placeholder?: string;
  className?: string;
  /** Test id of the search field (default `list-search`). */
  testId?: string;
  /** Focus the field on mount (default — a list opened to pick from); off for lists that are always shown. */
  autoFocus?: boolean;
  /** A 32px field, for small lists inside a panel. */
  compact?: boolean;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const needle = searchNeedle(query);
  const show = searchable ?? items.length > threshold;
  const shown = show && needle ? items.filter((x) => matchesSearch(text(x), needle)) : items;

  // Esc with a search typed clears it. Window capture runs before the layer stack's document listener, which
  // would otherwise close the popover.
  useEffect(() => {
    if (!query) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || !ref.current?.contains(document.activeElement)) return;
      e.stopPropagation();
      e.preventDefault();
      setQuery('');
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [query]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!searchRef.current) return;
    // The list's own buttons — not the field's "X" (it sits first in the DOM: Enter would clear instead of pick).
    const buttons = Array.from(
      ref.current?.querySelectorAll<HTMLElement>('button:not([disabled]):not([data-search-clear])') ?? [],
    );
    const inSearch = document.activeElement === searchRef.current;
    if (e.key === 'Enter' && inSearch) {
      e.preventDefault();
      buttons[0]?.click();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const list = [searchRef.current, ...buttons];
      const i = list.indexOf(document.activeElement as HTMLElement);
      if (i < 0) return;
      e.preventDefault();
      list[e.key === 'ArrowDown' ? (i + 1) % list.length : (i - 1 + list.length) % list.length]?.focus();
    }
  };

  return (
    <div ref={ref} className={className} onKeyDown={onKeyDown}>
      {show ? (
        <SearchField
          ref={searchRef}
          value={query}
          onChange={setQuery}
          placeholder={placeholder}
          testId={testId ?? 'list-search'}
          autoFocus={autoFocus}
          className={cn('mb-1.5', compact && 'h-8')}
        />
      ) : null}
      {children(shown)}
      {show && needle && !shown.length ? <NoSearchResults /> : null}
    </div>
  );
};

type Row = Exclude<MenuEntry, { kind: 'label' } | { kind: 'separator' }>;
const selectable = (entries: MenuEntry[]) =>
  entries.filter((e): e is Row => e.kind === undefined || e.kind === 'item' || e.kind === 'submenu');

/**
 * Whether a level gets the search by default: a long list of choices (columns, types, groups…). Action menus
 * (F4: rows with icons or shortcuts — an item's or a column's ⋯ menu) keep their canvas look; their choice
 * submenus ("add column right" → types) still get it.
 */
const wantsSearch = (entries: MenuEntry[]) => {
  const rows = selectable(entries);
  return rows.length > SEARCH_THRESHOLD && !rows.some((e) => e.icon || ('shortcut' in e && e.shortcut));
};

/** An item, or a submenu whose label or any entry inside it matches. */
const entryMatches = (entry: MenuEntry, needle: string): boolean => {
  if (entry.kind === 'separator' || entry.kind === 'label') return false;
  if (matchesSearch(entry.keywords ? `${entry.label} ${entry.keywords}` : entry.label, needle)) return true;
  return entry.kind === 'submenu' && entry.items.some((x) => entryMatches(x, needle));
};

/**
 * The entries a search keeps: matching items and submenus, every entry of a section whose header matches,
 * headers only over kept entries, and separators only between kept entries (never doubled or at the ends).
 */
export const filterMenuEntries = (entries: MenuEntry[], needle: string): MenuEntry[] => {
  if (!needle) return entries;
  const kept: MenuEntry[] = [];
  let header: { entry: MenuEntry; matches: boolean; shown: boolean } | null = null;
  for (const entry of entries) {
    if (entry.kind === 'separator') {
      header = null;
      if (kept.length && kept.at(-1)!.kind !== 'separator') kept.push(entry);
      continue;
    }
    if (entry.kind === 'label') {
      header = { entry, matches: matchesSearch(entry.label, needle), shown: false };
      continue;
    }
    if (!(header?.matches || entryMatches(entry, needle))) continue;
    if (header && !header.shown) {
      kept.push(header.entry);
      header.shown = true;
    }
    kept.push(entry);
  }
  while (kept.at(-1)?.kind === 'separator') kept.pop();
  return kept;
};

type MenuProps = {
  at: Point | null;
  onClose: () => void;
  items: MenuEntry[];
  label: string;
  /**
   * A search field on top that filters as one types. Default: shown on a list of choices with more than
   * `SEARCH_THRESHOLD` rows (not on action menus, see `wantsSearch`); `true` / `false` force it on / off.
   */
  searchable?: boolean;
  /** Shown on top of the first level (the avatar menu: my photo, name and email). */
  header?: ReactNode;
  testId?: string;
  /**
   * rows that depend on what was typed in the search (a model id that is not on the list — "use …")
   * added after the matches of the first level while the search holds text.
   */
  searchExtra?: (query: string) => MenuEntry[];
};

/** An open submenu: its label, test id and the entries it had when it was opened. */
type MenuLevel = { label: string; items: MenuEntry[]; testId?: string };

/**
 * The entries of the innermost open submenu, found again in the current `items` (a submenu with the same test id,
 * else the same label, at each level) — so entries re-rendered by a choice that kept the menu open are current.
 * Falls back to the entries the submenu was opened with when it is gone.
 */
export const resolveLevel = (items: MenuEntry[], stack: MenuLevel[]): MenuEntry[] => {
  let level: MenuEntry[] | null = items;
  for (const open of stack) {
    const found: MenuEntry | undefined = level?.find(
      (e) => e.kind === 'submenu' && (open.testId ? e.testId === open.testId : e.label === open.label),
    );
    level = found && found.kind === 'submenu' ? found.items : null;
    if (!level) return stack.at(-1)!.items;
  }
  return level ?? items;
};

/** Each opening mounts a fresh panel (keyed by position), so submenu and placement state never leak. */
export const Menu = (props: MenuProps) =>
  props.at ? <MenuPanel key={`${props.at.x},${props.at.y},${props.at.up ?? ''}`} {...props} at={props.at} /> : null;

const OPEN_SCROLL_GRACE_MS = 200;
/** How long after the viewport's height changed (the on-screen keyboard sliding in / out) a page scroll is its. */
export const KEYBOARD_SETTLE_MS = 800;

/**
 * r19small ("on the phone, choosing a column in the filter closes it and the keyboard"): what closes
 * an open menu besides a press outside / Esc. A menu used to close on every window resize and page scroll — but on
 * a phone its search field is autofocused, the on-screen keyboard slides in, the viewport gets shorter and the
 * browser scrolls the field into view: the menu closed under the finger (and the next tap landed on the sheet).
 * - a resize closes it only when the viewport's width changed (rotation, a window resized) — the keyboard changes
 *   the height only, and then the menu is placed again;
 * - a scroll inside the menu never closes it; a page scroll does, except right after it opened, while the keyboard
 *   moves the viewport, or while one types in its search on a touch screen (the browser keeps the field in view).
 */
export const menuClosesOn = (o: {
  kind: 'resize' | 'scroll';
  /** resize: the viewport's width differs from when the menu opened. */
  widthChanged?: boolean;
  /** scroll: the scrolled element is inside the menu. */
  inside?: boolean;
  sinceOpenMs: number;
  /** Since the viewport's height last changed (Infinity = not since the menu opened). */
  sinceViewportMs: number;
  /** A text field inside the menu has the focus. */
  typing: boolean;
  /** A touch screen (coarse pointer): its keyboard is on screen while one types. */
  touch: boolean;
}) => {
  if (o.kind === 'resize') return !!o.widthChanged;
  if (o.inside || o.sinceOpenMs < OPEN_SCROLL_GRACE_MS || o.sinceViewportMs < KEYBOARD_SETTLE_MS) return false;
  return !(o.touch && o.typing);
};

const MenuPanel = ({
  at,
  onClose,
  label,
  searchable,
  header,
  testId,
  searchExtra,
  items: given,
}: MenuProps & { at: Point }) => {
  const items = withSelectionCopy(given, at.selection);
  const ref = useRef<HTMLDivElement>(null);
  const exitRef = useExitRef(ref);
  const searchRef = useRef<HTMLInputElement>(null);
  const [stack, setStack] = useState<MenuLevel[]>([]);
  const [query, setQuery] = useState('');
  // `up`: opened above its anchor — kept on the bottom edge, so a search that shortens the list stays by it.
  const [pos, setPos] = useState<{ x: number; y: number; up: boolean; width: number; maxHeight: number } | null>(null);
  // r19small: bumped when the viewport's height changes (the on-screen keyboard) — the menu is placed again.
  const [viewport, setViewport] = useState(0);
  // The open submenu is looked up again in the current items on every render (by test id, else label), so a
  // choice that stays open (`keepOpen`) shows its new check mark; the items it was opened with are the fallback.
  const levelItems = resolveLevel(items, stack);
  const needle = searchNeedle(query);
  const showSearch = searchable !== false && (searchable === true || wantsSearch(levelItems) || needle !== '');
  const matched = showSearch ? filterMenuEntries(levelItems, needle) : levelItems;
  const extra = showSearch && needle && !stack.length && searchExtra ? searchExtra(query.trim()) : [];
  const current: MenuEntry[] = extra.length
    ? [...matched, ...(matched.length ? [{ kind: 'separator' } as const] : []), ...extra]
    : matched;

  // Place the menu, then keep it on screen (RTL opens toward the inline-start, i.e. leftwards) — the shared rule
  // (round 12, `placeFloating`): below the point or above it, whichever has room; the other way sideways rather
  // than over the point when the inline-start side is short; a menu taller than the room scrolls.
  useLayoutEffect(() => {
    if (!ref.current) return;
    const { width } = ref.current.getBoundingClientRect();
    const height = ref.current.scrollHeight;
    const vh = window.innerHeight;
    const p = placeFloating(
      { left: at.x, right: at.x, top: at.y, bottom: at.y },
      { width, height },
      { width: document.documentElement.clientWidth || window.innerWidth, height: vh },
      { side: at.up ? 'top' : 'bottom', rtl: document.documentElement.dir === 'rtl', gap: 0 },
    );
    const up = p.side === 'top';
    const maxHeight = Math.min(vh * 0.7, p.maxHeight);
    setPos({ x: p.left, y: up ? p.top + Math.min(height, maxHeight) : p.top, up, width, maxHeight });
  }, [at, stack, viewport]);

  // preventScroll: the first focus can land before the panel is placed on screen, and the scroll it would
  // cause closes the menu at once (a menu opened near the bottom of the window).
  // Only once placed: nothing inside a `visibility: hidden` panel can take the focus.
  const placed = !!pos;
  // r23ui: on a phone the search waits for a tap (no keyboard sliding over the list) — the panel holds the focus.
  useEffect(() => {
    if (!placed) return;
    if (searchRef.current) {
      if (autoFocusSearch()) searchRef.current.focus({ preventScroll: true });
      else ref.current?.focus({ preventScroll: true });
    } else
      ref.current?.querySelector<HTMLElement>('[role^="menuitem"]:not([disabled])')?.focus({ preventScroll: true });
  }, [at, stack, placed]);

  // Esc clears the search first, then leaves a submenu, then closes.
  useLayer(ref, true, onClose, () => {
    if (query) {
      setQuery('');
      searchRef.current?.focus();
    } else if (stack.length) setStack((st) => st.slice(0, -1));
    else onClose();
  });
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    // The click that opens a menu focuses its trigger, and a trigger cut off at the edge of a scrolling area
    // (a dialog body) is scrolled into view a frame later — that scroll is not the user's and must not close it.
    const openedAt = performance.now();
    const width = window.innerWidth;
    const vv = window.visualViewport;
    const height = () => vv?.height ?? window.innerHeight;
    let lastHeight = height();
    let viewportAt = -Infinity;
    const touch = !!window.matchMedia?.('(pointer: coarse)').matches;
    const state = (kind: 'resize' | 'scroll', e?: Event) => {
      const now = performance.now();
      const focused = document.activeElement;
      return menuClosesOn({
        kind,
        widthChanged: window.innerWidth !== width,
        // A scroll of the window itself (or the visual viewport) has no Node as its target.
        inside: !!e && e.target instanceof Node && !!ref.current?.contains(e.target),
        sinceOpenMs: now - openedAt,
        sinceViewportMs: now - viewportAt,
        typing: !!focused && !!ref.current?.contains(focused) && focused.tagName === 'INPUT',
        touch,
      });
    };
    const onScroll = (e: Event) => {
      if (state('scroll', e)) closeRef.current();
    };
    const onResize = () => {
      if (state('resize')) return closeRef.current();
      const h = height();
      if (h !== lastHeight) {
        lastHeight = h;
        viewportAt = performance.now();
        setViewport((n) => n + 1);
      }
    };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    vv?.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
      vv?.removeEventListener('resize', onResize);
    };
    // Once per opening (the panel is keyed by it): a re-render — a new `onClose`, the keyboard's re-placing — must
    // not restart the clocks above.
  }, []);

  const enter = (entry: MenuLevel) => {
    // A search that found entries inside the submenu (not the submenu itself) goes on filtering in it.
    const carry = needle && !matchesSearch(entry.label, needle);
    setStack((s) => [...s, { label: entry.label, items: entry.items, testId: entry.testId }]);
    if (!carry) setQuery('');
  };
  const back = () => {
    setStack((s) => s.slice(0, -1));
    setQuery('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled])') ?? []);
    const list = searchRef.current ? [searchRef.current, ...items] : items;
    const i = list.indexOf(document.activeElement as HTMLElement);
    const inSearch = !!searchRef.current && document.activeElement === searchRef.current;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = e.key === 'ArrowDown' ? (i + 1) % list.length : (i - 1 + list.length) % list.length;
      list[next]?.focus();
    } else if (e.key === 'Enter' && inSearch) {
      // Enter in the search picks the first match (not the submenu's "back" row).
      e.preventDefault();
      items.find((el) => !el.hasAttribute('data-menu-back'))?.click();
    } else if (e.key === 'Tab') {
      onClose();
    } else if (
      searchRef.current &&
      !inSearch &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      ((e.key.length === 1 && e.key !== ' ') || e.key === 'Backspace')
    ) {
      // Typing on a row goes on into the search (the key lands in the field that now has focus).
      searchRef.current.focus({ preventScroll: true });
    }
  };

  const itemClass =
    'flex h-[2.125rem] w-full items-center gap-2.5 rounded-[9px] px-2.5 text-start text-[0.8125rem] outline-none hover:bg-surface-2 focus:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--focus-ring)] disabled:cursor-default disabled:opacity-40 [&>svg]:shrink-0 [&>svg]:text-muted';

  const place = pos
    ? pos.up
      ? { left: pos.x, bottom: window.innerHeight - pos.y, minWidth: pos.width, maxHeight: pos.maxHeight }
      : { left: pos.x, top: pos.y, minWidth: pos.width, maxHeight: pos.maxHeight }
    : { left: at.x, top: at.y };

  return createPortal(
    <div
      ref={exitRef}
      role="menu"
      aria-label={label}
      data-testid={testId}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      style={{ ...place, visibility: pos ? 'visible' : 'hidden' }}
      className="anim-pop fixed z-popover max-h-[70vh] min-w-[230px] overflow-auto rounded-[14px] border border-line bg-surface p-1.5 shadow-[var(--shadow-pop)] outline-none"
    >
      {header && !stack.length ? header : null}
      {stack.length ? (
        <>
          <button type="button" role="menuitem" data-menu-back className={cn(itemClass, 'text-muted')} onClick={back}>
            <span className="rtl:-scale-x-100">‹</span> {stack.at(-1)!.label}
          </button>
          <div className="mx-1 my-1.5 border-t border-line" />
        </>
      ) : null}
      {showSearch ? (
        <div
          className={cn('sticky -top-1.5 z-[1] -mx-1.5 mb-1 bg-surface px-1.5 pt-1.5 pb-1', !stack.length && '-mt-1.5')}
        >
          <SearchField ref={searchRef} value={query} onChange={setQuery} testId="menu-search" />
        </div>
      ) : null}
      {showSearch && needle && !current.length ? <NoSearchResults /> : null}
      {current.map((entry, i) => {
        if (entry.kind === 'separator')
          return <div key={i} role="separator" className="mx-1 my-1.5 border-t border-line" />;
        if (entry.kind === 'label')
          return (
            <div key={i} className="px-2.5 pt-2 pb-1 text-[0.6875rem] font-semibold text-muted">
              {entry.label}
            </div>
          );
        if (entry.kind === 'submenu') {
          return (
            <button
              key={i}
              type="button"
              role="menuitem"
              aria-haspopup="menu"
              data-testid={entry.testId}
              className={itemClass}
              onClick={() => enter(entry)}
            >
              {entry.icon}
              <span className="flex-1">{entry.label}</span>
              <span className="text-muted rtl:-scale-x-100">›</span>
            </button>
          );
        }
        const radio = entry.checked !== undefined;
        return (
          <button
            key={i}
            type="button"
            role={radio ? 'menuitemradio' : 'menuitem'}
            data-testid={entry.testId}
            disabled={entry.disabled}
            data-tip={entry.hint}
            aria-checked={radio ? entry.checked : undefined}
            aria-current={entry.current || undefined}
            data-current={entry.current || undefined}
            className={cn(
              itemClass,
              entry.danger && 'text-danger-fg [&>svg]:text-danger-fg',
              (entry.checked || entry.current) && 'bg-surface-2 font-semibold',
              entry.current && 'text-primary [&>svg]:text-primary',
            )}
            onClick={() => {
              if (!entry.keepOpen) onClose();
              entry.onSelect();
            }}
          >
            {radio ? (
              <span aria-hidden className="w-3 shrink-0 text-center">
                {entry.checked ? '✓' : ''}
              </span>
            ) : (
              entry.icon
            )}
            <span className="flex-1">{entry.label}</span>
            {entry.current ? (
              <span aria-hidden className="shrink-0">
                ✓
              </span>
            ) : null}
            {entry.shortcut ? (
              <kbd className="shrink-0 font-sans text-xs text-muted" dir="ltr">
                {entry.shortcut}
              </kbd>
            ) : null}
          </button>
        );
      })}
    </div>,
    document.body,
  );
};

/** The ⋯ button (14 §0): visible on hover and keyboard focus of its row (`group` on the row). */
export const MenuTrigger = ({
  label,
  onClick,
  className,
  pointerOnly,
  testId,
}: {
  label: string;
  onClick: (e: MouseEvent<HTMLButtonElement>) => void;
  className?: string;
  testId?: string;
  /**
   * The same menu opens from the keyboard on the element it belongs to (Shift+F10 / the menu key — a view tab): the
   * "⋯" is for the pointer only, out of the tab order and the accessibility tree (no control nested in a tab).
   */
  pointerOnly?: boolean;
}) => (
  <button
    type="button"
    aria-haspopup="menu"
    aria-label={label}
    aria-hidden={pointerOnly || undefined}
    tabIndex={pointerOnly ? -1 : undefined}
    title={t('menu.actions')}
    onClick={onClick}
    data-testid={testId}
    className={cn(
      // min 24×24 (WCAG 2.5.8 target size): the "⋯" stays the same, its tap area grows.
      'inline-grid min-h-6 min-w-6 shrink-0 place-items-center rounded-[var(--radius-sm)] px-1 text-muted opacity-0 hover:bg-surface-2 hover:text-fg focus:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100',
      className,
    )}
  >
    ⋯
  </button>
);

/**
 * A form field that picks one value from a list — the system replacement for `<select>` (never a native
 * picker). Opens the same `Menu` under the field; the chosen option is checked.
 */
export const Picker = <V extends string>({
  value,
  options,
  onChange,
  placeholder,
  label,
  className,
  testId,
  searchable,
  custom,
  valueLabel,
}: {
  value: V;
  /**
   * `keywords`: more words the search matches (see `MenuEntry`); `testId`: the option's menu row; `disabled`:
   * listed but not selectable (e.g. not in the account's plan — its label says why).
   */
  options: {
    value: V;
    label: string;
    keywords?: string;
    testId?: string;
    disabled?: boolean;
    hint?: string;
    /**
     * a section the option belongs to (a model's maker): consecutive options of one group get its name as
     * a heading above them; the search keeps the heading of the matches it shows.
     */
    group?: string;
  }[];
  onChange: (value: V) => void;
  placeholder?: string;
  /** Accessible name of the field (its visible label usually comes from `Field`). */
  label: string;
  className?: string;
  testId?: string;
  /** See `Menu`: by default long option lists get a search field. */
  searchable?: boolean;
  /**
   * a value typed in the search that is not an option can be chosen as is — the row's label for the
   * typed text (null = no row for it, e.g. not a valid value), and its test id.
   */
  custom?: { label: (query: string) => string | null; testId?: string };
  /** The field's text when the value is none of the options (a typed value); default: the value itself. */
  valueLabel?: (value: V) => string;
}) => {
  const menu = useActionMenu();
  const current = options.find((o) => o.value === value);
  const items: MenuEntry[] = [];
  let group: string | undefined;
  for (const o of options) {
    if (o.group && o.group !== group) items.push({ kind: 'label', label: o.group });
    group = o.group;
    items.push({
      label: o.label,
      keywords: o.keywords,
      testId: o.testId,
      checked: o.value === value,
      disabled: o.disabled,
      hint: o.hint,
      onSelect: () => onChange(o.value),
    });
  }
  const shown = current?.label ?? (value ? (valueLabel ? valueLabel(value) : value) : (placeholder ?? ''));
  return (
    <>
      <button
        type="button"
        aria-haspopup="menu"
        aria-label={label}
        data-testid={testId}
        onClick={menu.fromTrigger}
        className={cn(
          'flex h-9 w-full items-center justify-between gap-2 rounded-[10px] border border-[var(--control-line)] bg-surface px-3 text-start text-sm text-fg hover:border-primary focus:border-primary focus:outline-none focus:ring-3 focus:ring-[var(--accent-soft)]',
          !current && !value && 'text-muted',
          className,
        )}
      >
        <span className="truncate">{shown}</span>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden
          className="shrink-0 text-muted"
        >
          <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <Menu
        at={menu.at}
        onClose={menu.close}
        label={label}
        searchable={custom ? true : searchable}
        items={items}
        {...(custom
          ? {
              searchExtra: (q: string) => {
                const text = custom.label(q);
                if (!text || options.some((o) => o.value === q)) return [];
                return [{ label: text, testId: custom.testId, onSelect: () => onChange(q as V) }];
              },
            }
          : {})}
      />
    </>
  );
};
