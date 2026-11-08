ALTER TABLE "update_likes" DROP CONSTRAINT "update_likes_update_id_user_id_pk";--> statement-breakpoint
ALTER TABLE "update_likes" ADD CONSTRAINT "update_likes_update_id_user_id_reaction_pk" PRIMARY KEY("update_id","user_id","reaction");--> statement-breakpoint
ALTER TABLE "updates" ADD COLUMN "body_json" jsonb;