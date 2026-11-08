# 11 — UI / frontend spec

The interaction and visual design spec: what each screen contains, where every control sits, how menus open, and the
design tokens, palette, RTL rules, components and accessibility rules behind them. For frontend contributors and
anyone changing the look of the app.

## 1. Information architecture

- **Shell** (`features/shell/AppShell.tsx`, the F4 design — D24): the deep-green shell holds the sidebar; the page
  sits in one floating panel (`.app-panel`). Each general place (the account's mark, the destinations — Home, My work,
  Inbox (with a counter), Automations, Flows, Agents, Help — search (Ctrl+B), the assistant, the bell) sits either in
  the sidebar or in a top bar across the window: the account's default, or the member's own choice (`GET /me/nav`). A
  place may also be hidden. The workspace picker and the tree of folders and boards (`Sidebar.tsx`, drag and drop, ⋯,
  "New board") and the avatar menu always stay in the sidebar. **Collapse**: a button at the bottom of the sidebar
  collapses it to a rail of large icons (76px; 24px icon on a 48px target) — the account mark, bell, avatar, search
  and navigation; the tree is hidden; remembered per device (`lib/theme.ts` `useRail`). **Mobile** (<768px): a top bar
  on the shell (drawer button, the screen's name, search, bell), a five-tab bottom navigation, and the sidebar as a
  drawer that closes on every navigation. Exactly one bell and one search palette are mounted in any layout (they own
  Ctrl+B and the live stream).
- **Guest**: the same shell (`AppShell`) with the sidebar limited to the shared boards, and a guest home
  (`features/shell/GuestHome.tsx`) instead of the regular home ([`09-CLIENT-PORTAL.md`](09-CLIENT-PORTAL.md)). There is
  no separate shell.
- Routes (D12 — everything inside an account is under `/a/:accountSlug`): `/a/:accountSlug/w/:workspaceId`,
  `/a/:accountSlug/b/:boardId` (a view is chosen with `?view=`), `/a/:accountSlug/i/:boardId/:itemId` (the item card
  as a modal over the board, deep-linkable), `/a/:accountSlug/{my-work,inbox,trash,archive,automations,flows,agents,profile,admin/*}`,
  docs `/a/:accountSlug/d/:docId` and dashboards `/a/:accountSlug/dash/:dashboardId`. Outside an account: `/`
  (redirect to the last account / account picker), `/owner` (owner console), `/f/:token` (public form), `/p/:token`
  (public interactive document), `/login`, `/signup`, `/invite/:token`.
- Account switcher: in the avatar menu — the user's accounts with logo and role; shown only when there is more than
  one. A guest who belongs to one account does not see it.

## 2. Board page

Header: name (inline rename; the arrow opens the board menu: ID, Activity log, Permissions, Settings, Notifications,
Duplicate, Export, Save as template, Archive, Delete), description (i), view tabs (+ = views center), and on the end
side: **Automate /N**, **Members /N**, Permissions, link icon, ⋯.
Toolbar: New item (+ dropdown: add at top / bottom, import), board search, Person, Filter (rule builder = the API's
query rules, saved to the view), Sort, Group by, Hide columns, Collapse all (Ctrl+G).
Groups: a coloured header with a menu (collapse, rename, colour, move to board, duplicate, archive, delete, select
all), an item counter; **column headers** sticky with a menu, drag to reorder, drag the edge to resize, an i marker for
the description; **rows** with a checkbox on hover, an expand arrow for children, a conversation icon with the updates
counter, cells by `cell.renderer`; a **footer** with summaries; "+ Add item" at the end of a group; "+ Add group" at
the end of the board.
Batch bar: N selected · Duplicate · Export · Archive · Delete · Move to (group / board) · Convert · ✕; clicking the
status / people cell of a selected item changes all of them.
Grid: TanStack Virtual (rows and columns), inline editing, keyboard navigation (arrows, Tab, Enter, Esc, Delete,
Ctrl+C/V), optimistic updates with rollback, SSE for refresh.

## 3. Item card

A wide modal (or a full page on mobile): title = name (inline), ⬆⬇ navigation between items, ⋯ (duplicate, move,
archive, delete, copy link). Tabs: **Updates** (rich editor: B/I/U, lists, link, @ (people / teams / everyone on this
item, board or account), files, emoji; threaded replies, likes, edit / delete; "Update via email"), **Files** (a
gallery of all of the item's files), **Activity**, **Subitems** (a nested table), **Columns** (all cells as a form in a
side / bottom panel — required on mobile).

## 4. Views

Table (default, cannot be deleted), **Kanban** (a lane per status / dropdown label, cards with chosen fields, drag =
change the value), **Calendar** (by date / timeline; "show by hours" — day / 3 days / week / work week, with hours
taken from a timeline with times or a date plus two `hour` columns, drag with snapping, resize the end from the bottom
edge, create by dragging on empty space, overlapping events side by side, an "all day" strip, a small card; month view
with continuous bars for multi-day items — the logic is in `packages/shared/src/views/calendar-time.ts`), **Cards**
(gallery), **Form** (builder: questions = columns, required, description, order, logo, thank-you message, sharing /
password / closing), **Timeline**, **Gantt**, **Workload**, **Chart**, **Files**, **Map**, a board **Dashboard**, and
extension views. Details: [`15-VIEWS.md`](15-VIEWS.md).

## 5. Column center

An "Add column" panel with the most-used types plus "More columns" → a Column Center modal by the registry's
categories (`category`), search, a card per type with "Add".

## 6. Automation center

Create (templates by category, plus "from scratch" — a sentence builder: When [trigger] and only if [condition] then
[action], each placeholder a popover), Manage (list, switch, owner, runs, errors), Usage.

## 7. Permissions

A dialog with a permission-set picker (4), categories with ✓ / ✗, **View items: All / Only assigned or created
[choose the assignment column]**, Members / Owners, and column restrictions from the column's menu.

## 8. Admin and profile

Pages per [`08-ACCOUNT-ADMIN.md`](08-ACCOUNT-ADMIN.md); Trash with a table of name / type / deleted from / by / date /
restore.

## 9. Design — tokens (F4, D24)

The chosen design is **F4** (`design-guide/f4/board-light-F4.dc.html`); dark mode = **F3** (`board-dark-F3.dc.html`).
It replaced the earlier "Warm Editorial" look (D10). Structure and behaviour — §1–8. **Colours — our own palette
(§9.1, D30)**: 16 label colours and 12 group colours, vivid and saturated, light and dark; data stores a key, never a
hex.

**Structure**: a shell (`--shell`) holds the sidebar (inside it, `.on-shell` maps the same tokens to light-on-green,
so the tree and forms there need no special classes — this works because Tailwind's `@theme` is `inline`); the
content is one white floating panel (`margin: 12px`, `--radius-panel`, `--shadow-panel`). Sidebar: light text on the
shell; the active item has a translucent white background. View tabs = a segmented control on `--surface-2`; the
active tab = `--primary` with white text. Primary button = `--accent` with `--on-accent`. **`--primary` versus
`--accent`**: `--primary` (dark green; in dark mode almost white) is the brand ink: active text, selection, focus, the
active tab's fill (with `--on-primary`); `--accent` (amber) is only for the main call to action and count badges.
Tailwind classes: `text-primary`, `bg-primary-soft`, `bg-accent text-on-accent` and so on. Secondary button = white
with a `--line-strong` border. Status cell = the label's tint across the whole cell (§9.1); an empty cell =
`--status-empty`. Group = a Heebo 800 heading in the group's colour (darkened towards the ink where needed for
legibility) + a bar in the group's colour next to the name (6×20, rounded) + a pill counter + a summary row at the end
(a status distribution bar with gaps between segments + a sum); there is no colour bar along the group's rows.

```css
:root {
  --shell: #0d3b35; --shell-fg: #cfe3de; --shell-muted: #8fb8ae; --shell-active: rgba(255,255,255,0.14); --shell-input: rgba(255,255,255,0.08);
  --bg: var(--shell); --surface: #ffffff; --surface-2: #f1f6f4; --surface-3: #f7faf9;
  --fg: #13221f; --heading: #0d3b35; --fg-2: #33524b; --muted: #5d756f;
  --line: #e3ece9; --line-soft: #eef3f1; --line-strong: #d5e2de;
  --primary: #0d3b35; --on-primary: #fff; --primary-soft: #e3efeb; --accent: #ffb020; --on-accent: #0d3b35; --accent-soft: #fff3dd; --accent-fg: #8a5200;
  --danger: #e0364f; --warn: #e8920c; --ok: #13a067; --info: #2f6fe0;
  --font-display: "Heebo", system-ui, sans-serif;   /* 800 — board name 30–38, group 16–19 */
  --font-body: "Rubik", system-ui, sans-serif;      /* UI 13–14 */
  --font-mono: "IBM Plex Mono", monospace;          /* ids, formulas, API */
  --row-h: 38px; --radius-sm: 7px; --radius: 12px; --radius-lg: 16px; --radius-panel: 20px;
  --shadow-panel: 0 24px 60px rgba(0,0,0,0.25); --shadow-pop: 0 12px 32px rgba(13,59,53,0.18);
}
[data-theme="dark"] {  /* F3 */
  --shell: #072420; --surface: #0f2e29; --surface-2: #163a34; --surface-3: #12332e;
  --fg: #e3efec; --heading: #f2f8f6; --fg-2: #b5cec8; --muted: #8fb0a8;
  --line: #1f453e; --line-soft: #183c36; --line-strong: #2a524b;
  --primary: #f2f8f6; --on-primary: #0d3b35; --primary-soft: #1d4a42; --accent: #ffb020; --on-accent: #0d3b35;
  --shadow-panel: 0 24px 60px rgba(0,0,0,0.45);  /* + a 1px #1d443d border on the panel */
}
```

Dark mode: follows the system, or a choice in the avatar menu (light / dark / automatic) — `lib/theme.ts`, saved per
device and applied before the first render. An avatar without a photo gets a fixed colour from the name
(`avatarColor`).

Typography: board name 30/800 display (`letter-spacing: -0.6px`), group 16/800 display, column header 12/600 muted,
cell 13 body, numbers `tabular-nums`. Status cell and label chip: a strong tint of the colour with text in its deep
shade, regular weight (400) — 4.5:1 or better for every colour, light and dark (`palettes.test.ts`). Text on a full
fill (timeline bar, battery) — `--on-c`: white at regular weight, 2.6:1 or better on every colour. **Never bold** in
data cells.

### 9.1 Our palette (D30)

The label, group and tag colours are **our own** — not another tool's palette (the test
`packages/shared/test/palette.test.ts` fails if a hue is closer than ΔE2000 6 to one of them, and
`no-foreign-palette.test.ts` fails if such a hex appears in the code outside the import input tables). The hues are
**vivid and saturated** (D30, second version — it replaced an earlier muted "earthy" palette). One source:
`PALETTE` in `packages/shared/src/colors.ts`; the same values as `--c-<key>` in `packages/ui/src/tokens.css` (a test
checks they are equal). White text on any fill is ≥2.6:1; in dark mode the fill is the same, and only a colour that
would sink into the dark background (under 3:1 against the dark `--surface`) was lightened slightly — in every colour
theme (`palettes.test.ts`).

