// SPDX-License-Identifier: AGPL-3.0-only
/** Paths and CSP of the extension developer guide pages (s37docs) — no imports, so security-headers can use them. */
export const EXT_DOCS_BASE = '/api/docs/extensions';
export const EXT_QUICKSTART_PATH = `${EXT_DOCS_BASE}/quickstart`;
export const EXT_DOCS_CSS_PATH = `${EXT_DOCS_BASE}.css`;

/** The pages' CSP: a server-rendered page with one same-origin stylesheet — no script at all. */
export const EXT_DOCS_CSP = [
  "default-src 'none'",
  "style-src 'self'",
  "img-src 'self' data: https:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** The installation and licensing guide: English at the base, Hebrew at `/he`; the same CSP. */
export const GUIDE_DOCS_BASE = '/api/docs/guide';
export const GUIDE_DOCS_HE_PATH = `${GUIDE_DOCS_BASE}/he`;
export const GUIDE_DOCS_CSS_PATH = `${GUIDE_DOCS_BASE}.css`;
