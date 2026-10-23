CREATE TABLE "room_people" (
	"room_id" text NOT NULL,
	"user_id" text NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_people_room_id_user_id_pk" PRIMARY KEY("room_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "room_messages" ADD COLUMN "approval_id" text;--> statement-breakpoint
ALTER TABLE "room_participants" ADD COLUMN "asked_by" text;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "team_id" text;--> statement-breakpoint
ALTER TABLE "room_people" ADD CONSTRAINT "room_people_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_people" ADD CONSTRAINT "room_people_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "room_people_user_idx" ON "room_people" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rooms_team_idx" ON "rooms" USING btree ("team_id");