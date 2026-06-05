-- Migration 0036: protect selected flows from deletion
ALTER TABLE "flows"
  ADD COLUMN IF NOT EXISTS "deletion_locked" BOOLEAN NOT NULL DEFAULT false;
