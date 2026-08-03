ALTER TABLE "guild_settings" ALTER COLUMN "claims_per_hour" SET DEFAULT 2;--> statement-breakpoint
-- Changing the default only affects new servers. Bring existing ones along too,
-- but only those still on the old default — a server that deliberately set
-- something else keeps it.
UPDATE "guild_settings" SET "claims_per_hour" = 2 WHERE "claims_per_hour" = 1;
