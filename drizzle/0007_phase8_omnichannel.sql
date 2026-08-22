CREATE TYPE "public"."conversation_status" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TYPE "public"."inbound_channel_message_status" AS ENUM('received', 'processed', 'ignored', 'failed');--> statement-breakpoint
CREATE TYPE "public"."outbound_channel_message_status" AS ENUM('sent', 'failed');--> statement-breakpoint
ALTER TYPE "public"."ticket_channel" ADD VALUE 'chat';--> statement-breakpoint
ALTER TYPE "public"."ticket_channel" ADD VALUE 'whatsapp';--> statement-breakpoint
CREATE TABLE "channel_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel" "ticket_channel" NOT NULL,
	"external_id" text NOT NULL,
	"product_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"ticket_id" uuid,
	"status" "conversation_status" DEFAULT 'open' NOT NULL,
	"last_inbound_at" timestamp with time zone,
	"last_outbound_at" timestamp with time zone,
	"window_expires_at" timestamp with time zone,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_conversations_external_unique" UNIQUE("channel","external_id")
);
--> statement-breakpoint
CREATE TABLE "customer_channel_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"channel" "ticket_channel" NOT NULL,
	"identifier" text NOT NULL,
	"display_name" text,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_channel_identities_unique" UNIQUE("channel","identifier")
);
--> statement-breakpoint
CREATE TABLE "inbound_channel_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel" "ticket_channel" NOT NULL,
	"provider_message_id" text NOT NULL,
	"conversation_external_id" text NOT NULL,
	"from_identifier" text NOT NULL,
	"display_name" text,
	"body" text,
	"status" "inbound_channel_message_status" DEFAULT 'received' NOT NULL,
	"conversation_id" uuid,
	"ticket_id" uuid,
	"ticket_message_id" uuid,
	"error" text,
	"payload" jsonb,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbound_channel_messages_provider_message_id_unique" UNIQUE("provider_message_id")
);
--> statement-breakpoint
CREATE TABLE "outbound_channel_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel" "ticket_channel" NOT NULL,
	"conversation_id" uuid,
	"ticket_id" uuid,
	"ticket_message_id" uuid,
	"to_identifier" text NOT NULL,
	"body" text NOT NULL,
	"kind" text NOT NULL,
	"provider_message_id" text,
	"status" "outbound_channel_message_status" NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"conversation_external_id" text NOT NULL,
	"conversation_id" uuid,
	"product_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"contact_email" text,
	"expires_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"metadata" jsonb,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_sessions_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "chat_sessions_conversation_external_id_unique" UNIQUE("conversation_external_id")
);
--> statement-breakpoint
ALTER TABLE "customers" ALTER COLUMN "email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_conversations" ADD CONSTRAINT "channel_conversations_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_conversations" ADD CONSTRAINT "channel_conversations_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_conversations" ADD CONSTRAINT "channel_conversations_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_channel_identities" ADD CONSTRAINT "customer_channel_identities_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_channel_messages" ADD CONSTRAINT "inbound_channel_messages_conversation_id_channel_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."channel_conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_channel_messages" ADD CONSTRAINT "inbound_channel_messages_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_channel_messages" ADD CONSTRAINT "inbound_channel_messages_ticket_message_id_ticket_messages_id_fk" FOREIGN KEY ("ticket_message_id") REFERENCES "public"."ticket_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_channel_messages" ADD CONSTRAINT "outbound_channel_messages_conversation_id_channel_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."channel_conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_channel_messages" ADD CONSTRAINT "outbound_channel_messages_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_channel_messages" ADD CONSTRAINT "outbound_channel_messages_ticket_message_id_ticket_messages_id_fk" FOREIGN KEY ("ticket_message_id") REFERENCES "public"."ticket_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_conversation_id_channel_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."channel_conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_conversations_ticket_idx" ON "channel_conversations" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "channel_conversations_customer_idx" ON "channel_conversations" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "channel_conversations_status_idx" ON "channel_conversations" USING btree ("status","last_inbound_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "customer_channel_identities_customer_idx" ON "customer_channel_identities" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "inbound_channel_messages_status_idx" ON "inbound_channel_messages" USING btree ("status","received_at");--> statement-breakpoint
CREATE INDEX "inbound_channel_messages_conversation_idx" ON "inbound_channel_messages" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "outbound_channel_messages_ticket_idx" ON "outbound_channel_messages" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "outbound_channel_messages_provider_idx" ON "outbound_channel_messages" USING btree ("provider_message_id");--> statement-breakpoint
CREATE INDEX "chat_sessions_conversation_idx" ON "chat_sessions" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "chat_sessions_expiry_idx" ON "chat_sessions" USING btree ("expires_at");