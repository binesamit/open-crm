// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { dirOf, dynamicKey, en, he, msgKey, t, tDynamic } from '../src';

describe('i18n', () => {
  it('en.json has exactly the keys of he.json', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(he).sort());
  });

  it('defaults to Hebrew and RTL', () => {
    expect(t('nav.myWork')).toBe('העבודה שלי');
    expect(dirOf('he')).toBe('rtl');
    expect(dirOf('en')).toBe('ltr');
  });
});

describe('runtime locale (fix3)', () => {
  it('t follows setLocale; an explicit locale still wins', async () => {
    const { getLocale, setLocale, subscribeLocale } = await import('../src');
    const seen: string[] = [];
    const off = subscribeLocale(() => seen.push(getLocale()));
    setLocale('en');
    expect(t('nav.myWork')).toBe(en['nav.myWork']);
    expect(t('nav.myWork', undefined, 'he')).toBe('העבודה שלי');
    setLocale('en');
    setLocale('he');
    off();
    expect(seen).toEqual(['en', 'he']);
    expect(t('nav.myWork')).toBe('העבודה שלי');
  });
});

describe('typed key helpers (dedup-1)', () => {
  it('msgKey keeps a literal key; tDynamic / dynamicKey take one built at runtime', () => {
    expect(msgKey('nav.myWork')).toBe('nav.myWork');
    // @ts-expect-error — a key that does not exist fails the typecheck.
    msgKey('nav.noSuchKey');
    const kind = 'myWork';
    expect(tDynamic(`nav.${kind}`, undefined, 'en')).toBe(t('nav.myWork', undefined, 'en'));
    expect(t(dynamicKey('nav.noSuchKey'))).toBe('nav.noSuchKey');
  });
});
