CREATE TYPE "public"."rarity" AS ENUM('default', 'rare', 'epic', 'legendary', 'mythic');--> statement-breakpoint
CREATE TABLE "cards" (
	"id" text PRIMARY KEY NOT NULL,
	"hero_id" text NOT NULL,
	"name" text NOT NULL,
	"rarity" "rarity" NOT NULL,
	"image_url" text,
	"rollable" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claims" (
	"id" serial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"card_id" text NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guild_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"roll_cooldown_sec" integer DEFAULT 8 NOT NULL,
	"rolls_per_hour" integer DEFAULT 20 NOT NULL,
	"claims_per_hour" integer DEFAULT 1 NOT NULL,
	"claim_window_sec" integer DEFAULT 30 NOT NULL,
	"roll_channel_id" text
);
--> statement-breakpoint
CREATE TABLE "heroes" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"role" text,
	"image_url" text
);
--> statement-breakpoint
CREATE TABLE "member_state" (
	"user_id" text NOT NULL,
	"guild_id" text NOT NULL,
	"rolls_used" integer DEFAULT 0 NOT NULL,
	"rolls_reset_at" timestamp with time zone,
	"claims_used" integer DEFAULT 0 NOT NULL,
	"claims_reset_at" timestamp with time zone,
	"last_roll_at" timestamp with time zone,
	"pity" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "member_state_user_id_guild_id_pk" PRIMARY KEY("user_id","guild_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"currency" integer DEFAULT 0 NOT NULL,
	"shards" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wishlist" (
	"user_id" text NOT NULL,
	"card_id" text NOT NULL,
	CONSTRAINT "wishlist_user_id_card_id_pk" PRIMARY KEY("user_id","card_id")
);
--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_hero_id_heroes_id_fk" FOREIGN KEY ("hero_id") REFERENCES "public"."heroes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_guild_id_guild_settings_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guild_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_state" ADD CONSTRAINT "member_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_state" ADD CONSTRAINT "member_state_guild_id_guild_settings_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guild_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wishlist" ADD CONSTRAINT "wishlist_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wishlist" ADD CONSTRAINT "wishlist_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cards_rarity_idx" ON "cards" USING btree ("rarity","rollable");--> statement-breakpoint
CREATE INDEX "cards_hero_idx" ON "cards" USING btree ("hero_id");--> statement-breakpoint
CREATE UNIQUE INDEX "claims_guild_card_uniq" ON "claims" USING btree ("guild_id","card_id");--> statement-breakpoint
CREATE INDEX "claims_owner_idx" ON "claims" USING btree ("guild_id","user_id");