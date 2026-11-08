# The built-in help center

This folder is the help center that ships with Bines OS: about a hundred articles, 24 practical guides with
step-by-step screenshots, and 21 guided tours, in Hebrew. A new installation loads it once, on its first boot
(`apps/api/src/modules/help/help.seed.ts`). After that the help center belongs to the platform owner: articles they
edit or delete are never brought back, and an installation that already had articles is left as it is.

- `HELP_SEED=false` starts with an empty help center.
- `HELP_SEED_DIR` points to another folder in the same format.

## Format

The same package the owner console imports and exports (Support → Knowledge → Import / Export):

- `articles/<locale>/<slug>.md`: front-matter (`title`, `slug`, `locale`, `category`, `tags`, `visibility`,
  `excerpt`, `publish`; guides also have `kind: guide`, `tour` and `steps`), then the article in Markdown.
- `categories.json`: the categories, matched by name on import.
- `tours.json`: the guided tours. A step's `anchor` names a `data-tour` mark in the app.
- `images/`: screenshots, as WebP.

Guide videos aren't kept in the repository, to keep it small. A guide without a video shows its steps and
screenshots. To add videos, import a package that has them from the owner console.

## Updating

Edit the Markdown here, or export the help center from the owner console and replace this folder with the export.
Run `pnpm --filter @bines/api exec vitest run test/help-seed.test.ts` to check that the package is valid. Installations
that are already running get changes by importing the package from the owner console: importing the same package
twice changes nothing, and only edited articles get a new version.

English articles can be added under `articles/en/`, with `translation_of: <hebrew-slug>` to link the two languages.
