// SPDX-License-Identifier: MIT
// Removes the previous build so a renamed or deleted file never ships.
import { rmSync } from 'node:fs';

rmSync(new URL('../dist', import.meta.url), { recursive: true, force: true });
