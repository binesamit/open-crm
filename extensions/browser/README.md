# Bines browser extension (Chrome / Edge side panel)

Prod. A thin shell, **not part of core**. The side panel holds one iframe with Bines' panel page
(`/a/<account>/x/<installation>/panel`). That page shows the "Browser panel" in-app extension's strip on top of the
app's own item card. This package keeps no data and has no UI of its own beyond setup.

- The Bines origin needs **host permission** (requested on save). Without it the browser sends no session cookie to
  the framed page.
- The platform owner must list this extension's origin under "allowed embedding origins" in the owner console. The
  manifest's public `key` pins the id of an unpacked install to `npnijnbeoobckbpeifpgcolhecmckkgn`
  (origin `chrome-extension://npnijnbeoobckbpeifpgcolhecmckkgn`); a store listing gets its own id.
- Extensions framed inside the panel page must allow it too (frame-ancestors checks every ancestor): build the hosted
  catalogue with `--embedded-by chrome-extension://npnijnbeoobckbpeifpgcolhecmckkgn`.
- The sites the panel reads (for now only their address) are optional host permissions, requested per site.

Load it unpacked: chrome://extensions (or edge://extensions) → Developer mode → "Load unpacked" → this folder.
