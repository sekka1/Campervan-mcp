-- Migration: 0002_add_document_chunks.sql
-- Adds the relational tier for hybrid RAG: document provenance, text chunks hydrated
-- by ID after a Vectorize kNN lookup, and extracted schematic images (stored in R2).

CREATE TABLE IF NOT EXISTS documents (
  id                     TEXT PRIMARY KEY,
  title                  TEXT NOT NULL,
  category               TEXT NOT NULL CHECK (category IN ('oem_bemm', 'component_manual', 'forum_consensus', 'code_standard')),
  manufacturer           TEXT NOT NULL,
  applicable_chassis     TEXT NOT NULL,
  applicable_model_years TEXT,
  source_url             TEXT,
  raw_r2_path            TEXT NOT NULL,
  created_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS schematic_images (
  id          TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  page_number INTEGER NOT NULL,
  caption     TEXT NOT NULL,
  r2_key      TEXT NOT NULL,
  mime_type   TEXT NOT NULL DEFAULT 'image/png',
  width       INTEGER,
  height      INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Chunk IDs match the Vectorize vector IDs, so search is: kNN -> WHERE id IN (...)
CREATE TABLE IF NOT EXISTS document_chunks (
  id                 TEXT PRIMARY KEY,
  document_id        TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  page_number        INTEGER NOT NULL,
  section_title      TEXT,
  subsystem          TEXT NOT NULL CHECK (subsystem IN ('12v_dc', '48v_dc', '120v_ac', 'plumbing', 'heating_cooling', 'structural', 'chassis_interface')),
  chunk_text         TEXT NOT NULL,
  word_count         INTEGER NOT NULL,
  token_count        INTEGER NOT NULL,
  schematic_image_id TEXT REFERENCES schematic_images (id),
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_schematic_images_doc ON schematic_images (document_id);
CREATE INDEX IF NOT EXISTS idx_document_chunks_doc ON document_chunks (document_id);
CREATE INDEX IF NOT EXISTS idx_document_chunks_subsystem ON document_chunks (subsystem);
