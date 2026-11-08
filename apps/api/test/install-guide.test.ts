// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INSTALL_GUIDE_SECTIONS } from '@bines/shared';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';
import { INSTALL_GUIDE_EN_MD, INSTALL_GUIDE_HE_MD } from '../src/modules/apidocs/install-guide.generated';
import { guideDocLink, renderGuidePage, renderInstallGuideBody } from '../src/modules/apidocs/install-guide';
import { readGuide } from '../scripts/gen-install-guide';

/**
 * Guides: the installation and licensing guide — bundled from docs/GUIDE*.md, public at
 * /api/docs/guide[/he] (no sign-in, no script, its own CSP) and inside the app (GET /guides/install).
 */
let t: TestContext;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
beforeAll(async () => {
  t = await createTestContext();
});
afterAll(() => t.close());

describe('installation guide — bundled Markdown', () => {
  it('is in sync with docs/GUIDE.md and docs/GUIDE.he.md (run `pnpm --filter @bines/api docs:guide` after editing them)', () => {
    expect(INSTALL_GUIDE_EN_MD).toBe(readGuide('GUIDE.md'));
    expect(INSTALL_GUIDE_HE_MD).toBe(readGuide('GUIDE.he.md'));
  });

  it('links the two languages to each other and drops other repository paths', () => {
    expect(guideDocLink('GUIDE.he.md')).toBe('/api/docs/guide/he');
    expect(guideDocLink('GUIDE.md#7-activating-a-license-key')).toBe('/api/docs/guide#7-activating-a-license-key');
    expect(guideDocLink('#9-renewal-and-expiry')).toBe('#9-renewal-and-expiry');
    expect(guideDocLink('SELF-HOSTING.md#backups')).toBeNull();
    expect(guideDocLink('../LICENSE.md')).toBeNull();
    expect(guideDocLink('javascript:alert(1)')).toBeNull();
  });

  it('numbers the linked sections the same way in both languages (the license card links to them)', () => {
    const en = renderInstallGuideBody('en', { productName: 'X' });
    const he = renderInstallGuideBody('he', { productName: 'X' });
    for (const key of Object.keys(INSTALL_GUIDE_SECTIONS)) {
      expect(en.sections[key], `en ${key}`).toBeTruthy();
      expect(he.sections[key], `he ${key}`).toBeTruthy();
    }
    expect(en.sections.activate).toBe('7-activating-a-license-key');
    expect(en.sections.renewal).toBe('9-renewal-and-expiry');
    expect(en.sections.license_card).toBe('8-the-license-card');
    expect(en.sections.registration).toBe('5-the-registration-questionnaire-optional');
    expect(he.sections.activate).toBe('7-הפעלת-מפתח-רישיון');
    expect(he.sections.renewal).toBe('9-חידוש-ותפוגה');
  });
});

describe('installation guide — the public pages', () => {
  it('serves English and Hebrew without sign-in or script, under the strict docs CSP', async () => {
    for (const [path, lang, dir, heading] of [
      ['/api/docs/guide', 'en', 'ltr', 'Installation and licensing guide'],
      ['/api/docs/guide/he', 'he', 'rtl', 'מדריך התקנה ורישוי'],
    ] as const) {
      const res = await t.app.request(path);
      expect(res.status, path).toBe(200);
      const csp = res.headers.get('content-security-policy')!;
      expect(csp).toContain("default-src 'none'");
      expect(csp).not.toContain('script-src');
      const html = await res.text();
      expect(html).toContain(`<html lang="${lang}" dir="${dir}">`);
      expect(html).toContain(heading);
      expect(html).not.toMatch(/<script/i);
      expect(html).toContain('href="/api/docs/guide.css"');
      // The language switch, the current one marked; the table of contents.
      expect(html).toContain(`<a href="${path}" hreflang="${lang}" aria-current="page">`);
      expect(html).toContain('<aside class="toc">');
      // Repository files are text, not broken links.
      expect(html).not.toMatch(/href="[^"]*\.md/);
    }
    const en = await (await t.app.request('/api/docs/guide')).text();
    expect(en).toContain('id="7-activating-a-license-key"');
    expect(en).toContain('href="/api/docs/guide/he"');
    const css = await t.app.request('/api/docs/guide.css');
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');
  });

  it("is white-label: the owner's product name in the title", async () => {
    const page = renderGuidePage('en', { productName: 'Acme Work' });
    expect(page).toContain('<title>Installation and licensing guide · Acme Work</title>');
    const owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
    expect((await t.api(owner).patch('/platform/settings', { product_name: 'Acme Work' })).status).toBe(200);
    try {
      const html = await (await t.app.request('/api/docs/guide/he')).text();
      expect(html).toContain('<span class="brand">Acme Work</span>');
    } finally {
      await t.api(owner).patch('/platform/settings', { product_name: null });
    }
  });
});

describe('installation guide — in the app (GET /guides/install)', () => {
  it('returns the guide in the asked language: safe HTML, headings, sections and the public path', async () => {
    const owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
    const he = (await (await t.api(owner).get('/guides/install?locale=he')).json()) as Json;
    expect(he.locale).toBe('he');
    expect(he.title).toBe('מדריך התקנה ורישוי');
    expect(he.public_path).toBe('/api/docs/guide/he');
    expect(he.sections.activate).toBe('7-הפעלת-מפתח-רישיון');
    expect(he.html).toContain('<pre><code');
    expect(he.html).not.toMatch(/<script/i);
    expect(typeof he.product_name).toBe('string');
    const en = (await (await t.api(owner).get('/guides/install?locale=en')).json()) as Json;
    expect(en.public_path).toBe('/api/docs/guide');
    expect(en.headings.some((h: Json) => h.depth === 2 && h.id === '9-renewal-and-expiry')).toBe(true);
  });

  it('follows the interface language by default, and needs a session', async () => {
    const owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
    const doc = (await (await t.api(owner).get('/guides/install')).json()) as Json;
    expect(['he', 'en']).toContain(doc.locale);
    expect((await t.api('').get('/guides/install')).status).toBe(401);
    expect((await t.api(owner).get('/guides/install?locale=fr')).status).toBe(400);
  });
});
