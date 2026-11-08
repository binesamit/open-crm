// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from 'vitest/config';

// Each test file boots its own PGlite (WASM Postgres) and runs every migration; in parallel that can take a while.
export default defineConfig({
  test: { hookTimeout: 60_000, testTimeout: 30_000, setupFiles: ['./test/setup-env.ts'] },
});
