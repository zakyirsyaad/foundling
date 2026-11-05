ALTER TABLE "sync_state" ADD COLUMN "indexed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sync_state" ADD COLUMN "scanned_tip" bigint;