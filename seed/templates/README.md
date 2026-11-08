# seed/templates
One JSON per built-in board template (generic sample boards), in the native template format (`format_version: 2`,
read by `apps/api/src/modules/boards/templates.ts#templateSnapshotSchema`).

Fields: `key`, `format_version` (2), `name`, `description`, `board_kind` (public→main, share→shareable, private),
`folder`, `hierarchy_type`, `hierarchy_depth_max` (1 = no subitems, 2 = subitems, more = deeper levels),
`item_terminology`, `groups[]` (`id`, `title`, `color` = a group palette key), `columns[]` and `add_columns[]`
(`id` = the column key, `title`, `type` = a column type key of the registry in `packages/shared/src/columns`,
`description`, `settings` = that type's settings as its `settingsSchema` reads them, label colours as palette keys),
`permissions{set, restrict_column_editing, restrict_column_view}`, `views[]`.

Column and group ids are kept from version to version: boards made from a template are matched to it by them.
A built-in template's columns are new columns: the account's defaults for new columns fill what `settings` leaves
out. A relation column names its target boards in `settings.board_refs` (`@<template key>`, or a template's
`existing_board_id`); a starter kit resolves them once all its boards exist.

`pnpm db:seed` (and every API boot) upserts these templates by key.
`portal-client.json` and `project-multilevel.json` are templates meant to be instantiated per client / per big project.
