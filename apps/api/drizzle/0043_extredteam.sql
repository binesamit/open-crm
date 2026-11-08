-- Extensions red team (EXT-RT16): an extension server token remembers the narrower scope it was asked for.
ALTER TABLE "extension_server_tokens" ADD COLUMN "scopes" jsonb;
