-- Migration: 0004_add_universal_metadata.sql
-- Adds universal taxonomy tags and flexible JSON pouch for multi-vehicle,
-- multi-year, and appliance manual classification.

-- 1. Add universal metadata columns to documents
ALTER TABLE documents ADD COLUMN model TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE documents ADD COLUMN market TEXT NOT NULL DEFAULT 'global';
ALTER TABLE documents ADD COLUMN metadata_json TEXT DEFAULT '{}';

-- 2. Add universal metadata columns to document_chunks
ALTER TABLE document_chunks ADD COLUMN category TEXT;
ALTER TABLE document_chunks ADD COLUMN manufacturer TEXT;
ALTER TABLE document_chunks ADD COLUMN model TEXT;
ALTER TABLE document_chunks ADD COLUMN market TEXT;
ALTER TABLE document_chunks ADD COLUMN metadata_json TEXT;

-- 3. Composite and single-column taxonomy indexes for fast filtered hydration
CREATE INDEX IF NOT EXISTS idx_documents_taxonomy ON documents (category, manufacturer, model, market);
CREATE INDEX IF NOT EXISTS idx_chunks_taxonomy ON document_chunks (category, manufacturer, model, market);
CREATE INDEX IF NOT EXISTS idx_chunks_market ON document_chunks (market);
