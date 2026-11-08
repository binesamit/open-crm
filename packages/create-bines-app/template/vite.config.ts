// SPDX-License-Identifier: MIT
import { defineConfig } from 'vite';
import { manifest } from './manifest.config.mjs';

// The local dev server (development only: a production Bines refuses localhost origins). It serves the page and,
// at /manifest.json, the manifest pointing at this origin — paste that URL in Administration → Extensions.
const PORT = Number('__PORT__');
const ORIGIN = `http://localhost:${PORT}`;
const SERVER_ORIGIN = `http://localhost:${Number('__SERVER_PORT__')}`;

export default defineConfig({
  server: {
    port: PORT,
    strictPort: true,
    host: 'localhost',
    headers: {
      // Who may frame this page: your Bines (here: a local one). In production, your Bines origin only.
      'Content-Security-Policy': 'frame-ancestors http://localhost:* http://127.0.0.1:*',
    },
  },
  plugins: [
    {
      name: 'bines-manifest',
      configureServer(server) {
        server.middlewares.use('/manifest.json', (_req, res) => {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(manifest(ORIGIN, SERVER_ORIGIN), null, 2));
        });
      },
    },
  ],
});