| Key         | Light     | Dark      | Name (en / he)                      |
| ----------- | --------- | --------- | ----------------------------------- |
| `forest`    | `#05b347` | `#05b347` | Green / ירוק — "Done"               |
| `yellow`    | `#f58000` | `#f58000` | Amber / ענבר — "In progress"        |
| `crimson`   | `#ff1a35` | `#ff1a35` | Red / אדום — "Blocked"              |
| `turquoise` | `#00a5e0` | `#00a5e0` | Turquoise / טורקיז                  |
| `navy`      | `#4040e8` | `#7464d4` | Indigo / אינדיגו                    |
| `purple`    | `#8a3ffc` | `#824fff` | Purple / סגול                       |
| `green`     | `#6eaa0e` | `#6eaa0e` | Lime / ליים                         |
| `orange`    | `#eb4600` | `#eb4600` | Coral / אלמוג                       |
| `blue`      | `#1a5cf0` | `#4268f4` | Blue / כחול                         |
| `pink`      | `#e5309a` | `#e5309a` | Pink / ורוד                         |
| `gold`      | `#db8b00` | `#db8b00` | Gold / זהב (labels only)            |
| `gray`      | `#7b8db0` | `#7b8db0` | Gray / אפור                         |
| `violet`    | `#a000d6` | `#bc1cea` | Violet / סיגלית                     |
| `sage`      | `#05b382` | `#05b382` | Mint / מנטה (labels only)           |
| `slate`     | `#00abc2` | `#00abc2` | Sky / תכלת (labels only)            |
| `plum`      | `#c2006a` | `#d23476` | Berry / פטל (labels only)           |

