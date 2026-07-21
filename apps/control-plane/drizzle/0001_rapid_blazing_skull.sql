CREATE TABLE "attention_events" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"host_id" text NOT NULL,
	"session_ref" text NOT NULL,
	"kind" text NOT NULL,
	"summary" text NOT NULL,
	"question" text,
	"options" jsonb,
	"urgency" text NOT NULL,
	"acked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attention_events" ADD CONSTRAINT "attention_events_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attention_events" ADD CONSTRAINT "attention_events_host_id_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."hosts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attention_events_org_created_idx" ON "attention_events" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "attention_events_org_acked_idx" ON "attention_events" USING btree ("org_id","acked_at");