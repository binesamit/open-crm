// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The API reference in the product's look (F4, 11-UI-DESIGN §9; dark = F3): the navigation sits on the deep-green
 * shell, the content is the white panel, the main call to action ("Send") is amber. The values mirror
 * `packages/ui/src/tokens.css` (a test keeps them equal), because the API serves this page without the web build.
 * `brand` (Platform settings, else env API_DOCS_BRAND_COLOR) replaces the shell / brand ink for a white-label deployment.
 */
export const F4 = {
  light: {
    shell: '#0d3b35',
    shellFg: '#cfe3de',
    shellMuted: '#8fb8ae',
    surface: '#ffffff',
    surface2: '#f1f6f4',
    surface3: '#f7faf9',
    fg: '#13221f',
    heading: '#0d3b35',
    fg2: '#33524b',
    muted: '#5d756f',
    line: '#e3ece9',
    lineStrong: '#d5e2de',
    primary: '#0d3b35',
    primarySoft: '#e3efeb',
    accent: '#ffb020',
    onAccent: '#0d3b35',
    danger: '#d93049',
    warn: '#e8920c',
    ok: '#13a067',
    info: '#2f6fe0',
    violetFg: '#5f2fa8',
  },
  dark: {
    shell: '#072420',
    shellMuted: '#7fa89e',
    surface: '#0f2e29',
    surface2: '#163a34',
    surface3: '#12332e',
    fg: '#e3efec',
    heading: '#f2f8f6',
    fg2: '#b5cec8',
    muted: '#8fb0a8',
    line: '#1f453e',
    lineStrong: '#2a524b',
    primary: '#f2f8f6',
    primarySoft: '#1d4a42',
    okFg: '#6edcab',
    infoFg: '#8db4ff',
    violetFg: '#c9a8ff',
  },
  fontBody: "'Rubik', system-ui, -apple-system, 'Segoe UI', sans-serif",
  fontDisplay: "'Heebo', 'Rubik', system-ui, -apple-system, 'Segoe UI', sans-serif",
  fontMono: "'IBM Plex Mono', ui-monospace, 'Cascadia Code', Consolas, monospace",
  radiusSm: '7px',
  radius: '12px',
  radiusLg: '16px',
} as const;

const HEX = /^#[0-9a-fA-F]{6}$/;

export const themeCss = (brand?: string): string => {
  const l = F4.light;
  const d = F4.dark;
  const shell = brand && HEX.test(brand) ? brand : l.shell;
  return `
:root {
  --scalar-font: ${F4.fontBody};
  --scalar-font-code: ${F4.fontMono};
  --scalar-radius: ${F4.radiusSm};
  --scalar-radius-lg: ${F4.radius};
  --scalar-radius-xl: ${F4.radiusLg};
  --docs-shell: ${shell};
}
.light-mode {
  --scalar-color-1: ${l.fg};
  --scalar-color-2: ${l.fg2};
  --scalar-color-3: ${l.muted};
  --scalar-color-accent: ${brand && HEX.test(brand) ? brand : l.primary};
  --scalar-background-1: ${l.surface};
  --scalar-background-2: ${l.surface2};
  --scalar-background-3: ${l.line};
  --scalar-background-accent: ${l.primarySoft};
  --scalar-border-color: ${l.line};
  --scalar-color-green: ${l.ok};
  --scalar-color-red: ${l.danger};
  --scalar-color-yellow: ${l.warn};
  --scalar-color-blue: ${l.info};
  --scalar-color-orange: ${l.warn};
  --scalar-color-purple: ${l.violetFg};
  --scalar-button-1: ${l.accent};
  --scalar-button-1-hover: #f5a50f;
  --scalar-button-1-color: ${l.onAccent};
  --scalar-code-language-color-supersede: ${l.muted};
}
.dark-mode {
  --scalar-color-1: ${d.fg};
  --scalar-color-2: ${d.fg2};
  --scalar-color-3: ${d.muted};
  --scalar-color-accent: ${d.okFg};
  --scalar-background-1: ${d.surface};
  --scalar-background-2: ${d.surface3};
  --scalar-background-3: ${d.surface2};
  --scalar-background-accent: ${d.primarySoft};
  --scalar-border-color: ${d.line};
  --scalar-color-green: ${d.okFg};
  --scalar-color-red: #ff8a9b;
  --scalar-color-yellow: ${l.accent};
  --scalar-color-blue: ${d.infoFg};
  --scalar-color-orange: #ffc65a;
  --scalar-color-purple: ${d.violetFg};
  --scalar-button-1: ${l.accent};
  --scalar-button-1-hover: #ffc65a;
  --scalar-button-1-color: ${l.onAccent};
  --scalar-code-language-color-supersede: ${d.muted};
}
/* The navigation on the deep-green shell, as in the app's sidebar. */
.light-mode .t-doc__sidebar,
.dark-mode .t-doc__sidebar {
  --scalar-sidebar-background-1: var(--docs-shell);
  --scalar-sidebar-color-1: #ffffff;
  --scalar-sidebar-color-2: ${l.shellFg};
  --scalar-sidebar-color-active: #ffffff;
  --scalar-sidebar-item-hover-color: #ffffff;
  --scalar-sidebar-item-hover-background: rgba(255, 255, 255, 0.07);
  --scalar-sidebar-item-active-background: rgba(255, 255, 255, 0.14);
  --scalar-sidebar-border-color: rgba(255, 255, 255, 0.12);
  --scalar-sidebar-search-background: rgba(255, 255, 255, 0.08);
  --scalar-sidebar-search-border-color: rgba(255, 255, 255, 0.18);
  --scalar-sidebar-search-color: ${l.shellMuted};
  --scalar-sidebar-indent-border: rgba(255, 255, 255, 0.12);
  --scalar-sidebar-indent-border-hover: rgba(255, 255, 255, 0.3);
  --scalar-sidebar-indent-border-active: ${l.accent};
}
.dark-mode .t-doc__sidebar { --scalar-sidebar-background-1: ${d.shell}; --scalar-sidebar-search-color: ${d.shellMuted}; }
.t-doc__sidebar .sidebar-heading-type,
.t-doc__sidebar [class*='sidebar-heading-type'] { opacity: 0.95; }
.markdown h1, .markdown h2, .section-header, .t-editor__page-title h1 {
  font-family: ${F4.fontDisplay};
  font-weight: 800;
  letter-spacing: -0.4px;
}
.light-mode .markdown h1, .light-mode .markdown h2, .light-mode .section-header { color: ${l.heading}; }
.markdown table { font-variant-numeric: tabular-nums; }
.light-mode *::selection { background-color: ${l.primarySoft}; }
/* The internal reference (owner only): a bar on every screen; the public page's link to it, for the owner only. */
.docs-internal-bar { position: sticky; top: 0; z-index: 1000; padding: 6px 16px; background: ${l.warn}; color: ${l.onAccent};
  font: 600 13px/1.4 ${F4.fontBody}; text-align: center; }
.docs-internal-bar a { color: inherit; text-decoration: underline; }
.docs-owner-link { position: fixed; bottom: 16px; right: 16px; z-index: 1000; padding: 6px 12px; border-radius: 10px;
  background: ${l.accent}; color: ${l.onAccent}; font: 600 13px/1.4 ${F4.fontBody}; text-decoration: none;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18); }
.docs-owner-link:hover { filter: brightness(0.95); }
`;
};
