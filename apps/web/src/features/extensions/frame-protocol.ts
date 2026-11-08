// SPDX-License-Identifier: AGPL-3.0-only
import {
  EXT_PROTOCOL,
  EXT_PROTOCOL_VERSION,
  openAutomationBuilderSchema,
  setAutomationActiveSchema,
} from '@bines/shared';

/**
 * The host side of the extension postMessage protocol, as pure checks (AppFrame uses them; the red-team tests in
 * frame-protocol.test.ts attack them — docs/EXTENSIONS-SECURITY-REVIEW.md).
 */
export type FrameRequest = {
  protocol: string;
  v: number;
  type: string;
  id?: unknown;
  action?: unknown;
  payload?: unknown;
};

/**
 * A message is the frame's only when it comes from **this** frame's window and from its origin, and speaks the
 * protocol: another frame, another tab, our own window, a navigated-away frame or a look-alike origin is ignored.
 */
export const frameMessage = (
  e: { source: unknown; origin: string; data: unknown },
  frameWindow: unknown,
  origin: string,
): FrameRequest | null => {
  if (!frameWindow || e.source !== frameWindow || e.origin !== origin) return null;
  const m = e.data as FrameRequest | null;
  if (!m || typeof m !== 'object' || m.protocol !== EXT_PROTOCOL || m.v !== EXT_PROTOCOL_VERSION) return null;
  if (typeof m.type !== 'string') return null;
  return m;
};

/** May this page be framed at all: http(s), on the origin the server listed, and never our own origin. */
export const frameUrlOk = (url: string, origin: string, ownOrigin: string) => {
  try {
    const u = new URL(url);
    return u.origin === origin && u.origin !== ownOrigin && /^https?:$/.test(u.protocol);
  } catch {
    return false;
  }
};

/** `openModal({path})`: another page of the same extension, on the same origin — never anywhere else. */
export const modalUrl = (path: unknown, viewUrl: string, origin: string): string | null => {
  let url: URL;
  try {
    url = new URL(typeof path === 'string' && path ? path : viewUrl, viewUrl);
  } catch {
    return null;
  }
  return url.origin === origin && /^https?:$/.test(url.protocol) ? url.toString() : null;
};

/** A JSON-safe copy of what a page handed us (at most `max` bytes as JSON), or undefined. */
export const jsonCopy = (v: unknown, max: number): unknown => {
  try {
    const s = JSON.stringify(v);
    if (s === undefined || s.length > max) return undefined;
    return JSON.parse(s) as unknown;
  } catch {
    return undefined;
  }
};

/**
 * what `openAutomationBuilder` asks for, checked before anything opens — a trigger key of the calling
 * extension's own (`<its key>.<trigger>`: it can never name another extension's), and a board its token reads (the
 * frame's board by default). Whether the key is one of its `automation_trigger`s on that board, and whether this
 * member may manage the board's automations, the host asks the server next.
 */
export const automationBuilderRequest = (
  payload: unknown,
  frame: { extensionKey: string; boardId: string; tokenBoards: string[] | null },
):
  | { block: string; boardId: string; withItem: boolean; inputs: Record<string, string> }
  | { error: 'bad_trigger' | 'bad_board' } => {
  const q = openAutomationBuilderSchema.safeParse(payload);
  if (!q.success) return { error: 'bad_trigger' };
  const boardId = q.data.board_id ?? frame.boardId;
  const boards = frame.tokenBoards ?? (frame.boardId ? [frame.boardId] : []);
  if (!boardId || !boards.includes(boardId)) return { error: 'bad_board' };
  return {
    block: `${frame.extensionKey}.${q.data.trigger}`,
    boardId,
    withItem: q.data.config?.with_item === true,
    inputs: q.data.config?.inputs ?? {},
  };
};

/** what `setAutomationActive` asks for — an automation id and on / off, nothing else. */
export const automationToggleRequest = (
  payload: unknown,
): { automationId: string; active: boolean } | { error: 'bad_automation' } => {
  const q = setAutomationActiveSchema.safeParse(payload);
  return q.success ? { automationId: q.data.automation_id, active: q.data.active } : { error: 'bad_automation' };
};

/**
 * May this frame switch this automation (as the member reads it)? Only when its trigger is the calling extension's own
 * (`<its key>.<trigger>` — extension keys have no dot, so the prefix is exact) and its board is one the frame's token
 * reads. The member's own right (`automation.manage`) is checked after this, by the board and by the server.
 */
export const automationToggleAllowed = (
  automation: { board_id: string | null; recipe: { trigger: { type: string; block?: unknown } } },
  frame: { extensionKey: string; tokenBoards: string[] },
): 'ok' | 'bad_automation' | 'bad_board' => {
  const tr = automation.recipe.trigger;
  if (tr.type !== 'extension_trigger' || typeof tr.block !== 'string' || !tr.block.startsWith(`${frame.extensionKey}.`))
    return 'bad_automation';
  return automation.board_id && frame.tokenBoards.includes(automation.board_id) ? 'ok' : 'bad_board';
};
