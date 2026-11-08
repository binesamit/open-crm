// SPDX-License-Identifier: AGPL-3.0-only
import { SERIAL_SPECS } from './serial-specs';

/**
 * Specs that use the machine's real clipboard (navigator.clipboard read / write, or the app's copy buttons read back)
 *. The clipboard is one per machine, not per browser: when run-stacks.mjs runs several stacks at
 * once, two of these in different stacks would overwrite each other's text. So every stack skips them
 * (E2E_CLIPBOARD=skip) and one stack runs them all after its share (E2E_CLIPBOARD=only). A plain run is unaffected.
 *
 * A new spec that touches the real clipboard goes here. A synthetic paste (`new ClipboardEvent('paste', …)`) does not
 * — it never reaches the machine's clipboard.
 */
export const CLIPBOARD_SPECS = ['bulk-edit', 'bulk-subitems', 'm45-grid', 'r15misc', 's37-market-docs', 'secret'];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const files = (names: string[]) => new RegExp(`[\\\\/](?:${names.map(escape).join('|')})\\.spec\\.ts$`);

/** Matches the listed spec files (any directory separator). */
export const CLIPBOARD_SPEC_FILES = files(CLIPBOARD_SPECS);
/** The clipboard specs that are also serial (serial-specs.ts) — the `serial` project's share of an `only` run. */
export const SERIAL_CLIPBOARD_SPEC_FILES = files(CLIPBOARD_SPECS.filter((s) => SERIAL_SPECS.includes(s)));
