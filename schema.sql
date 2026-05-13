-- Motowarehouse Service Portal — PostgreSQL Schema
-- Run this once to initialise your database.
-- Safe to re-run: all statements use IF NOT EXISTS / ON CONFLICT.

-- ── Settings (key/value store) ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

-- ── Bookings ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bookings (
  id             SERIAL PRIMARY KEY,
  ref            TEXT GENERATED ALWAYS AS ('MW' || LPAD(id::TEXT, 5, '0')) STORED,
  name           TEXT    NOT NULL,
  phone          TEXT    NOT NULL,
  email          TEXT    NOT NULL DEFAULT '',
  service_type   TEXT    NOT NULL,
  date           TEXT    NOT NULL DEFAULT '',
  time           TEXT    NOT NULL DEFAULT '',
  model          TEXT    NOT NULL,
  year           TEXT    NOT NULL,
  plate          TEXT    NOT NULL,
  km             TEXT    NOT NULL,
  notes          TEXT    NOT NULL DEFAULT '',
  description    TEXT    NOT NULL DEFAULT '',
  mechanic       INTEGER NOT NULL DEFAULT 1,
  status         TEXT    NOT NULL DEFAULT 'pending',
  contact_status TEXT,
  reminder_sent  BOOLEAN NOT NULL DEFAULT FALSE,
  service_km     INTEGER,
  service_reg_no TEXT,
  completed_at   TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bookings_date   ON bookings (date);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings (status);
CREATE INDEX IF NOT EXISTS idx_bookings_plate  ON bookings (plate);

-- ── Manual Blocks ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS blocks (
  id             BIGINT PRIMARY KEY,
  date           TEXT NOT NULL,
  start_time     TEXT NOT NULL,
  end_time       TEXT NOT NULL,
  reason         TEXT NOT NULL DEFAULT '',
  customer_name  TEXT NOT NULL DEFAULT '',
  customer_phone TEXT NOT NULL DEFAULT '',
  vehicle_model  TEXT NOT NULL DEFAULT '',
  notes          TEXT NOT NULL DEFAULT '',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_blocks_date ON blocks (date);

-- ── Vehicles ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vehicles (
  reg_no       TEXT PRIMARY KEY,
  frame_no     TEXT NOT NULL DEFAULT '',
  engine_no    TEXT NOT NULL DEFAULT '',
  model        TEXT NOT NULL DEFAULT '',
  manufacturer TEXT NOT NULL DEFAULT '',
  description  TEXT NOT NULL DEFAULT '',
  year         TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'registered',
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vehicles_model    ON vehicles (model);
CREATE INDEX IF NOT EXISTS idx_vehicles_frame_no ON vehicles (frame_no);

-- ── Partners ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS partners (
  id            BIGINT PRIMARY KEY,
  username      TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  workshop_name TEXT    NOT NULL,
  phone         TEXT    NOT NULL DEFAULT '',
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Service History ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS service_history (
  id              BIGINT PRIMARY KEY,
  reg_no          TEXT    NOT NULL,
  date            TEXT    NOT NULL,
  km              INTEGER NOT NULL DEFAULT 0,
  items           JSONB   NOT NULL DEFAULT '[]',
  notes           TEXT    NOT NULL DEFAULT '',
  partner_id      BIGINT,
  partner_name    TEXT    NOT NULL DEFAULT 'Motowarehouse',
  logged_by_admin BOOLEAN NOT NULL DEFAULT FALSE,
  booking_ref     TEXT,
  updated_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_service_history_reg_no ON service_history (reg_no);

-- ── Warranty History ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS warranty_history (
  id                 BIGINT PRIMARY KEY,
  reg_no             TEXT    NOT NULL,
  frame_no           TEXT    NOT NULL DEFAULT '',
  km                 INTEGER NOT NULL DEFAULT 0,
  sale_date          TEXT    NOT NULL DEFAULT '',
  symptom            TEXT    NOT NULL,
  priority           TEXT    NOT NULL DEFAULT 'normal',
  engine_disassembly BOOLEAN NOT NULL DEFAULT FALSE,
  defect_agreed      BOOLEAN NOT NULL DEFAULT FALSE,
  courtesy_vehicle   BOOLEAN NOT NULL DEFAULT FALSE,
  notes              TEXT    NOT NULL DEFAULT '',
  photos             JSONB   NOT NULL DEFAULT '[]',
  media_types        JSONB   NOT NULL DEFAULT '[]',
  logged_by          TEXT    NOT NULL DEFAULT 'Motowarehouse',
  logged_by_admin    BOOLEAN NOT NULL DEFAULT FALSE,
  partner_id         BIGINT,
  partner_name       TEXT    NOT NULL DEFAULT 'Motowarehouse',
  status             TEXT    NOT NULL DEFAULT 'open',
  admin_notes        TEXT,
  updated_at         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_warranty_history_reg_no ON warranty_history (reg_no);
CREATE INDEX IF NOT EXISTS idx_warranty_history_status ON warranty_history (status);
