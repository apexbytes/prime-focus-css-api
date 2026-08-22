CREATE TYPE "public"."identity_provider_kind" AS ENUM('google', 'microsoft', 'oidc');--> statement-breakpoint
ALTER TYPE "public"."login_outcome" ADD VALUE 'sso_ok';--> statement-breakpoint
ALTER TYPE "public"."login_outcome" ADD VALUE 'sso_denied';--> statement-breakpoint
ALTER TYPE "public"."login_outcome" ADD VALUE 'password_unavailable';--> statement-breakpoint
CREATE TABLE "identity_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"display_name" text NOT NULL,
	"kind" "identity_provider_kind" NOT NULL,
	"issuer" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret" text NOT NULL,
	"scopes" text[] NOT NULL,
	"allowed_email_domains" text[] DEFAULT '{}' NOT NULL,
	"require_verified_email" boolean DEFAULT true NOT NULL,
	"require_otp" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_providers_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "sso_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"email" text NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sso_identities_subject_unique" UNIQUE("provider_id","subject"),
	CONSTRAINT "sso_identities_user_unique" UNIQUE("provider_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "sso_login_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"state_hash" text NOT NULL,
	"nonce" text NOT NULL,
	"code_verifier" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"return_path" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sso_login_requests_state_hash_unique" UNIQUE("state_hash")
);
--> statement-breakpoint
ALTER TABLE "identity_providers" ADD CONSTRAINT "identity_providers_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_identities" ADD CONSTRAINT "sso_identities_provider_id_identity_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."identity_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_identities" ADD CONSTRAINT "sso_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_login_requests" ADD CONSTRAINT "sso_login_requests_provider_id_identity_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."identity_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "identity_providers_active_idx" ON "identity_providers" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "sso_identities_user_idx" ON "sso_identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sso_login_requests_provider_idx" ON "sso_login_requests" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "sso_login_requests_expires_at_idx" ON "sso_login_requests" USING btree ("expires_at");