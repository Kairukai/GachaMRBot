CREATE TABLE "burns" (
	"id" serial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"target_card_id" text NOT NULL,
	"from_rank" integer NOT NULL,
	"to_rank" integer NOT NULL,
	"fodder_card_ids" text[] NOT NULL,
	"fodder_points" integer NOT NULL,
	"shards_spent" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "rank" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "burns" ADD CONSTRAINT "burns_guild_id_guild_settings_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guild_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "burns" ADD CONSTRAINT "burns_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "burns_user_idx" ON "burns" USING btree ("guild_id","user_id","created_at");--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_rank_range" CHECK ("claims"."rank" BETWEEN 1 AND 10);