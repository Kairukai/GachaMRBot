CREATE TABLE "matches" (
	"id" serial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"challenger_id" text NOT NULL,
	"defender_id" text NOT NULL,
	"challenger_cards" text[] NOT NULL,
	"defender_cards" text[] NOT NULL,
	"seed" integer NOT NULL,
	"winner_id" text NOT NULL,
	"rounds" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_slots" (
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"slot" integer NOT NULL,
	"card_id" text NOT NULL,
	"role" text NOT NULL,
	CONSTRAINT "team_slots_guild_id_user_id_slot_pk" PRIMARY KEY("guild_id","user_id","slot"),
	CONSTRAINT "team_slots_slot_range" CHECK ("team_slots"."slot" BETWEEN 1 AND 6)
);
--> statement-breakpoint
ALTER TABLE "guild_settings" ADD COLUMN "battles_per_hour" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "member_state" ADD COLUMN "battles_used" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "member_state" ADD COLUMN "battles_reset_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_guild_id_guild_settings_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guild_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_challenger_id_users_id_fk" FOREIGN KEY ("challenger_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_defender_id_users_id_fk" FOREIGN KEY ("defender_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_slots" ADD CONSTRAINT "team_slots_guild_id_guild_settings_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guild_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_slots" ADD CONSTRAINT "team_slots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_slots" ADD CONSTRAINT "team_slots_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "matches_guild_idx" ON "matches" USING btree ("guild_id","created_at");--> statement-breakpoint
CREATE INDEX "matches_challenger_idx" ON "matches" USING btree ("guild_id","challenger_id");--> statement-breakpoint
CREATE INDEX "matches_defender_idx" ON "matches" USING btree ("guild_id","defender_id");