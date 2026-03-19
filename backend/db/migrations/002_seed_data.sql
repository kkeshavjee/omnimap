-- =============================================================
-- OmniMap — Migration 002: Seed Data
-- =============================================================
-- Inserts standard terminology records and system defaults.
-- Never edit this file after it has been applied to any
-- environment. Add a new numbered migration for changes.
-- =============================================================

BEGIN;

-- Standard terminologies (FR-17, FR-384)
-- 'custom' is a placeholder; administrators create named custom
-- terminology records with a separate INSERT.
INSERT INTO terminologies (code, display_name) VALUES
  ('snomed_ct', 'SNOMED CT'),
  ('loinc',     'LOINC'),
  ('atc',       'ATC'),
  ('ccdd',      'CCDD'),
  ('icd10',     'ICD-10'),
  ('icd11',     'ICD-11')
ON CONFLICT (code) DO NOTHING;

COMMIT;
