-- Migration: 0005_drop_legacy_category_check.sql
-- Rebuilds the documents table to remove the legacy CHECK(category IN (...)) constraint
-- which prevented universal taxonomy categories ('chassis', 'climate', 'power', 'plumbing', 'other').

PRAGMA defer_foreign_keys = ON;

CREATE TABLE documents_new (
  id                     TEXT PRIMARY KEY,
  title                  TEXT NOT NULL,
  category               TEXT NOT NULL,
  manufacturer           TEXT NOT NULL,
  applicable_chassis     TEXT NOT NULL,
  applicable_model_years TEXT,
  source_url             TEXT,
  raw_r2_path            TEXT NOT NULL,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  model                  TEXT NOT NULL DEFAULT 'unknown',
  market                 TEXT NOT NULL DEFAULT 'global',
  metadata_json          TEXT DEFAULT '{}'
);

INSERT INTO documents_new (
  id,
  title,
  category,
  manufacturer,
  applicable_chassis,
  applicable_model_years,
  source_url,
  raw_r2_path,
  created_at,
  model,
  market,
  metadata_json
)
SELECT
  id,
  title,
  category,
  manufacturer,
  applicable_chassis,
  applicable_model_years,
  source_url,
  raw_r2_path,
  created_at,
  model,
  market,
  metadata_json
FROM documents;

DROP TABLE documents;

ALTER TABLE documents_new RENAME TO documents;

CREATE INDEX IF NOT EXISTS idx_documents_taxonomy ON documents (category, manufacturer, model, market);
