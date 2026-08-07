CREATE TYPE "public"."challenge_status" AS ENUM('pending', 'accepted', 'declined', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."wager_kind" AS ENUM('none', 'shards', 'card');--> statement-breakpoint
CREATE TABLE "challenges" (
	"id" serial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"challenger_id" text NOT NULL,
	"defender_id" text NOT NULL,
	"wager" "wager_kind" DEFAULT 'none' NOT NULL,
	"stake_shards" integer DEFAULT 0 NOT NULL,
	"challenger_card_id" text,
	"defender_card_id" text,
	"status" "challenge_status" DEFAULT 'pending' NOT NULL,
	"match_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_guild_id_guild_settings_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guild_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_challenger_id_users_id_fk" FOREIGN KEY ("challenger_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_defender_id_users_id_fk" FOREIGN KEY ("defender_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_challenger_card_id_cards_id_fk" FOREIGN KEY ("challenger_card_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_defender_card_id_cards_id_fk" FOREIGN KEY ("defender_card_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "challenges_defender_idx" ON "challenges" USING btree ("guild_id","defender_id","status");