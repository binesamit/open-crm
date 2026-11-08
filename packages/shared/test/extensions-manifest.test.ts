// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  APP_PAGE_ICONS,
  appNavPlace,
  blockKey,
  cleanNavPlacement,
  resolveNavLayout,
  isFrameFeature,
  parseBlockKey,
  EXTENSION_SCOPES,
  extensionKind,
  extensionManifestSchema,
  extensionPathAllowed,
  frameOriginsOf,
  manifestDelta,
  manifestIssues,
} from '../src';

/** Extension manifests (D27, the planning notes "MARKETPLACE" §4.1). */
const base = {
  manifest_version: 1,
  id: 'client-file',
  name: 'תיק לקוח',
  version: '1.0.0',
  publisher: { name: 'Bines' },
  permissions: ['boards:read'],
  origins: ['https://ext.example.com'],
  features: [{ type: 'board_view', key: 'file', name: 'תיק', url: 'https://ext.example.com/file/' }],
};

describe('extension manifest', () => {
  it('accepts a code extension and a data pack', () => {
    const code = extensionManifestSchema.parse(base);
    expect(extensionKind(code)).toBe('code');
    expect(frameOriginsOf(code)).toEqual(['https://ext.example.com']);
    const pack = extensionManifestSchema.parse({
      ...base,
      id: 'crm-pack',
      permissions: [],
      origins: [],
      features: [],
      data: { starter_kit: { workspace_name: 'CRM', folders: ['01'], all_builtin_templates: {} } },
    });
    expect(extensionKind(pack)).toBe('data');
    expect(pack.data?.starter_kit?.all_builtin_templates?.except).toEqual([]);
  });

  it('never offers the admin scope', () => {
    expect(EXTENSION_SCOPES).not.toContain('admin');
    expect(manifestIssues({ ...base, permissions: ['admin'] })).not.toEqual([]);
  });

  it('refuses bad ids, reserved kit names, unknown fields of features, and empty manifests', () => {
    expect(manifestIssues({ ...base, id: 'Bad Id' })).not.toEqual([]);
    expect(manifestIssues({ ...base, id: 'empty' })).not.toEqual([]);
    expect(manifestIssues({ ...base, id: 'default' })).not.toEqual([]);
    expect(manifestIssues({ ...base, manifest_version: 2 })).not.toEqual([]);
    expect(manifestIssues({ ...base, features: [], origins: [] })).toEqual(['features: manifest_empty']);
    expect(manifestIssues({ ...base, version: 'one' })).not.toEqual([]);
  });

  it('a feature must be served from a listed origin; origins are bare origins', () => {
    expect(
      manifestIssues({
        ...base,
        features: [{ type: 'board_view', key: 'file', name: 'x', url: 'https://other.example.com/' }],
      }),
    ).toEqual(['features.0.url: feature_origin_not_listed']);
    expect(manifestIssues({ ...base, origins: ['https://ext.example.com/path'] })).not.toEqual([]);
    expect(manifestIssues({ ...base, origins: ['javascript:alert(1)'] })).not.toEqual([]);
    expect(
      manifestIssues({
        ...base,
        features: [{ type: 'board_view', key: 'file', name: 'x', url: 'https://ext.example.com/#token=x' }],
      }),
    ).not.toEqual([]);
  });

  it('refuses repeated feature keys and repeated permissions', () => {
    expect(manifestIssues({ ...base, features: [base.features[0], base.features[0]] })).toEqual([
      'features.1.key: feature_key_taken',
    ]);
    expect(manifestIssues({ ...base, permissions: ['boards:read', 'boards:read'] })).toEqual([
      'permissions: permission_repeated',
    ]);
  });

  it('a new scope, origin or feature needs consent again; a patch does not', () => {
    const v1 = extensionManifestSchema.parse(base);
    expect(manifestDelta(v1, extensionManifestSchema.parse({ ...base, version: '1.0.1' })).needsConsent).toBe(false);
    const more = manifestDelta(
      v1,
      extensionManifestSchema.parse({ ...base, version: '2.0.0', permissions: ['boards:read', 'items:write'] }),
    );
    expect(more).toMatchObject({ needsConsent: true, addedScopes: ['items:write'] });
    const origin = manifestDelta(
      v1,
      extensionManifestSchema.parse({ ...base, origins: [...base.origins, 'https://cdn.example.com'] }),
    );
    expect(origin.addedOrigins).toEqual(['https://cdn.example.com']);
  });
});

