// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from 'tsup';

// One file for the image: the workspace packages (TS source) and the pure-ESM dependencies are bundled; only `pg`
// stays a runtime dependency.
export default defineConfig({
  entry: { main: 'src/main.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  clean: true,
  external: ['pg'],
  noExternal: [/^@bines\//, /^hono/, /^@hono\//, /^zod/, /^marked/, /^ulid/, /^libphonenumber-js/],
});
