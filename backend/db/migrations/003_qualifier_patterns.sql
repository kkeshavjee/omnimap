-- =============================================================
-- Migration 003: Clinical Qualifier Pattern Library
--
-- Stores the seven qualifier pattern sets imported from Excel:
--   negation   — rule-out / negation signals      (<exc-ro] ... [exc-ro>)
--   stop_word  — terms removed from match form    (REPLACE_WITH = '^')
--   location   — anatomical site tags             (<loc] ... [loc>)
--   timing     — temporal / acuity tags           (<time] ... [time>)
--   family_history — family context exclusions   (<exc-fhx] ... [fhx-exc>)
--   causation  — etiology qualifiers              (<cau> ... <cau>)
--   screening  — screening programme management  (Exclude FOBT, Abnormal, Overdue...)
--
-- OmniMap is the AUTHORITATIVE store.  Excel files are only used
-- for the initial import (scripts/seedQualifierPatterns.ts).
-- Patterns may be edited, added, or deactivated through the UI.
-- All changes are versioned.  Deactivated patterns are soft-deleted.
-- =============================================================

CREATE TYPE qualifier_category AS ENUM (
  'negation',
  'stop_word',
  'location',
  'timing',
  'family_history',
  'causation',
  'screening'   -- screening programme management: Exclude X, Abnormal, Overdue, Positive/Negative screening
);

CREATE TABLE qualifier_patterns (
  id              UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
  category        qualifier_category NOT NULL,

  -- Pattern (stored as entered; engine compiles with 'i' flag unless override_flags set)
  pattern_text    TEXT              NOT NULL,
  flags           TEXT              NOT NULL DEFAULT 'i',  -- JS RegExp flags

  -- What the pattern produces
  replace_with    TEXT,             -- null = detect-only; '^' = delete; text = replacement
  prefix          TEXT,             -- XML open tag  e.g. '<loc]'
  suffix          TEXT,             -- XML close tag e.g. '[loc>'
  canonical_label TEXT,             -- human label   e.g. 'right lower quadrant'

  -- How this pattern is applied at ingest time
  --   'tag'                — apply prefix+text+suffix XML marker AND set the qualifier flag
  --   'ignore'             — strip the matched text, do NOT set is_negated
  --                          (apparent negations that are disease names: NON-ALCOHOLIC, NOS, NYD, UNSPECIFIED)
  --   'detect'             — set the qualifier flag, no XML output
  --   'screening'  — mark term as a screening programme management note, not a diagnosis
  --                 (e.g. "Exclude FOBT", "Abnormal Pap", "Overdue mammogram",
  --                  "Negative screening", "Positive FIT")
  action          TEXT              NOT NULL DEFAULT 'tag'
    CHECK (action IN ('tag', 'ignore', 'detect', 'screening')),

  -- Ordering (lower = higher priority; first match wins within category)
  sort_order      INTEGER           NOT NULL DEFAULT 1000,

  -- Provenance
  source_file     TEXT,             -- original xlsx filename
  source_row      INTEGER,          -- row index in that file (for traceability)

  -- Lifecycle
  is_active       BOOLEAN           NOT NULL DEFAULT TRUE,
  version         INTEGER           NOT NULL DEFAULT 1,
  superseded_by   UUID              REFERENCES qualifier_patterns(id),

  created_at      TIMESTAMPTZ       NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ       NOT NULL DEFAULT now()
);

CREATE INDEX idx_qp_category    ON qualifier_patterns(category, sort_order) WHERE is_active = TRUE;
CREATE INDEX idx_qp_source_file ON qualifier_patterns(source_file) WHERE source_file IS NOT NULL;

-- Audit: bump version and updated_at on every edit
CREATE OR REPLACE FUNCTION trg_qualifier_patterns_version()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.version    := OLD.version + 1;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_qp_version
  BEFORE UPDATE ON qualifier_patterns
  FOR EACH ROW EXECUTE FUNCTION trg_qualifier_patterns_version();