- **Labels (status, conditional colouring)**: the 16 keys (`STATUS_COLORS`). A key is stored; an old hex (old data,
  an old API client, an import, a value of the earlier palette) is read as a key (`normalizeLabelColor`,
  `labelColorSchema`, `EARTHY_PALETTE_HEX`). Migration `0080_own_palette` converted stored data. The keys `brown` and
  `olive` of the earlier palette are read as `gold` (`RENAMED_COLOR_KEYS`) — no data migration needed.
- **Groups and tags**: 12 of the palette (`GROUP_PALETTE`), in the order a new group gets a colour: `forest`,
  `yellow`, `turquoise`, `crimson`, `navy`, `purple`, `green`, `orange`, `blue`, `pink`, `violet`, `gray`. The 19 enum
  keys remain; 7 "retired" ones (`lime`, `red`, `light_gray`, `azure`, `orange_red`, `salmon`, `brown`) are shown as a
  palette colour (`RETIRED_GROUP_COLOR_KEYS`; `brown` → `gold`). Support tags store a hex — migration
  `0081_vivid_palette` moved the earlier palette's values to the vivid ones.
- **Default status column**: In progress (`yellow`) / Done (`forest`) / Blocked (`crimson`); in Hebrew בתהליך / הושלם
  / חסום. Empty = `--status-empty` (ours).
