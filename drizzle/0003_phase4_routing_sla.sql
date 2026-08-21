CREATE TYPE "public"."agent_availability" AS ENUM('online', 'away', 'offline');--> statement-breakpoint
CREATE TYPE "public"."sla_target_kind" AS ENUM('first_response', 'resolution');--> statement-breakpoint
CREATE TYPE "public"."escalation_action" AS ENUM('notify', 'reassign', 'notify_and_reassign');--> statement-breakpoint
CREATE TABLE "business_hours" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"timezone" text DEFAULT 'Africa/Harare' NOT NULL,
	"weekly" jsonb NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_hours_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "holidays" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_hours_id" uuid NOT NULL,
	"observed_on" date NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "holidays_calendar_date_unique" UNIQUE("business_hours_id","observed_on")
);
--> statement-breakpoint
CREATE TABLE "sla_breaches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"target_id" uuid,
	"kind" "sla_target_kind" NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"breached_at" timestamp with time zone NOT NULL,
	"minutes_overdue" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sla_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"priority" "ticket_priority" NOT NULL,
	"first_response_minutes" integer NOT NULL,
	"resolution_minutes" integer NOT NULL,
	"business_hours_id" uuid NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sla_policies_product_priority_unique" UNIQUE("product_id","priority")
);
--> statement-breakpoint
CREATE TABLE "ticket_sla_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"policy_id" uuid,
	"kind" "sla_target_kind" NOT NULL,
	"target_minutes" integer NOT NULL,
	"business_hours_id" uuid,
	"started_at" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"paused_at" timestamp with time zone,
	"paused_minutes" integer DEFAULT 0 NOT NULL,
	"satisfied_at" timestamp with time zone,
	"breached_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_sla_targets_ticket_kind_unique" UNIQUE("ticket_id","kind")
);
--> statement-breakpoint
CREATE TABLE "agent_skills" (
	"user_id" uuid NOT NULL,
	"skill" text NOT NULL,
	"proficiency" integer DEFAULT 3 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_skills_user_id_skill_pk" PRIMARY KEY("user_id","skill")
);
--> statement-breakpoint
CREATE TABLE "routing_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"product_id" uuid,
	"category_id" uuid,
	"priority" "ticket_priority",
	"channel" "ticket_channel",
	"customer_tier" "customer_tier",
	"language" text,
	"required_skill" text,
	"assign_to_team_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "escalation_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"product_id" uuid,
	"priority" "ticket_priority",
	"target_kind" "sla_target_kind",
	"threshold_percent" integer NOT NULL,
	"action" "escalation_action" NOT NULL,
	"notify_user_id" uuid,
	"notify_team_id" uuid,
	"reassign_to_user_id" uuid,
	"reassign_to_team_id" uuid,
	"raise_priority" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "escalations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"rule_id" uuid,
	"target_id" uuid,
	"threshold_percent" integer NOT NULL,
	"action" "escalation_action" NOT NULL,
	"from_user_id" uuid,
	"to_user_id" uuid,
	"reason" text NOT NULL,
	"triggered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "escalations_rule_target_unique" UNIQUE("ticket_id","rule_id","target_id")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "availability" "agent_availability" DEFAULT 'offline' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "max_open_tickets" integer;--> statement-breakpoint
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_business_hours_id_business_hours_id_fk" FOREIGN KEY ("business_hours_id") REFERENCES "public"."business_hours"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_breaches" ADD CONSTRAINT "sla_breaches_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_breaches" ADD CONSTRAINT "sla_breaches_target_id_ticket_sla_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."ticket_sla_targets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_policies" ADD CONSTRAINT "sla_policies_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_policies" ADD CONSTRAINT "sla_policies_business_hours_id_business_hours_id_fk" FOREIGN KEY ("business_hours_id") REFERENCES "public"."business_hours"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_sla_targets" ADD CONSTRAINT "ticket_sla_targets_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_sla_targets" ADD CONSTRAINT "ticket_sla_targets_policy_id_sla_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."sla_policies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_sla_targets" ADD CONSTRAINT "ticket_sla_targets_business_hours_id_business_hours_id_fk" FOREIGN KEY ("business_hours_id") REFERENCES "public"."business_hours"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_rules" ADD CONSTRAINT "routing_rules_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_rules" ADD CONSTRAINT "routing_rules_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_rules" ADD CONSTRAINT "routing_rules_assign_to_team_id_teams_id_fk" FOREIGN KEY ("assign_to_team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalation_rules" ADD CONSTRAINT "escalation_rules_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalation_rules" ADD CONSTRAINT "escalation_rules_notify_user_id_users_id_fk" FOREIGN KEY ("notify_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalation_rules" ADD CONSTRAINT "escalation_rules_notify_team_id_teams_id_fk" FOREIGN KEY ("notify_team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalation_rules" ADD CONSTRAINT "escalation_rules_reassign_to_user_id_users_id_fk" FOREIGN KEY ("reassign_to_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalation_rules" ADD CONSTRAINT "escalation_rules_reassign_to_team_id_teams_id_fk" FOREIGN KEY ("reassign_to_team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_rule_id_escalation_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."escalation_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_target_id_ticket_sla_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."ticket_sla_targets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_from_user_id_users_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_to_user_id_users_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "holidays_calendar_idx" ON "holidays" USING btree ("business_hours_id","observed_on");--> statement-breakpoint
CREATE INDEX "sla_breaches_ticket_idx" ON "sla_breaches" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "sla_breaches_breached_idx" ON "sla_breaches" USING btree ("breached_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "sla_policies_product_idx" ON "sla_policies" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "ticket_sla_targets_due_idx" ON "ticket_sla_targets" USING btree ("due_at") WHERE satisfied_at is null and breached_at is null and paused_at is null;--> statement-breakpoint
CREATE INDEX "ticket_sla_targets_ticket_idx" ON "ticket_sla_targets" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "agent_skills_skill_idx" ON "agent_skills" USING btree ("skill");--> statement-breakpoint
CREATE INDEX "routing_rules_evaluation_idx" ON "routing_rules" USING btree ("is_active","sort_order");--> statement-breakpoint
CREATE INDEX "routing_rules_product_idx" ON "routing_rules" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "escalation_rules_evaluation_idx" ON "escalation_rules" USING btree ("is_active","sort_order");--> statement-breakpoint
CREATE INDEX "escalation_rules_product_idx" ON "escalation_rules" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "escalations_ticket_idx" ON "escalations" USING btree ("ticket_id","triggered_at" DESC NULLS LAST);