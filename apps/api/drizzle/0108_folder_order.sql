-- Prod (product owner: "drag folders like everything else, and put one between boards — not always at the top")
-- a folder now stands in the same order as the boards, docs and dashboards of its parent (or the root). Until now the
-- sidebar listed the folders first, each kind numbered on its own, so the numbers overlap. This renumbers everything
-- of every parent so the sidebar shows exactly what it showed: the folders first (in their order), then the rest (in
-- theirs). Keys: `0|` + five base-36 digits + `i` (fixed width, so text order = number order; never ending in `0`).
CREATE TABLE "_folder_order_0108" AS
WITH "rows" AS (
  SELECT 'f' AS "t", "id", "workspace_id" AS "ws", "parent_folder_id" AS "parent", 0 AS "grp", "position" FROM "folders"
  UNION ALL
  SELECT 'b', "id", "workspace_id", "folder_id", 1, "position" FROM "boards" WHERE "parent_board_id" IS NULL
  UNION ALL
  SELECT 'd', "id", "workspace_id", "folder_id", 1, "position" FROM "docs"
  UNION ALL
  SELECT 's', "id", "workspace_id", "folder_id", 1, "position" FROM "dashboards"
)
SELECT "t", "id",
  row_number() OVER (PARTITION BY "ws", "parent" ORDER BY "grp", "position" COLLATE "C", "id") AS "n"
FROM "rows";
--> statement-breakpoint
ALTER TABLE "_folder_order_0108" ADD COLUMN "key" text;
--> statement-breakpoint
UPDATE "_folder_order_0108" SET "key" = '0|'
  || substr('0123456789abcdefghijklmnopqrstuvwxyz', ("n" / 1679616 % 36)::int + 1, 1)
  || substr('0123456789abcdefghijklmnopqrstuvwxyz', ("n" / 46656 % 36)::int + 1, 1)
  || substr('0123456789abcdefghijklmnopqrstuvwxyz', ("n" / 1296 % 36)::int + 1, 1)
  || substr('0123456789abcdefghijklmnopqrstuvwxyz', ("n" / 36 % 36)::int + 1, 1)
  || substr('0123456789abcdefghijklmnopqrstuvwxyz', ("n" % 36)::int + 1, 1)
  || 'i';
--> statement-breakpoint
UPDATE "folders" SET "position" = o."key" FROM "_folder_order_0108" o WHERE o."t" = 'f' AND o."id" = "folders"."id";
--> statement-breakpoint
UPDATE "boards" SET "position" = o."key" FROM "_folder_order_0108" o WHERE o."t" = 'b' AND o."id" = "boards"."id";
--> statement-breakpoint
UPDATE "docs" SET "position" = o."key" FROM "_folder_order_0108" o WHERE o."t" = 'd' AND o."id" = "docs"."id";
--> statement-breakpoint
UPDATE "dashboards" SET "position" = o."key" FROM "_folder_order_0108" o WHERE o."t" = 's' AND o."id" = "dashboards"."id";
--> statement-breakpoint
DROP TABLE "_folder_order_0108";