- **Look**: a status cell = **a strong tint of the label colour across the whole cell**, the text in the deep shade of
  the same colour, centred, regular weight (`StatusCell` in `cells/index.tsx`; `--c-<key>-soft` / `--c-<key>-ink` from
  `labelSoft` / `labelInk`). Everywhere else (status picker, card, calendar, kanban, filter, My Work, activity log,
  mirror, settings) — **exactly the same chip**: the class `.label-tag` (`apps/web/src/app/styles.css`) or `LabelTag`
  (`apps/web/src/lib/label-color.tsx`). **Editing labels**: each label is edited as a chip — the name field is the chip
  itself, in the table's tint and ink — and the colour button and colour picker (`ColorGrid look="label"`,
  `LabelSwatch`) show the tint that will really appear in the cell, not the vivid colour. The vivid colour (`fill`,
  `--c-<key>`) stays for battery and summary bars, timeline bars, groups and tags. Group: name in the group's colour +
  a bar in its colour next to the name. **Tint strength**: light 60% colour on white and the text 28% of it on black;
  dark 56% on the surface and the text 12% on white (`LABEL_TINT` in `colors.ts`). All 40 colours stay above 4.5:1 in
  both modes (checked in `palettes.test.ts`).
- **Painting**: `paint(key)` → `var(--c-<key>)` (follows dark mode); `colorHex(key, mode)` when a real hex is needed
  (export, server).
- **Words**: "Table" / "טבלה" for the main view; "In progress" / "בתהליך", "Blocked" / "חסום".

## 10. RTL

`<html dir="rtl" lang="he">`; logical CSS only (`margin-inline-start`, `inset-inline-end`); directional icons flip;
the grid: the name column first on the start side, the group bar on the start side; numbers / dates / ids
`direction: ltr; unicode-bidi: isolate` inside the cell; `lang=en` is supported on every screen (i18n in
`packages/shared/src/i18n/{he,en}.json`).

## 11. Components

The design system lives in `packages/ui` (`Button`, `Input`, `Field`, `Card`, `Notice`, `Badge`, `Spinner`, `Dialog`,
`Switch`, `Segmented`, `RadioCard`, `Tabs`, `EmptyState`, `Skeleton`, `Menu` / `MenuTrigger` / `useActionMenu`,
`Picker`, `TimeField`, `Calendar`, `Avatar`, `SearchField`, `TooltipHost`, tokens and the layers scale); app-level
components such as the virtual grid, the rich text editor (TipTap), cells, colour pickers, battery and timeline bars
live in `apps/web/src`.

## 12. Accessibility and performance

Full keyboard navigation in the grid (roving tabindex, `aria-rowindex` / `aria-colindex`), `focus-visible`, aria labels
for cells ("Status: In progress"), contrast ≥ 4.5; a virtual grid for 10k rows; cursor-based queries; prefetching the
item card on hover; `prefers-reduced-motion`.

Fixed accessibility rules (Israeli Standard 5568 / WCAG 2.1 AA, plus the WCAG 2.2 target size):

- **Field and switch borders** — `--control-line` (= `--mark-off`, 3:1 against the background in every colour theme):
  `Input`, `Select`, `Switch` when off, and every `<input>/<textarea>/<select>` with `border-line-strong` (a rule in
  styles.css). Cards and lines stay `--line-strong`.
- **Minimum text** 11px (`text-[0.6875rem]`), always in rem so it grows with "text size" and browser zoom — never px.
- **Click target** at least 24×24 (`min-h-6 min-w-6`), or 24px of spacing around it; `MenuTrigger` ("⋯") already
  complies.
- **Focus** — a `--focus-ring` on everything focusable (the default in the base layer); a component with its own style
  uses the same ring.
- **Motion** — `scrollBehavior()` from `@bines/ui` instead of `behavior: 'smooth'`; an infinite pulse
  (`animate-pulse`) stops under "reduced" and "off".
- **Accessibility statement** — in the help menu, the profile menu and the owner console (as long as it is published).
- **Standing check** — `e2e/a11y-scan.spec.ts`: axe with wcag2a/2aa/21a/21aa/22aa, and a reflow check at 320px width
  (= 200% zoom) without horizontal scrolling.

## 13. States

Empty (a new board: "Add your first item" + templates; a guest with nothing shared: who to ask), Loading (skeleton
rows), Error (toast + retry; 403 → "You don't have permission", 404 for a guest), Offline (a banner says changes are
not saved until the connection is back; writes are not queued).
