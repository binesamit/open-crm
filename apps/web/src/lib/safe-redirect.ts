// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Same-origin paths only, so a `?redirect=` or a message cannot bounce people to another site. Browsers read
 * `/\evil.com` as `//evil.com`, so a backslash (or a control character) anywhere refuses the value too.
 */
export const safeRedirect = (value: unknown): string =>
  // eslint-disable-next-line no-control-regex
  typeof value === 'string' && /^\/(?![/\\])/.test(value) && !/[\\\u0000-\u001f]/.test(value) ? value : '/';
