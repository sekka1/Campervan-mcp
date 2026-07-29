-- Migration: 0001_initial_schema.sql
-- Creates the component_specs table for storing campervan electrical/mechanical component data.

CREATE TABLE IF NOT EXISTS component_specs (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  name                  TEXT    NOT NULL,
  category              TEXT    NOT NULL,
  manufacturer          TEXT,
  model_number          TEXT    UNIQUE,
  max_continuous_amps   REAL,
  idle_power_watts      REAL,
  weight_lbs            REAL,
  terminal_stud_size    TEXT,
  dimensions_inches     TEXT,
  notes                 TEXT,
  created_at            TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_component_specs_category    ON component_specs (category);
CREATE INDEX IF NOT EXISTS idx_component_specs_manufacturer ON component_specs (manufacturer);
CREATE INDEX IF NOT EXISTS idx_component_specs_name        ON component_specs (name);
