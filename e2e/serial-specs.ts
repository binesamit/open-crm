// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Specs that must never run beside another worker (s4f-e2e): they change account- or user-level state that every
 * other spec shares (the one local `demo` account and its owner), count account-wide things another worker
 * changes meanwhile, visit other accounts (the owner's last account decides where `signIn` lands), or empty the
 * shared Mailpit inbox. They run in the `serial` project — one worker, after the parallel part (see
 * playwright.config.ts). Everything not listed here runs in `isolated`.
 *
 * A new spec that touches any of this goes here. When unsure, list it: a serial spec only costs time.
 */
export const SERIAL_SPECS = [
  // Account settings (timezone, locale, logo, mail, security, default transfer user, tidy rules).
  'admin-a3',
  'admin-a45',
  'admin-users',
  // Incoming email: the platform's inbound domain and the account's inbound_email setting.
  'inbound-email',
  // an HTML email with images, through the stand-in provider (the same settings).
  'inbound-email-html',
  // The account's calendar: Hebrew dates and working days for every board.
  'hebcal',
  'generic',
  'locale',
  'mail',
  'phoneui',
  'sec2',
  'sec2-senders',
  'secret',
  'tz',
  // The owner's own settings: language, appearance / animations / theme, notification settings, favourites, sessions.
  // f9-cardw: the owner's card width, and the account's card width defaults.
  'f9-cardw',
  'fix3-lang',
  'fix4-shell',
  // the account's and the owner's sidebar / top bar layout.
  'nav-layout',
  // every surface vs the shell's bars — the owner's nav on top, and English (LTR) for a part.
  'layers',
  'fix5-card',
  'm4-settings',
  'm45-stage6',
  'm76-shell',
  'r10-shell',
  'r12-ui',
  'r13',
  'r15misc',
  'r16motion',
  'r17ui',
  'r19pwa',
  'r8-account',
  'r9-shell',
  // Admin areas of the account: templates (built-in ones removed / restored), teams, folders, extensions, flows, AI.
  'admin-hub',
  'agents',
  'agents-2',
  'ai2',
  'ai-attachments',
  'ai-refs',
  'aimodels',
  'extensions',
  'extensions-2',
  'flowfix2',
  'flows2',
  'fix2-account',
  'fix3-shell',
  'm3-board-copy',
  'm3-permissions',
  'm45-fixes',
  'make',
  'mcp',
  'mcp-oauth',
  'sync-ai',
  // Platform owner (/owner, platform settings, plans and subscriptions, other accounts, support).
  'aiprov',
  'apidocs',
  'extensions-3',
  'flows',
  'images',
  'invites',
  'kb',
  'kb-import',
  // Licensing: the installation's license, license server address and the first-run questionnaire.
  'licensing',
  's37license',
  'plan-features',
  'plan-gates-ui',
  'plan-lock',
  // the support agent's platform settings (log sources, SQL, auto-investigation).
  'support-agent',
  // schedules an account's deletion (the owner console's list) and the owner's 2FA-free state.
  'account-delete',
  'plans',
  // Self sign-up (D32): the platform's sign-up switch and settings, new accounts, the requests queue.
  'signup',
  'r16specs',
  'r18gates',
  'share',
  'support',
  'ticket-articles',
  'tickets',
  // Account-wide counts: the bell / inbox, My Work, search across the account, the sidebar's contents.
  'docs-2',
  'm1.1-sidebar',
  'm4-bell',
  'm4-mywork',
  'm4-search',
  'r8-look',
  's37-reply-focus',
  's4f-pwa',
  // Their own sign-in empties the shared Mailpit inbox (other workers' invitation / sign-in mails with it).
  'phase0',
  'phase1-boards',
  'phase1-computed',
  'phase1-files',
  'phase1-item-card',
  // PERF=1 only: a 10k-row board; earlier ones of the script go to the trash.
  'm2-perf',
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Matches the listed spec files (any directory separator). */
export const SERIAL_SPEC_FILES = new RegExp(`[\\\\/](?:${SERIAL_SPECS.map(escape).join('|')})\\.spec\\.ts$`);
