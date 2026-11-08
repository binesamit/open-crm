// SPDX-License-Identifier: AGPL-3.0-only
// Test-only stand-in for the map providers (M8 ד10), started by playwright.config.ts: the api's geocoding queue
// (GEOCODER_URL, Nominatim's /search) and the map style (MAP_STYLE_URL) point here, so an E2E run never calls
// Nominatim (its usage policy) or OpenFreeMap. /search finds nothing (the cell becomes "not found"); the style is a
// blank background (the markers are DOM elements and need no tiles). Address completion (PHOTON_URL, Photon's /api/)
// answers with no places, so typing in a location cell never reaches photon.komoot.io either.
import { createServer } from 'node:http';

const PORT = Number(process.env.FAKE_GEO_PORT ?? 3999);

const STYLE = {
  version: 8,
  name: 'e2e-blank',
  sources: {},
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#eef3f8' } }],
};

const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body));
};

createServer((req, res) => {
  const { pathname } = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  if (pathname === '/health') return send(res, 200, { ok: true });
  if (pathname === '/search') return send(res, 200, []);
  if (pathname === '/api/') return send(res, 200, { type: 'FeatureCollection', features: [] });
  if (pathname === '/style.json') return send(res, 200, STYLE);
  return send(res, 404, { error: 'not_found' });
}).listen(PORT, '127.0.0.1');
