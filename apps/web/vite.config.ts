// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { pwaServiceWorker } from './vite-pwa.ts';

// Dev only: another port / API (a second stack beside the usual one). Default 5173 → 3000.
const API = process.env.BINES_DEV_API ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react(), tailwindcss(), pwaServiceWorker()],
  server: {
    port: Number(process.env.BINES_DEV_WEB_PORT) || 5173,
    // IPv4 explicitly: Node resolves 'localhost' to ::1 only, which tools probing 127.0.0.1 (Playwright) miss.
    host: '127.0.0.1',
    // Same-origin API in dev so the Better Auth session cookie just works — the docs' WebSocket too (M8, /api/v1/collab).
    // `/mcp` = the MCP server (AI tools), on the web origin like in production.
    // `/oauth` + `/.well-known` = its OAuth authorization server (מ5); `/connect` (the consent page) stays the SPA's.
    proxy: {
      '/api': { target: API, ws: true },
      '/mcp': API,
      '/oauth': API,
      '/.well-known': API,
    },
  },
});
