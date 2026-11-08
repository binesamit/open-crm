// SPDX-License-Identifier: AGPL-3.0-only
import type { UpdateViewDevice } from '@bines/shared';

/**
 * The device class and a short "browser · OS" of a request, from its headers — never from what the client says
 * about itself in the body. `Sec-CH-UA-Mobile: ?1` (Chromium's client hint) marks a phone; otherwise the
 * User-Agent decides. Only the summary is kept, never the full User-Agent string.
 */
export const deviceOf = (userAgent: string | undefined, chMobile?: string | undefined) => {
  const ua = userAgent ?? '';
  // An Android without "Mobile" is a tablet (Google's UA guidance). iPadOS in desktop mode reads as a Mac.
  const tablet = /iPad|Tablet|PlayBook|Silk|Kindle/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua));
  const mobile = chMobile?.trim() === '?1' || (!tablet && /Mobi|iPhone|iPod|Android.*Mobile|Windows Phone/i.test(ua));
  const device: UpdateViewDevice = tablet ? 'tablet' : mobile ? 'mobile' : 'desktop';
  return { device, summary: summaryOf(ua) };
};

const BROWSERS: [RegExp, string][] = [
  [/Edg(e|A|iOS)?\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/SamsungBrowser\//, 'Samsung Internet'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/CriOS\/|Chrome\//, 'Chrome'],
  [/Safari\//, 'Safari'],
];
const SYSTEMS: [RegExp, string][] = [
  [/Windows/, 'Windows'],
  [/iPhone|iPad|iPod/, 'iOS'],
  [/Android/, 'Android'],
  [/CrOS/, 'ChromeOS'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/Linux/, 'Linux'],
];

/** "Chrome · Windows", "Safari · iOS"; '' when nothing is recognised (a script, a bot). */
export const summaryOf = (ua: string) => {
  const browser = BROWSERS.find(([re]) => re.test(ua))?.[1];
  const os = SYSTEMS.find(([re]) => re.test(ua))?.[1];
  return [browser, os].filter(Boolean).join(' · ').slice(0, 64);
};
