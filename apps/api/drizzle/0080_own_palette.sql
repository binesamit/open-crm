-- Release E (D-PAL): our own colour palette. Label colours were stored as hex (the palette other tools
-- ship); now they are palette KEYS (packages/shared/src/colors.ts PALETTE). Each old hex → the key of the table in
-- colors.ts LEGACY_LABEL_HEX (tested to match); any other hex → the nearest palette colour (RGB distance to the
-- light and dark values). Group / tag colours were keys already: only their hex changed, nothing to move here.
-- The code still reads an old hex (an offline cache, an old event): `normalizeLabelColor` / `paint()`.
-- Numbered 0080 (not 0075) so a parallel branch may take 0075–0079 without colliding.
CREATE OR REPLACE FUNCTION pg_temp.pal_key(c jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN jsonb_typeof(c) <> 'string' OR (c #>> '{}') !~* '^#[0-9a-f]{6}$' THEN c
    ELSE coalesce(
      (SELECT to_jsonb(m.k) FROM (VALUES ('#00c875', 'forest'), ('#9cd326', 'green'), ('#cab641', 'olive'), ('#ffcb00', 'yellow'), ('#784bd1', 'purple'), ('#9d50dd', 'purple'), ('#007eb5', 'blue'), ('#579bfc', 'blue'), ('#66ccff', 'blue'), ('#bb3354', 'plum'), ('#df2f4a', 'crimson'), ('#ff007f', 'pink'), ('#ff5ac4', 'pink'), ('#ff642e', 'orange'), ('#fdab3d', 'yellow'), ('#7f5347', 'brown'), ('#c4c4c4', 'gray'), ('#757575', 'gray'), ('#e2445c', 'crimson'), ('#0086c0', 'blue'), ('#037f4c', 'forest'), ('#a25ddc', 'purple'), ('#225091', 'navy'), ('#4eccc6', 'turquoise'), ('#a9bee8', 'slate'), ('#ff7575', 'pink'), ('#e484bd', 'plum'), ('#cd9282', 'crimson'), ('#9aadbd', 'slate'), ('#7e3b8a', 'purple'), ('#3d4f5e', 'slate'), ('#ad967a', 'brown'), ('#2b76e5', 'blue'), ('#175a63', 'turquoise'), ('#563e3e', 'brown'), ('#68a1bd', 'blue'), ('#8bc34a', 'green'), ('#f9c449', 'yellow'), ('#4a4a4a', 'gray'), ('#ffadad', 'pink'), ('#ff158a', 'pink'), ('#808080', 'gray'), ('#0073ea', 'blue')) AS m(h, k)
        WHERE m.h = lower(c #>> '{}')),
      (SELECT to_jsonb(a.k) FROM (VALUES ('forest', '#2e6b57'), ('forest', '#6fbf9f'), ('yellow', '#9a6a0b'), ('yellow', '#d9a24a'), ('crimson', '#a3413f'), ('crimson', '#db7f6a'), ('turquoise', '#21727a'), ('turquoise', '#7cb8b3'), ('navy', '#3d4677'), ('navy', '#9d9be6'), ('purple', '#655080'), ('purple', '#bf9fd4'), ('green', '#5b7d33'), ('green', '#b3c98a'), ('orange', '#b0592b'), ('orange', '#eb9a69'), ('blue', '#3a6488'), ('blue', '#8ab8e0'), ('pink', '#a8566e'), ('pink', '#e3a1b4'), ('brown', '#83674a'), ('brown', '#cdb08e'), ('gray', '#6e6a5e'), ('gray', '#b8b3a6'), ('olive', '#77702c'), ('olive', '#c8c07a'), ('sage', '#557a6d'), ('sage', '#a2c4b6'), ('slate', '#4f5f80'), ('slate', '#a0aac8'), ('plum', '#8a3d5c'), ('plum', '#c97f9b')) AS a(k, h)
        ORDER BY (('x' || substr(a.h, 2, 2))::bit(8)::int - ('x' || substr(c #>> '{}', 2, 2))::bit(8)::int) ^ 2
               + (('x' || substr(a.h, 4, 2))::bit(8)::int - ('x' || substr(c #>> '{}', 4, 2))::bit(8)::int) ^ 2
               + (('x' || substr(a.h, 6, 2))::bit(8)::int - ('x' || substr(c #>> '{}', 6, 2))::bit(8)::int) ^ 2
        LIMIT 1))
  END
$$;--> statement-breakpoint
-- An array of objects with a `color` (status labels, colouring rules) → the same with palette keys.
CREATE OR REPLACE FUNCTION pg_temp.pal_list(l jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(l) <> 'array' THEN l ELSE (
    SELECT coalesce(jsonb_agg(CASE WHEN jsonb_typeof(e) = 'object' AND e ? 'color'
      THEN jsonb_set(e, '{color}', pg_temp.pal_key(e->'color')) ELSE e END ORDER BY o), '[]'::jsonb)
    FROM jsonb_array_elements(l) WITH ORDINALITY AS t(e, o)) END
$$;--> statement-breakpoint
-- A template snapshot's columns (and subitem columns): each column's labels.
CREATE OR REPLACE FUNCTION pg_temp.pal_columns(l jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(l) <> 'array' THEN l ELSE (
    SELECT coalesce(jsonb_agg(CASE WHEN jsonb_typeof(e->'settings'->'labels') = 'array'
      THEN jsonb_set(e, '{settings,labels}', pg_temp.pal_list(e->'settings'->'labels')) ELSE e END ORDER BY o), '[]'::jsonb)
    FROM jsonb_array_elements(l) WITH ORDINALITY AS t(e, o)) END
$$;--> statement-breakpoint
-- Status labels of every column.
UPDATE "columns" SET "settings" = jsonb_set("settings", '{labels}', pg_temp.pal_list("settings"->'labels'))
  WHERE jsonb_typeof("settings"->'labels') = 'array' AND "settings"::text ~* '"color": ?"#[0-9a-f]{6}"';--> statement-breakpoint
-- Conditional colouring rules of views and of people's unsaved view changes.
UPDATE "views" SET "settings" = jsonb_set("settings", '{coloring}', pg_temp.pal_list("settings"->'coloring'))
  WHERE jsonb_typeof("settings"->'coloring') = 'array' AND "settings"::text ~* '"color": ?"#[0-9a-f]{6}"';--> statement-breakpoint
UPDATE "user_view_prefs" SET "settings" = jsonb_set("settings", '{coloring}', pg_temp.pal_list("settings"->'coloring'))
  WHERE jsonb_typeof("settings"->'coloring') = 'array' AND "settings"::text ~* '"color": ?"#[0-9a-f]{6}"';--> statement-breakpoint
-- The account's default status labels (08 §2 defaults.status_labels).
UPDATE "account_settings" SET "settings" = jsonb_set("settings", '{defaults,status_labels}', pg_temp.pal_list("settings"->'defaults'->'status_labels'))
  WHERE jsonb_typeof("settings"->'defaults'->'status_labels') = 'array';--> statement-breakpoint
-- An account that saved its settings holds the old built-in default trio as is: it becomes our default (in progress /
-- done / blocked). Defaults an admin changed are kept.
UPDATE "account_settings" SET "settings" = jsonb_set("settings", '{defaults,status_labels}', '[{"label": "בתהליך", "color": "yellow"}, {"label": "הושלם", "color": "forest", "is_done": true}, {"label": "חסום", "color": "crimson"}]'::jsonb)
  WHERE "settings"->'defaults'->'status_labels' = '[{"label": "בעבודה", "color": "yellow"}, {"label": "הושלם", "color": "forest", "is_done": true}, {"label": "תקוע", "color": "crimson"}]'::jsonb;--> statement-breakpoint
-- Saved templates (a board's snapshot): column labels.
UPDATE "templates" SET "snapshot" = jsonb_set(
    jsonb_set("snapshot", '{columns}', pg_temp.pal_columns(coalesce("snapshot"->'columns', '[]'::jsonb))),
    '{subitem_columns}', pg_temp.pal_columns(coalesce("snapshot"->'subitem_columns', '[]'::jsonb)))
  WHERE "snapshot"::text ~* '"color": ?"#[0-9a-f]{6}"';--> statement-breakpoint
-- Support console tags store a hex: an old palette hex → our colour's hex (light).
UPDATE "support_tags" t SET "color" = p.h
  FROM (VALUES ('forest', '#2e6b57'), ('yellow', '#9a6a0b'), ('crimson', '#a3413f'), ('turquoise', '#21727a'), ('navy', '#3d4677'), ('purple', '#655080'), ('green', '#5b7d33'), ('orange', '#b0592b'), ('blue', '#3a6488'), ('pink', '#a8566e'), ('brown', '#83674a'), ('gray', '#6e6a5e'), ('olive', '#77702c'), ('sage', '#557a6d'), ('slate', '#4f5f80'), ('plum', '#8a3d5c')) AS p(k, h)
  WHERE t."color" ~* '^#[0-9a-f]{6}$' AND p.k = pg_temp.pal_key(to_jsonb(t."color")) #>> '{}' AND lower(t."color") <> p.h;--> statement-breakpoint
-- The board's system view keeps the default name we gave it → our word ("Table" / "טבלה").
UPDATE "views" SET "name" = 'טבלה' WHERE "is_system" AND "name" = 'טבלה ראשית';--> statement-breakpoint
UPDATE "views" SET "name" = 'Table' WHERE "is_system" AND "name" = 'Main table';
