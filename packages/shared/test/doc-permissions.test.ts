// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  canDoc,
  docCapabilities,
  type DocPermissionContext,
  docPlainText,
  effectiveDocLevel,
  higherDocLevel,
} from '../src';

const ctx = (
  p: Partial<DocPermissionContext> & { kind?: DocPermissionContext['doc']['kind'] },
): DocPermissionContext => ({
  accountRole: p.accountRole ?? 'member',
  workspaceVisible: p.workspaceVisible ?? true,
  doc: { kind: p.kind ?? 'main' },
  level: p.level ?? null,
});
const allowed = (c: DocPermissionContext) =>
  Object.entries(docCapabilities(c))
    .filter(([, ok]) => ok)
    .map(([a]) => a);

describe('doc permissions (M8 ד1 — like a board)', () => {
  it('main: members edit, account viewers read, guests see nothing; owners and admins manage', () => {
    expect(allowed(ctx({}))).toEqual(['doc.read', 'doc.comment', 'doc.edit']);
    expect(allowed(ctx({ accountRole: 'viewer' }))).toEqual(['doc.read']);
    expect(canDoc(ctx({ accountRole: 'guest' }), 'doc.read')).toEqual({ ok: false, reason: 'doc_access', as404: true });
    expect(allowed(ctx({ level: 'owner' }))).toContain('doc.manage');
    expect(allowed(ctx({ accountRole: 'admin', kind: 'private' }))).toContain('doc.manage');
  });

  it('private: only invited, at their level; a closed workspace hides it', () => {
    expect(effectiveDocLevel(ctx({ kind: 'private' }))).toBeNull();
    expect(allowed(ctx({ kind: 'private', level: 'commenter' }))).toEqual(['doc.read', 'doc.comment']);
    expect(allowed(ctx({ kind: 'private', level: 'viewer' }))).toEqual(['doc.read']);
    expect(canDoc(ctx({ level: 'editor', workspaceVisible: false }), 'doc.read').ok).toBe(false);
  });

  it('shareable: an invited guest at most edits — never manages; strictest wins for account viewers', () => {
    expect(effectiveDocLevel(ctx({ accountRole: 'guest', kind: 'shareable', level: 'owner' }))).toBe('editor');
    expect(effectiveDocLevel(ctx({ accountRole: 'guest', kind: 'private', level: 'editor' }))).toBeNull();
    expect(effectiveDocLevel(ctx({ accountRole: 'viewer', kind: 'private', level: 'owner' }))).toBe('viewer');
  });

  it('a person in two teams gets the better level', () => {
    expect(higherDocLevel('viewer', 'editor')).toBe('editor');
    expect(higherDocLevel(null, 'commenter')).toBe('commenter');
    expect(higherDocLevel('owner', null)).toBe('owner');
  });

  it('plain text of a doc: one line per block', () => {
    expect(
      docPlainText({
        type: 'doc',
        content: [
          { type: 'heading', content: [{ type: 'text', text: 'Title' }] },
          {
            type: 'bulletList',
            content: [
              { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }] },
              { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'b' }] }] },
            ],
          },
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'x' }, { type: 'hardBreak' }, { type: 'text', text: 'y' }],
          },
        ],
      }),
    ).toBe('Title\na\nb\nx y');
  });
});
