// SPDX-License-Identifier: AGPL-3.0-only
import { EXT_PROTOCOL, EXT_PROTOCOL_VERSION } from '@bines/shared';
import { describe, expect, it } from 'vitest';
import {
  automationBuilderRequest,
  automationToggleAllowed,
  automationToggleRequest,
  frameMessage,
  frameUrlOk,
  jsonCopy,
  modalUrl,
} from './frame-protocol';

/**
 * Red team of the host side of the extension frame protocol (docs/EXTENSIONS-SECURITY-REVIEW.md §3): a hostile page
 * — another extension's frame, another tab, a look-alike origin, a frame that navigated away — tries to speak for an
 * extension, and an extension tries to open a modal somewhere else.
 */
const ORIGIN = 'https://ext.example.com';
const frame = { name: 'the extension frame' };
const msg = (over: Record<string, unknown> = {}) => ({
  protocol: EXT_PROTOCOL,
  v: EXT_PROTOCOL_VERSION,
  type: 'request',
  id: 1,
  action: 'token',
  ...over,
});

describe('postMessage spoofing', () => {
  it('accepts only this frame window and its exact origin', () => {
    expect(frameMessage({ source: frame, origin: ORIGIN, data: msg() }, frame, ORIGIN)).not.toBeNull();
    // another frame (another extension), another window, our own window
    expect(frameMessage({ source: { other: true }, origin: ORIGIN, data: msg() }, frame, ORIGIN)).toBeNull();
    expect(frameMessage({ source: null, origin: ORIGIN, data: msg() }, frame, ORIGIN)).toBeNull();
    // the right window after it navigated elsewhere, a sandboxed "null" origin, look-alikes
    for (const origin of [
      'https://evil.example',
      'null',
      'https://ext.example.com.evil.test',
      'http://ext.example.com',
      'https://ext.example.com:8443',
      'https://EXT.example.com',
    ])
      expect(frameMessage({ source: frame, origin, data: msg() }, frame, ORIGIN), origin).toBeNull();
    // no frame (unmounted) → nothing is accepted, even a message whose source is undefined
    expect(frameMessage({ source: undefined, origin: ORIGIN, data: msg() }, undefined, ORIGIN)).toBeNull();
  });

  it('ignores other protocols, versions and shapes (type confusion)', () => {
    for (const data of [
      null,
      'token',
      42,
      [],
      msg({ protocol: 'bines-ext-x' }),
      msg({ v: 2 }),
      msg({ v: '1' }),
      msg({ type: 7 }),
      { ...msg(), protocol: undefined },
    ])
      expect(frameMessage({ source: frame, origin: ORIGIN, data }, frame, ORIGIN), JSON.stringify(data)).toBeNull();
  });
});

describe('what may be framed and opened', () => {
  it('frames only the listed origin over http(s), never our own', () => {
    expect(frameUrlOk(`${ORIGIN}/view`, ORIGIN, 'https://app.bines.test')).toBe(true);
    expect(frameUrlOk('https://app.bines.test/x', 'https://app.bines.test', 'https://app.bines.test')).toBe(false);
    expect(frameUrlOk('https://other.example/x', ORIGIN, 'https://app.bines.test')).toBe(false);
    expect(frameUrlOk('javascript:alert(1)', 'null', 'https://app.bines.test')).toBe(false);
    expect(frameUrlOk('data:text/html,<script>1</script>', 'null', 'https://app.bines.test')).toBe(false);
  });

  it('openModal stays on the extension origin', () => {
    const view = `${ORIGIN}/app/index.html`;
    expect(modalUrl('settings.html', view, ORIGIN)).toBe(`${ORIGIN}/app/settings.html`);
    expect(modalUrl(undefined, view, ORIGIN)).toBe(view);
    for (const path of [
      'https://evil.example/phish',
      '//evil.example/phish',
      '/\\evil.example',
      'javascript:alert(document.domain)',
      'data:text/html,<script>alert(1)</script>',
      'blob:https://ext.example.com/1',
      'https://ext.example.com@evil.example/',
    ])
      expect(modalUrl(path, view, ORIGIN), path).toBeNull();
  });

  it('results and params are copied as JSON within a size (no functions, cycles or huge blobs)', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(jsonCopy(cyclic, 1000)).toBeUndefined();
    expect(jsonCopy({ big: 'x'.repeat(2000) }, 1000)).toBeUndefined();
    expect(jsonCopy(() => 1, 1000)).toBeUndefined();
    let deep: unknown = 1;
    for (let i = 0; i < 100_000; i++) deep = [deep];
    expect(jsonCopy(deep, 64 * 1024)).toBeUndefined();
    expect(jsonCopy({ ok: true, n: [1, 2] }, 1000)).toEqual({ ok: true, n: [1, 2] });
  });
});

