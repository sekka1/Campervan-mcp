-- Migration: 0003_add_metering_schema.sql
-- Adds the accounts and usage_records tables for hashed Bearer API-key authentication
-- and fractional per-tool microcent billing ($1.00 = 1,000,000 microcents).

CREATE TABLE IF NOT EXISTS accounts (
  id                 TEXT    PRIMARY KEY,
  api_key_hash       TEXT    UNIQUE NOT NULL,
  balance_microcents INTEGER NOT NULL DEFAULT 10000000 CHECK (balance_microcents >= 0),
  is_active          INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at         TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS usage_records (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id        TEXT    NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  tool_name         TEXT    NOT NULL,
  cost_microcents   INTEGER NOT NULL CHECK (cost_microcents >= 0),
  execution_time_ms INTEGER NOT NULL CHECK (execution_time_ms >= 0),
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_usage_account ON usage_records (account_id);
