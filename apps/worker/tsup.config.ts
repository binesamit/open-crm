// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from 'tsup';

// Workspace packages ship TS source, so they are bundled into the API build; npm deps stay external.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  clean: true,
  noExternal: [/^@bines\//],
});
