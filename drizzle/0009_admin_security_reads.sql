DROP INDEX "login_attempts_user_idx";--> statement-breakpoint
CREATE INDEX "login_attempts_user_created_idx" ON "login_attempts" USING btree ("user_id","created_at" DESC NULLS LAST);