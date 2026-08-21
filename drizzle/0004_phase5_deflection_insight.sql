--
-- An IMMUTABLE way to fold a keyword array into searchable text.
--
-- `array_to_string` is declared STABLE, not IMMUTABLE, so Postgres refuses it in
-- the generated `search_vector` column below. It is marked STABLE because it is
-- polymorphic: for an arbitrary element type, the element's output function may
-- itself be stable.
--
-- This wrapper is monomorphic on `text[]`, and `text`'s output function is
-- immutable, so the declaration below is a narrowing of a genuinely immutable
-- case rather than a lie about volatility. Narrowing the signature is the point —
-- an `anyarray` version of this function would be unsound.
--
CREATE OR REPLACE FUNCTION kb_keywords_text(text[]) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT array_to_string($1, ' ') $$;
--> statement-breakpoint
CREATE TYPE "public"."kb_article_status" AS ENUM('draft', 'in_review', 'published', 'archived');--> statement-breakpoint
CREATE TYPE "public"."kb_article_visibility" AS ENUM('internal', 'public');--> statement-breakpoint
CREATE TYPE "public"."kb_view_source" AS ENUM('search', 'suggest', 'direct');--> statement-breakpoint
CREATE TABLE "kb_article_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"article_id" uuid NOT NULL,
	"helpful" boolean NOT NULL,
	"comment" text,
	"user_id" uuid,
	"customer_id" uuid,
	"ticket_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kb_article_feedback_user_unique" UNIQUE("article_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "kb_article_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"article_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"body" text NOT NULL,
	"keywords" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" "kb_article_status" NOT NULL,
	"visibility" "kb_article_visibility" NOT NULL,
	"edited_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kb_article_revisions_version_unique" UNIQUE("article_id","version")
);
--> statement-breakpoint
CREATE TABLE "kb_articles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"product_id" uuid,
	"category_id" uuid,
	"title" text NOT NULL,
	"summary" text,
	"body" text NOT NULL,
	"keywords" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" "kb_article_status" DEFAULT 'draft' NOT NULL,
	"visibility" "kb_article_visibility" DEFAULT 'internal' NOT NULL,
	"author_user_id" uuid,
	"last_edited_by_user_id" uuid,
	"published_at" timestamp with time zone,
	"published_by_user_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"view_count" integer DEFAULT 0 NOT NULL,
	"helpful_count" integer DEFAULT 0 NOT NULL,
	"not_helpful_count" integer DEFAULT 0 NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce("kb_articles"."title", '')), 'A') || setweight(to_tsvector('english', coalesce(kb_keywords_text("kb_articles"."keywords"), '')), 'B') || setweight(to_tsvector('english', coalesce("kb_articles"."summary", '')), 'B') || setweight(to_tsvector('english', coalesce("kb_articles"."body", '')), 'C')) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kb_articles_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "kb_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"article_id" uuid NOT NULL,
	"source" "kb_view_source" NOT NULL,
	"user_id" uuid,
	"customer_id" uuid,
	"ticket_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "csat_surveys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"rated_user_id" uuid,
	"rated_team_id" uuid,
	"token_hash" text NOT NULL,
	"sent_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"score" integer,
	"comment" text,
	"responded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "csat_surveys_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "csat_surveys_ticket_unique" UNIQUE("ticket_id")
);
--> statement-breakpoint
CREATE TABLE "report_refreshes" (
	"view_name" text PRIMARY KEY NOT NULL,
	"refreshed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"duration_ms" integer NOT NULL,
	"row_count" integer NOT NULL,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "anonymised_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "email_digest" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "kb_article_feedback" ADD CONSTRAINT "kb_article_feedback_article_id_kb_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."kb_articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_article_feedback" ADD CONSTRAINT "kb_article_feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_article_feedback" ADD CONSTRAINT "kb_article_feedback_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_article_feedback" ADD CONSTRAINT "kb_article_feedback_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_article_revisions" ADD CONSTRAINT "kb_article_revisions_article_id_kb_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."kb_articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_article_revisions" ADD CONSTRAINT "kb_article_revisions_edited_by_user_id_users_id_fk" FOREIGN KEY ("edited_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_articles" ADD CONSTRAINT "kb_articles_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_articles" ADD CONSTRAINT "kb_articles_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_articles" ADD CONSTRAINT "kb_articles_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_articles" ADD CONSTRAINT "kb_articles_last_edited_by_user_id_users_id_fk" FOREIGN KEY ("last_edited_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_articles" ADD CONSTRAINT "kb_articles_published_by_user_id_users_id_fk" FOREIGN KEY ("published_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_views" ADD CONSTRAINT "kb_views_article_id_kb_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."kb_articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_views" ADD CONSTRAINT "kb_views_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_views" ADD CONSTRAINT "kb_views_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_views" ADD CONSTRAINT "kb_views_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "csat_surveys" ADD CONSTRAINT "csat_surveys_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "csat_surveys" ADD CONSTRAINT "csat_surveys_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "csat_surveys" ADD CONSTRAINT "csat_surveys_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "csat_surveys" ADD CONSTRAINT "csat_surveys_rated_user_id_users_id_fk" FOREIGN KEY ("rated_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "csat_surveys" ADD CONSTRAINT "csat_surveys_rated_team_id_teams_id_fk" FOREIGN KEY ("rated_team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kb_article_feedback_article_idx" ON "kb_article_feedback" USING btree ("article_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "kb_article_revisions_article_idx" ON "kb_article_revisions" USING btree ("article_id","version" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "kb_articles_search_idx" ON "kb_articles" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "kb_articles_product_status_idx" ON "kb_articles" USING btree ("product_id","status");--> statement-breakpoint
CREATE INDEX "kb_articles_status_published_idx" ON "kb_articles" USING btree ("status","published_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "kb_articles_category_idx" ON "kb_articles" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "kb_views_article_idx" ON "kb_views" USING btree ("article_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "kb_views_created_idx" ON "kb_views" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "csat_surveys_product_idx" ON "csat_surveys" USING btree ("product_id","responded_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "csat_surveys_agent_idx" ON "csat_surveys" USING btree ("rated_user_id","responded_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "csat_surveys_customer_idx" ON "csat_surveys" USING btree ("customer_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "tickets_retention_idx" ON "tickets" USING btree ("resolved_at") WHERE anonymised_at is null and resolved_at is not null;
--> statement-breakpoint
--
-- Reporting views.
--
-- Hand-written, and declared `.existing()` in src/modules/report/report.model.ts
-- so drizzle-kit leaves them alone. Every one is an aggregate with `filter`
-- clauses, interval arithmetic and — for the agent view — a full outer join
-- across two different grains, none of which the query builder expresses. A
-- reviewer should read the SQL that runs rather than infer it from a chain.
--
-- Two invariants hold across all six, and both are load-bearing:
--
--   * They bucket by **local** calendar day in Africa/Harare, baked in as a
--     literal. Postgres cannot use a runtime setting in a materialised view
--     without making the result depend on whoever refreshed it. Changing
--     DEFAULT_TIMEZONE therefore needs a migration to match — the same
--     constraint the knowledge base's text-search configuration carries.
--     Bucketing by UTC instead would file every evening's tickets after 22:00
--     under the previous day.
--
--   * Every grouping key column is NOT NULL and covered by a unique index.
--     `refresh materialized view concurrently` requires a unique index, and a
--     nullable key makes its row diffing unreliable. That is why per-category and
--     per-agent figures are separate views rather than extra nullable dimensions
--     on one wide one.
--
-- Durations are wall clock. A materialised view cannot call the SLA clock, so
-- anything that has to answer to a service level comes from report_sla_daily,
-- which reads the targets the clock itself wrote.
--

CREATE MATERIALIZED VIEW "report_ticket_daily" AS
SELECT
  (t.created_at AT TIME ZONE 'Africa/Harare')::date          AS day,
  t.product_id,
  t.channel,
  t.priority,
  count(*)::int                                              AS created_count,
  count(*) FILTER (WHERE t.first_response_at IS NOT NULL)::int AS answered_count,
  count(*) FILTER (WHERE t.resolved_at IS NOT NULL)::int      AS resolved_count,
  coalesce(sum(t.reopened_count), 0)::int                     AS reopened_count,
  round(avg(extract(epoch FROM (t.first_response_at - t.created_at)) / 60.0)
    FILTER (WHERE t.first_response_at IS NOT NULL))::int      AS first_response_wall_minutes_avg,
  round(avg(extract(epoch FROM (t.resolved_at - t.created_at)) / 60.0)
    FILTER (WHERE t.resolved_at IS NOT NULL))::int            AS resolution_wall_minutes_avg
FROM tickets t
WHERE t.deleted_at IS NULL
GROUP BY 1, 2, 3, 4;--> statement-breakpoint

CREATE UNIQUE INDEX "report_ticket_daily_key"
  ON "report_ticket_daily" (day, product_id, channel, priority);--> statement-breakpoint

-- Volume cut by category. Its own view because category_id is nullable on a
-- ticket, and a nullable column cannot be part of the key above.
CREATE MATERIALIZED VIEW "report_category_daily" AS
SELECT
  (t.created_at AT TIME ZONE 'Africa/Harare')::date     AS day,
  t.product_id,
  t.category_id,
  count(*)::int                                         AS created_count,
  count(*) FILTER (WHERE t.resolved_at IS NOT NULL)::int AS resolved_count
FROM tickets t
WHERE t.deleted_at IS NULL AND t.category_id IS NOT NULL
GROUP BY 1, 2, 3;--> statement-breakpoint

CREATE UNIQUE INDEX "report_category_daily_key"
  ON "report_category_daily" (day, product_id, category_id);--> statement-breakpoint

-- Service-level compliance, from the targets rather than from ticket
-- timestamps, so it is measured in working time on the business-hours calendar
-- exactly as sla.clock computed it.
--
-- Bucketed on started_at: a target belongs to the day the obligation began, not
-- the day it happened to be settled, or a breach recorded at 00:05 would land on
-- a day the ticket had nothing to do with.
CREATE MATERIALIZED VIEW "report_sla_daily" AS
SELECT
  (g.started_at AT TIME ZONE 'Africa/Harare')::date AS day,
  t.product_id,
  t.priority,
  g.kind,
  count(*)::int                                     AS targets,
  count(*) FILTER (
    WHERE g.satisfied_at IS NOT NULL AND g.breached_at IS NULL
  )::int                                            AS met,
  count(*) FILTER (WHERE g.breached_at IS NOT NULL)::int AS breached,
  count(*) FILTER (
    WHERE g.satisfied_at IS NULL AND g.breached_at IS NULL
  )::int                                            AS running
FROM ticket_sla_targets g
JOIN tickets t ON t.id = g.ticket_id
WHERE t.deleted_at IS NULL
GROUP BY 1, 2, 3, 4;--> statement-breakpoint

CREATE UNIQUE INDEX "report_sla_daily_key"
  ON "report_sla_daily" (day, product_id, priority, kind);--> statement-breakpoint

-- Agent throughput: what they said, what they finished, and what the customers
-- they finished for thought of it.
--
-- Three grains — the day of a reply, the day of a resolution, the day a survey
-- was sent — so it is a full outer join rather than one GROUP BY. Any of the
-- three can exist without the others: an agent can answer tickets all week and
-- resolve none, and that is worth seeing.
CREATE MATERIALIZED VIEW "report_agent_daily" AS
WITH replies AS (
  SELECT
    (m.created_at AT TIME ZONE 'Africa/Harare')::date        AS day,
    m.author_user_id                                        AS user_id,
    t.product_id,
    count(*) FILTER (WHERE m.visibility = 'public')::int     AS public_replies,
    count(*) FILTER (WHERE m.visibility = 'internal')::int   AS internal_notes
  FROM ticket_messages m
  JOIN tickets t ON t.id = m.ticket_id
  WHERE m.author_user_id IS NOT NULL AND t.deleted_at IS NULL
  GROUP BY 1, 2, 3
),
resolutions AS (
  SELECT
    (t.resolved_at AT TIME ZONE 'Africa/Harare')::date  AS day,
    t.assigned_to_user_id                              AS user_id,
    t.product_id,
    count(*)::int                                      AS resolved_count,
    count(*) FILTER (WHERE t.reopened_count > 0)::int   AS reopened_count,
    round(avg(extract(epoch FROM (t.resolved_at - t.created_at)) / 60.0))::int
                                                       AS resolution_wall_minutes_avg
  FROM tickets t
  WHERE t.resolved_at IS NOT NULL
    AND t.assigned_to_user_id IS NOT NULL
    AND t.deleted_at IS NULL
  GROUP BY 1, 2, 3
),
satisfaction AS (
  SELECT
    (s.created_at AT TIME ZONE 'Africa/Harare')::date AS day,
    s.rated_user_id                                   AS user_id,
    s.product_id,
    count(*)::int                                     AS surveys_sent,
    count(s.score)::int                               AS survey_responses,
    coalesce(sum(s.score), 0)::int                    AS score_total
  FROM csat_surveys s
  WHERE s.rated_user_id IS NOT NULL
  GROUP BY 1, 2, 3
)
SELECT
  coalesce(r.day, x.day, c.day)                    AS day,
  coalesce(r.user_id, x.user_id, c.user_id)        AS user_id,
  coalesce(r.product_id, x.product_id, c.product_id) AS product_id,
  coalesce(r.public_replies, 0)                    AS public_replies,
  coalesce(r.internal_notes, 0)                    AS internal_notes,
  coalesce(x.resolved_count, 0)                    AS resolved_count,
  coalesce(x.reopened_count, 0)                    AS reopened_count,
  x.resolution_wall_minutes_avg                    AS resolution_wall_minutes_avg,
  coalesce(c.surveys_sent, 0)                      AS surveys_sent,
  coalesce(c.survey_responses, 0)                  AS survey_responses,
  coalesce(c.score_total, 0)                       AS score_total
FROM replies r
FULL OUTER JOIN resolutions x
  ON x.day = r.day AND x.user_id = r.user_id AND x.product_id = r.product_id
FULL OUTER JOIN satisfaction c
  ON c.day = coalesce(r.day, x.day)
 AND c.user_id = coalesce(r.user_id, x.user_id)
 AND c.product_id = coalesce(r.product_id, x.product_id);--> statement-breakpoint

CREATE UNIQUE INDEX "report_agent_daily_key"
  ON "report_agent_daily" (day, user_id, product_id);--> statement-breakpoint

-- Satisfaction at product level, including surveys for tickets nobody owned,
-- which the per-agent view above cannot carry and which still count towards what
-- customers think of the desk.
--
-- Bucketed on created_at — the day the survey was sent — so response rate is a
-- fraction of one cohort. Bucketing on responded_at would put the numerator and
-- the denominator on different days.
CREATE MATERIALIZED VIEW "report_csat_daily" AS
SELECT
  (s.created_at AT TIME ZONE 'Africa/Harare')::date AS day,
  s.product_id,
  count(*)::int                                     AS surveys_sent,
  count(s.score)::int                               AS responses,
  coalesce(sum(s.score), 0)::int                    AS score_total,
  count(*) FILTER (WHERE s.score >= 4)::int         AS satisfied,
  count(*) FILTER (WHERE s.score <= 2)::int         AS dissatisfied
FROM csat_surveys s
GROUP BY 1, 2;--> statement-breakpoint

CREATE UNIQUE INDEX "report_csat_daily_key"
  ON "report_csat_daily" (day, product_id);--> statement-breakpoint

-- Knowledge base usage by the route the reader took. `suggest` counts are what
-- deflection is measured against: articles offered during ticket creation,
-- against tickets that got raised anyway.
CREATE MATERIALIZED VIEW "report_kb_daily" AS
SELECT
  (v.created_at AT TIME ZONE 'Africa/Harare')::date AS day,
  v.source,
  count(*)::int                                     AS views,
  count(DISTINCT v.article_id)::int                 AS articles
FROM kb_views v
GROUP BY 1, 2;--> statement-breakpoint

CREATE UNIQUE INDEX "report_kb_daily_key"
  ON "report_kb_daily" (day, source);
