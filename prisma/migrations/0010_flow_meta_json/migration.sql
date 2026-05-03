-- ── Migration 0010: Add meta_json snapshot to flows ──────────────────────────

ALTER TABLE "flows" ADD COLUMN "meta_json" JSONB;
