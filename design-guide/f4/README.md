# F4 — the visual design (D24)

Mockups the product owner chose on 2026-10-03.
They are the visual spec for M7.5; `docs/11-UI-DESIGN.md` §1–8 stays the interaction spec.

| File | What it shows |
|---|---|
| `board-light-F4.dc.html` | **The chosen design** — the board screen, light: deep-green shell, the content as a floating white panel, status filling the cell, amber accent |
| `board-dark-F3.dc.html` | The same screen dark — the basis for dark mode |
| `board-dense-F1.dc.html` | The same screen with status as soft pills (not chosen) — kept for its density reference only |

All three share the "real-scale" content: a sidebar with search, favorites and many workspaces (collapsed ones with
counts), board header numbers, active-filter chips, open and collapsed groups (24 / 118 items), a group summary row
(status distribution bar + sum), priority / "updated" columns, an update counter on an item, overdue dates in red.

Open a file in a browser to read the markup: each is a Design Component (`<x-dc>` + a `renderVals()` script with the
data); the styles are inline. Token values extracted from them are in `docs/11-UI-DESIGN.md` §9.
