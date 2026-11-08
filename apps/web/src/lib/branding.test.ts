// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { t, type AuthConfig } from '@bines/shared';
import { applyBrandTitle, brandText, brandingFor } from './branding';

const config: AuthConfig = {
  google: false,
  microsoft: false,
  magic_link: true,
  password_min_length: 8,
  branding: { product_name: { he: 'מוצר', en: 'Product' }, login_subtitle: { he: 'שורה', en: null } },
  source: { url: 'https://example.com/source', version: '1.0.0', commit: null },
  captcha: { site_key: null, sign_in: false, sign_up: false, forgot_password: false },
};

describe('branding (s37generic)', () => {
  it('resolves the product name and tagline per language; nothing loaded = the catalog name, no tagline', () => {
    expect(brandingFor(config, 'he')).toEqual({ productName: 'מוצר', loginSubtitle: 'שורה' });
    expect(brandingFor(config, 'en')).toEqual({ productName: 'Product', loginSubtitle: null });
    expect(brandingFor(undefined, 'en')).toEqual({ productName: t('app.name', undefined, 'en'), loginSubtitle: null });
  });

  it("sets an empty or product-name title, never a page's own title", () => {
    const doc = { title: '' };
    applyBrandTitle('Product', doc);
    expect(doc.title).toBe('Product');
    applyBrandTitle('מוצר', doc);
    expect(doc.title).toBe('מוצר');
    doc.title = 'A public form';
    applyBrandTitle('Product', doc);
    expect(doc.title).toBe('A public form');
  });
});

describe('brandText (s37generic)', () => {
  it('fills {product} with the product name (the catalog name until the branding loaded); own vars win', () => {
    expect(brandText('flows.draft.step.bines', { resource: 'item', operation: 'create' })).not.toContain('{product}');
    expect(brandText('app.name', { product: 'X' })).toBe(t('app.name'));
  });
});
