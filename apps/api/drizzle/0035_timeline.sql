-- M8 ד7: dependency links carry their kind (FS / SS / FF / SF) and lag in days (03 §3.2). Relations keep '{}'.
ALTER TABLE "item_links" ADD COLUMN "meta" jsonb DEFAULT '{}'::jsonb NOT NULL;