describe('extension token path allowlist', () => {
  it('board content only', () => {
    expect(extensionPathAllowed('/boards/x/items')).toBe(true);
    expect(extensionPathAllowed('/items/x/cells/status')).toBe(true);
    expect(extensionPathAllowed('/auth/me')).toBe(true);
    for (const p of [
      '/auth/tokens',
      '/extensions',
      '/platform/accounts',
      '/accounts/me',
      '/boards/x/permissions',
      '/boards/x/webhooks',
      '/boards/x/automations',
      '/agents',
      '/ai/assistant',
      '/me/accounts',
      '/ext/other',
      '/dashboards/x',
    ])
      expect(extensionPathAllowed(p), p).toBe(false);
    expect(extensionPathAllowed('/ext/storage/user/k')).toBe(true);
    expect(extensionPathAllowed('/ext/files')).toBe(true);
  });

  it('people and teams are read-only, sharing is never for extensions (EXT-RT1)', () => {
    expect(extensionPathAllowed('/users', 'GET')).toBe(true);
    expect(extensionPathAllowed('/users/me', 'GET')).toBe(true);
    expect(extensionPathAllowed('/teams', 'GET')).toBe(true);
    expect(extensionPathAllowed('/boards/x', 'PATCH')).toBe(true);
    expect(extensionPathAllowed('/items/x', 'DELETE')).toBe(true);
    for (const [m, p] of [
      ['POST', '/users/x/recovery-link'],
      ['POST', '/users/x/reset-2fa'],
      ['PATCH', '/users/x'],
      ['POST', '/users/invite'],
      ['POST', '/users/bulk'],
      ['GET', '/users/export.csv'],
      ['GET', '/users/invitations'],
      ['PATCH', '/users/me'],
      ['PUT', '/users/me/avatar'],
      ['POST', '/teams'],
      ['DELETE', '/teams/x'],
      ['PUT', '/boards/x/teams/y'],
      ['POST', '/boards/x/invite'],
      ['POST', '/boards/x/claim'],
      ['PUT', '/boards/x/columns/c/restriction'],
      ['POST', '/boards/x/save-as-template'],
      ['GET', '/boards/x/template-draft'],
    ])
      expect(extensionPathAllowed(p!, m), `${m} ${p}`).toBe(false);
  });
});

describe('ת3–ת5 features', () => {
  const kit = {
    ...base,
    id: 'kit',
    origins: ['https://ext.example.com', 'https://api.example.com'],
    features: [
      { type: 'item_view', key: 'tab', name: 'לשונית', url: 'https://ext.example.com/item' },
      { type: 'board_menu_action', key: 'act', name: 'פעולה', url: 'https://ext.example.com/act', contexts: ['item'] },
      { type: 'batch_action', key: 'bulk', name: 'מסומנים', url: 'https://ext.example.com/bulk' },
      { type: 'dashboard_widget', key: 'w', name: 'ווידג׳ט', url: 'https://ext.example.com/w' },
      { type: 'account_settings_page', key: 'settings', name: 'הגדרות', url: 'https://ext.example.com/s' },
      {
        type: 'automation_action',
        key: 'send',
        name: 'שלח',
        url: 'https://api.example.com/run',
        inputs: [{ key: 'to', label: 'אל', type: 'column', column_types: ['phone'] }],
      },
      { type: 'automation_trigger', key: 'incoming', name: 'נכנסת' },
    ],
  };

  it('parses with defaults; pages are framed, the automation server is not', () => {
    const m = extensionManifestSchema.parse(kit);
    const act = m.features.find((f) => f.type === 'board_menu_action');
    expect(act).toMatchObject({ contexts: ['item'], modal: { width: 560, height: 420 } });
    expect(m.features.find((f) => f.type === 'dashboard_widget')).toMatchObject({ default_size: { w: 4, h: 3 } });
    expect(frameOriginsOf(m)).toEqual(['https://ext.example.com']);
    expect(m.features.filter(isFrameFeature).map((f) => f.key)).toEqual(['tab', 'act', 'bulk', 'w', 'settings']);
  });

  it("an automation server must be one of the extension's origins; inputs are typed", () => {
    expect(
      manifestIssues({
        ...kit,
        features: [{ type: 'automation_action', key: 'send', name: 's', url: 'https://evil.example.com/run' }],
      }),
    ).toEqual(['features.0.url: feature_origin_not_listed']);
    expect(
      manifestIssues({
        ...kit,
        features: [
          {
            type: 'automation_action',
            key: 'send',
            name: 's',
            url: 'https://api.example.com/run',
            inputs: [{ key: 'Bad Key', label: 'x', type: 'text' }],
          },
        ],
      }),
    ).not.toEqual([]);
  });

  it('a block is named <extension>.<feature>', () => {
    expect(blockKey('kit', 'send')).toBe('kit.send');
    expect(parseBlockKey('kit.send')).toEqual({ extension: 'kit', feature: 'send' });
    expect(parseBlockKey('mcp:task.inherit_account')).toBeNull();
    expect(parseBlockKey('kit')).toBeNull();
  });
});

