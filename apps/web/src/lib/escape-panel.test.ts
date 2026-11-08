// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { escapeUsed, isTextField, panelEscape } from '@bines/ui';

/** Round 13: Esc closes the item card / doc panel — after menus, dialogs and fields that use Esc themselves. */
const free = { handled: false, layersOpen: false, dialogOver: false };

describe('panelEscape', () => {
  it('closes the panel when the focus is on it, on a button or nowhere', () => {
    expect(panelEscape({ ...free, target: { tagName: 'ASIDE' } })).toBe('close');
    expect(panelEscape({ ...free, target: { tagName: 'BUTTON' } })).toBe('close');
    expect(panelEscape({ ...free, target: null })).toBe('close');
    expect(panelEscape({ ...free, target: { tagName: 'INPUT', type: 'checkbox' } })).toBe('close');
  });

  it('a text field or editor only gives the focus back first (the next Esc closes)', () => {
    expect(panelEscape({ ...free, target: { tagName: 'INPUT', type: 'text' } })).toBe('blur');
    expect(panelEscape({ ...free, target: { tagName: 'INPUT' } })).toBe('blur');
    expect(panelEscape({ ...free, target: { tagName: 'TEXTAREA' } })).toBe('blur');
    expect(panelEscape({ ...free, target: { tagName: 'DIV', isContentEditable: true } })).toBe('blur');
  });

  it('leaves the Esc alone when a field used it, a menu is open or a dialog is over the panel', () => {
    const target = { tagName: 'DIV' };
    expect(panelEscape({ ...free, target, handled: true })).toBe('ignore');
    expect(panelEscape({ ...free, target, layersOpen: true })).toBe('ignore');
    expect(panelEscape({ ...free, target, dialogOver: true })).toBe('ignore');
    expect(panelEscape({ ...free, target: { tagName: 'TEXTAREA' }, handled: true })).toBe('ignore');
  });

  it('knows which elements take typing', () => {
    expect(isTextField({ tagName: 'SELECT' })).toBe(true);
    expect(isTextField({ tagName: 'INPUT', type: 'search' })).toBe(true);
    expect(isTextField({ tagName: 'INPUT', type: 'radio' })).toBe(false);
    expect(isTextField({ tagName: 'SPAN' })).toBe(false);
    expect(isTextField(null)).toBe(false);
  });
  it('a rich-text editor cancels every Esc: only the ones it marks count as used', () => {
    expect(escapeUsed({ defaultPrevented: true, marked: false, inRichEditor: false })).toBe(true);
    expect(escapeUsed({ defaultPrevented: false, marked: false, inRichEditor: false })).toBe(false);
    // ProseMirror: a plain Esc leaves the editor (the card stays open; the next Esc closes it)…
    expect(escapeUsed({ defaultPrevented: true, marked: false, inRichEditor: true })).toBe(false);
    // …an Esc that closed its @-mention list is used.
    expect(escapeUsed({ defaultPrevented: true, marked: true, inRichEditor: true })).toBe(true);
  });
});
