CREATE TABLE "cycles" (
	"vault_id" text NOT NULL,
	"nonce" bigint NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"closing" text,
	"trigger_tx" text,
	"decision_tx" text,
	"amount_in" numeric(78, 0),
	"amount_out" numeric(78, 0),
	"last_block" bigint NOT NULL,
	CONSTRAINT "cycles_vault_id_nonce_pk" PRIMARY KEY("vault_id","nonce")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"vault_id" text NOT NULL,
	"receipt_id" text NOT NULL,
	"log_index" integer NOT NULL,
	"tx_hash" text NOT NULL,
	"block_height" bigint NOT NULL,
	"receipt_index" integer NOT NULL,
	"block_time" timestamp with time zone NOT NULL,
	"name" text NOT NULL,
	"nonce" bigint,
	"account" text,
	"data" jsonb NOT NULL,
	CONSTRAINT "events_vault_id_receipt_id_log_index_pk" PRIMARY KEY("vault_id","receipt_id","log_index")
);
--> statement-breakpoint
CREATE TABLE "nav_points" (
	"vault_id" text NOT NULL,
	"nonce" bigint NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"block_height" bigint NOT NULL,
	"book_usdc" numeric(78, 0) NOT NULL,
	"book_wnear" numeric(78, 0) NOT NULL,
	"total_shares" numeric(78, 0) NOT NULL,
	"oracle_near" numeric(78, 0),
	"oracle_usdc" numeric(78, 0),
	CONSTRAINT "nav_points_vault_id_nonce_pk" PRIMARY KEY("vault_id","nonce")
);
--> statement-breakpoint
CREATE TABLE "proofs" (
	"vault_id" text NOT NULL,
	"nonce" bigint NOT NULL,
	"bundle" jsonb,
	"approved_measurements" jsonb,
	"verifier" jsonb,
	"obs_recheck" jsonb,
	"replay" text DEFAULT 'sealed' NOT NULL,
	"verifier_state" text DEFAULT 'queued' NOT NULL,
	"obs_state" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"first_attempt_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revealed_applied" integer DEFAULT 0 NOT NULL,
	"verifier_commit" text,
	"last_error" text,
	CONSTRAINT "proofs_vault_id_nonce_pk" PRIMARY KEY("vault_id","nonce")
);
--> statement-breakpoint
CREATE TABLE "sync_state" (
	"vault_id" text PRIMARY KEY NOT NULL,
	"position" bigint NOT NULL,
	"tip" bigint,
	"heartbeat_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
CREATE INDEX "events_order" ON "events" USING btree ("vault_id","block_height","receipt_index","log_index");--> statement-breakpoint
CREATE INDEX "events_nonce" ON "events" USING btree ("vault_id","nonce");--> statement-breakpoint
CREATE INDEX "proofs_due" ON "proofs" USING btree ("next_attempt_at");