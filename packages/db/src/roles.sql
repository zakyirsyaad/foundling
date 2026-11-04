-- Read and write roles (WEBSITE §5). Idempotent: migrate() runs it after every migration.
-- Production gives each role a password and LOGIN from the VPS .env; see docs/RUNBOOK.md.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'foundling_reader') THEN
    CREATE ROLE foundling_reader NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'foundling_writer') THEN
    CREATE ROLE foundling_writer NOLOGIN;
  END IF;
END
$$;

-- A flood of API requests must not hold the database: every reader query stops after 2 s.
ALTER ROLE foundling_reader SET statement_timeout = '2s';

GRANT USAGE ON SCHEMA public TO foundling_reader, foundling_writer;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO foundling_reader;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO foundling_writer;
-- Derived tables are rebuilt per touched nonce; events stay append-only.
GRANT DELETE ON cycles, nav_points TO foundling_writer;
