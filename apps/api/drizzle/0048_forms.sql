-- M11 public forms: a submission keeps a keyed hash of the client address (never the address) and a short
-- user-agent summary, for counting and abuse review.
ALTER TABLE "form_submissions" ADD COLUMN "ip_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "form_submissions" ADD COLUMN "user_agent" varchar(120);
