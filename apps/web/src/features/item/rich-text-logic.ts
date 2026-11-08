// SPDX-License-Identifier: AGPL-3.0-only
import { firstStrongDir, type TextDir } from '@bines/ui';

/**
 * Fix: — the pure parts of lists and check lists (no editor, no DOM), shared by docs and updates:
 * a block's direction from its own text, and toggling one check box of a stored update.
 */
export type Dir = TextDir;

/** The direction of a text by its first strong letter; null when it has none (shared with every text field). */
export { firstStrongDir };

/** Toggling one check box of a stored update — shared with the server. */
export { setTaskChecked, taskCount } from '@bines/shared';
