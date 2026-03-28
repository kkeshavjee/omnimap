-- =============================================================
-- Migration 004: Screening annotation on source_terms
--
-- Doctors use the EMR Problem List to manage prevention and
-- screening activities.  These entries are NOT diagnoses.
-- Examples:
--
--   Exclusions:   "Exclude FOBT"   — patient already has colonoscopies;
--                                    FOBT is not appropriate
--   Result flags: "Abnormal Pap"   — result flag, not a gynaecological dx
--                 "Positive FIT"   — screening result, not GI dx
--                 "Negative screening BRCA" — variant result context
--   Status flags: "Overdue mammogram" — reminder/flag, not a dx
--                 "Declined PSA"       — patient preference note
--
-- All of these must:
--   • NOT be flagged as is_negated
--   • NOT map to a SNOMED clinical finding or disorder concept
--   • Be surfaced to reviewers with a distinct visual indicator
--     so they understand this is a screening / prevention entry
--     and can map it to an appropriate administrative/observable concept
--
-- The qualifier_category enum already includes 'screening' (migration 003).
-- This migration adds the annotation column on source_terms.
-- =============================================================

-- New annotation column on source_terms
ALTER TABLE source_terms
  ADD COLUMN IF NOT EXISTS is_screening BOOLEAN NOT NULL DEFAULT FALSE;

-- Partial index — reviewers filter on this; project-scoped
CREATE INDEX IF NOT EXISTS idx_source_terms_screening
  ON source_terms(project_id, is_screening)
  WHERE is_screening = TRUE;
