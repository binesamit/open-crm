// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from 'tsup';

// Workspace packages ship TS source, so they are bundled into the API build; npm deps stay external.
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    // Standalone mode (the Docker image's default): api + web + jobs in one process, embedded database.
    standalone: 'src/standalone.ts',
    migrate: 'src/db/migrate.ts',
    seed: 'src/db/seed.ts',
    'first-admin-link': 'src/db/first-admin-link.ts',
  },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  clean: true,
  noExternal: [/^@bines\//],
});