/** a page in the sidebar (`app_page`) — a framed feature like the settings pages. */
describe('app_page', () => {
  const page = {
    type: 'app_page',
    key: 'inbox',
    name: 'שיחות',
    name_en: 'Conversations',
    url: 'https://ext.example.com/inbox',
  };
  const withPage = (f: Record<string, unknown>) => ({ ...base, features: [f] });

  it('parses, is framed, and names an icon of the app', () => {
    const m = extensionManifestSchema.parse(withPage({ ...page, icon: 'chat' }));
    expect(m.features[0]).toMatchObject({ type: 'app_page', key: 'inbox', icon: 'chat' });
    expect(m.features.filter(isFrameFeature).map((f) => f.key)).toEqual(['inbox']);
    expect(frameOriginsOf(m)).toEqual(['https://ext.example.com']);
    expect(APP_PAGE_ICONS).toContain('chat');
    // No icon is fine; an unknown (well-formed) name too — the app shows its generic one.
    expect(manifestIssues(withPage(page))).toEqual([]);
    expect(manifestIssues(withPage({ ...page, icon: 'rocketShip' }))).toEqual([]);
    expect(manifestIssues(withPage({ ...page, icon: '<svg onload=x>' }))).not.toEqual([]);
  });

  it('follows the frame rules: its own listed origin, http(s), no fragment, a key and a name', () => {
    expect(manifestIssues(withPage({ ...page, url: 'https://evil.example.com/inbox' }))).toEqual([
      'features.0.url: feature_origin_not_listed',
    ]);
    expect(manifestIssues(withPage({ ...page, url: 'https://ext.example.com/inbox#x' }))).not.toEqual([]);
    expect(manifestIssues(withPage({ ...page, url: 'javascript:alert(1)' }))).not.toEqual([]);
    expect(manifestIssues(withPage({ ...page, key: 'Bad Key' }))).not.toEqual([]);
    expect(manifestIssues(withPage({ ...page, name: '' }))).not.toEqual([]);
    expect(manifestIssues(withPage({ ...page, name: 'a‮b' }))).not.toEqual([]);
  });

  it('a new page needs consent again', () => {
    const before = extensionManifestSchema.parse(base);
    const after = extensionManifestSchema.parse({ ...base, features: [...base.features, page] });
    expect(manifestDelta(before, after)).toMatchObject({ addedFeatures: ['inbox'], needsConsent: true });
  });

  it('its token may set the count beside its own page, and nothing new besides', () => {
    expect(extensionPathAllowed('/ext/app-pages/inbox/badge', 'PUT')).toBe(true);
    expect(extensionPathAllowed('/ext/app-pages/inbox/badge', 'PUT', { server: true })).toBe(true);
    expect(extensionPathAllowed('/ext/app-pages', 'GET')).toBe(false);
    expect(extensionPathAllowed('/extensions/app-pages', 'GET')).toBe(false);
  });

  it('its place in the sidebar is kept like the other destinations (mine → the account’s → the sidebar)', () => {
    const account = { placement: { apps: { 'msg-x.inbox': 'top' as const } }, locked: false };
    const l = resolveNavLayout({ apps: { 'other.page': 'hidden' } }, account);
    expect(appNavPlace(l, 'msg-x.inbox')).toBe('top');
    expect(appNavPlace(l, 'other.page')).toBe('hidden');
    expect(appNavPlace(l, 'never.placed')).toBe('side');
    expect(cleanNavPlacement({ home: 'top', apps: { 'a-b.c': 'hidden', 'Bad key': 'top', 'x-y.z': 'left' } })).toEqual({
      home: 'top',
      apps: { 'a-b.c': 'hidden' },
    });
    expect(cleanNavPlacement({ apps: 'top' })).toEqual({});
  });
});
