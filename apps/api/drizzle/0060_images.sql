-- AI images: per-image prices in the platform's AI price table (owner console → AI prices), and starting
-- rows for OpenAI's image models (data the owner edits — gpt-image bills tokens, DALL·E 3 per image by size/quality).
ALTER TABLE "ai_prices" ADD COLUMN "per_image" double precision;--> statement-breakpoint
ALTER TABLE "ai_prices" ADD COLUMN "image_prices" jsonb;--> statement-breakpoint
INSERT INTO "ai_prices" ("id", "provider", "model", "input", "output", "per_image", "image_prices", "currency") VALUES
	('01M4B1MG1PR1CE5EED0000001A', 'openai', 'gpt-image-1', 5, 40, NULL, NULL, 'USD'),
	('01M4B1MG1PR1CE5EED0000002B', 'openai', 'dall-e-3', 0, 0, 0.04, '{"1024x1024/hd":0.08,"1792x1024":0.08,"1024x1792":0.08,"1792x1024/hd":0.12,"1024x1792/hd":0.12}'::jsonb, 'USD')
ON CONFLICT ("provider", "model") DO NOTHING;
