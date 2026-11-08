DROP INDEX "ix_cells_column_text";--> statement-breakpoint
CREATE INDEX "ix_cells_column_text" ON "cells" USING btree ("column_id",left("text_value", 200));