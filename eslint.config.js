// SPDX-License-Identifier: AGPL-3.0-only
// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.turbo/**',
      'reference/**',
      'design-guide/**',
      'scripts/**',
      '.claude/**',
      // The n8n nodes lint with n8n's own config (`pnpm --filter n8n-nodes-bines-os lint:n8n`, @n8n/node-cli —
      // stricter, and its rule names are unknown here); it runs before every publish (prepublishOnly).
      'integrations/n8n-nodes-bines-os/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  // Package boundaries (01-ARCHITECTURE §1): shared imports nothing internal; api never imports web/worker.
  {
    files: ['packages/shared/**'],
    rules: { 'no-restricted-imports': ['error', { patterns: ['@bines/*'] }] },
  },
  {
    files: ['apps/api/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@bines/web', '@bines/worker', '@bines/ui'] },
            // Every notification goes through `notifyUsers` (the user's settings and the required types, 08 §12.3).
            {
              group: ['**/notifications/notifications.repo', './notifications.repo'],
              importNames: ['insertNotifications'],
              message: 'Write notifications with notifyUsers (modules/notifications/notify.ts), never directly.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/api/src/modules/notifications/notify.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: ['@bines/web', '@bines/worker', '@bines/ui'] }] },
  },
  {
    files: ['apps/web/**'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  // Button types: inside a <form> a <button> without a type is a submit button, and Enter in any field "clicks" the
  // form's FIRST one (Enter in the secret panel hit Cancel / Clear). `Button` (@bines/ui) defaults to
  // type="button", so a form's submit button must say type="submit"; a native <button> always states its type
  // (what react/button-has-type checks — eslint-plugin-react is not a dependency here).
  {
    files: ['apps/web/**/*.tsx', 'packages/ui/**/*.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXOpeningElement[name.name='button']:not(:has(> JSXAttribute[name.name='type']))",
          message: 'Give every <button> an explicit type ("button", or "submit" for the form\'s submit button).',
        },
        {
          selector:
            "JSXElement[openingElement.name.name='form'] JSXOpeningElement[name.name='Button']:not(:has(> JSXAttribute[name.name='type']))",
          message:
            'A Button inside a <form> states its type: type="submit" for the submit button, type="button" for the rest.',
        },
      ],
    },
  },
  // The phone app's service worker template (PWA): the build fills in the placeholders (apps/web/vite-pwa.ts).
  {
    files: ['apps/web/src/pwa/sw.template.js'],
    languageOptions: {
      globals: {
        ...globals.serviceworker,
        __PRECACHE__: 'readonly',
        __SW_ROUTE__: 'readonly',
        __SW_MARK_READ__: 'readonly',
      },
    },
  },
  // Extension pages and their SDK run in the browser (D27): extensions/* and packages/ext-sdk.
  {
    files: ['extensions/**', 'packages/ext-sdk/**', 'packages/create-bines-app/template/src/**'],
    languageOptions: { globals: { ...globals.browser } },
  },
  // The Chrome / Edge side-panel extension: its pages and service worker use the `chrome` API.
  {
    files: ['extensions/browser/**'],
    languageOptions: { globals: { ...globals.browser, ...globals.serviceworker, chrome: 'readonly' } },
  },
  // The Make app's IML functions (integrations/make-app-bines-os/app/functions): plain scripts Make runs by name,
  // with Make's `iml` helpers in scope — each file declares one function nothing in the file calls.
  {
    files: ['integrations/make-app-bines-os/app/functions/**'],
    languageOptions: { sourceType: 'script', globals: { iml: 'readonly' } },
    rules: { '@typescript-eslint/no-unused-vars': ['error', { vars: 'local', caughtErrors: 'none' }] },
  },
  prettier,
);