describe('openAutomationBuilder (): only its own trigger, only a board its token reads', () => {
  const frame = { extensionKey: 'meta', boardId: '', tokenBoards: ['B1', 'B2'] };
  it('names the trigger as its own block, on the board asked for', () => {
    expect(automationBuilderRequest({ trigger: 'button', board_id: 'B2', config: { with_item: true } }, frame)).toEqual(
      { block: 'meta.button', boardId: 'B2', withItem: true, inputs: {} },
    );
    // Its trigger's inputs, prefilled (e.g. which button): text values under input keys only.
    expect(
      automationBuilderRequest({ trigger: 'button', board_id: 'B1', config: { inputs: { button: 'b-7' } } }, frame),
    ).toMatchObject({ inputs: { button: 'b-7' } });
    expect(
      automationBuilderRequest({ trigger: 'button', board_id: 'B1', config: { inputs: { 'Bad key': 'x' } } }, frame),
    ).toEqual({ error: 'bad_trigger' });
  });
  it('never another extension’s trigger: a dotted key or anything else is refused', () => {
    expect(automationBuilderRequest({ trigger: 'other.button', board_id: 'B1' }, frame)).toEqual({
      error: 'bad_trigger',
    });
    expect(automationBuilderRequest({ trigger: '', board_id: 'B1' }, frame)).toEqual({ error: 'bad_trigger' });
    expect(automationBuilderRequest(null, frame)).toEqual({ error: 'bad_trigger' });
  });
  it('a board its token does not read is refused; without one, the frame’s own board', () => {
    expect(automationBuilderRequest({ trigger: 'button', board_id: 'B9' }, frame)).toEqual({ error: 'bad_board' });
    expect(automationBuilderRequest({ trigger: 'button' }, frame)).toEqual({ error: 'bad_board' });
    expect(automationBuilderRequest({ trigger: 'button' }, { ...frame, boardId: 'B1', tokenBoards: null })).toEqual({
      block: 'meta.button',
      boardId: 'B1',
      withItem: false,
      inputs: {},
    });
  });
});

describe('setAutomationActive (): only an automation on its own trigger, on a board its token reads', () => {
  const ID = '01J0000000000000000000000A';
  const frame = { extensionKey: 'meta', tokenBoards: ['B1'] };
  const auto = (block: unknown, board: string | null = 'B1', type = 'extension_trigger') => ({
    board_id: board,
    recipe: { trigger: { type, block } },
  });
  it('asks for an id and on / off only', () => {
    expect(automationToggleRequest({ automation_id: ID, active: false })).toEqual({ automationId: ID, active: false });
    expect(automationToggleRequest({ automation_id: 'x', active: true })).toEqual({ error: 'bad_automation' });
    expect(automationToggleRequest({ automation_id: ID })).toEqual({ error: 'bad_automation' });
  });
  it('its own trigger on its boards; never another extension’s (also one whose key starts the same)', () => {
    expect(automationToggleAllowed(auto('meta.button'), frame)).toBe('ok');
    expect(automationToggleAllowed(auto('meta-x.button'), frame)).toBe('bad_automation');
    expect(automationToggleAllowed(auto('other.button'), frame)).toBe('bad_automation');
    expect(automationToggleAllowed(auto(undefined, 'B1', 'item_created'), frame)).toBe('bad_automation');
    expect(automationToggleAllowed(auto('meta.button', 'B9'), frame)).toBe('bad_board');
    expect(automationToggleAllowed(auto('meta.button', null), frame)).toBe('bad_board');
  });
});
