-- OmniMap — Migration 005: SNOMED Gap Identification & Reporting
-- Adds structured gap reason codes to reviewer and adjudicator decisions,
-- and a snomed gap flag to canonical_mappings for CRS export.
-- PRD v2.4 — FR-108 to FR-114

-- ---------------------------------------------------------------
-- Gap reason code enum
-- ---------------------------------------------------------------
CREATE TYPE gap_reason_code AS ENUM (
  'GAP-01',   -- Too specific: concept exists at broader level only
  'GAP-02',   -- Local abbreviation: no standard equivalent
  'GAP-03',   -- Compound concept: conflates 2+ SNOMED concepts, no pre-coordinated equivalent
  'GAP-04',   -- Novel clinical concept: genuinely absent from current SNOMED CT release
  'GAP-05',   -- Data quality: term is not a clinical concept (free text, transcription artefact)
  'GAP-06'    -- Other: free-text rationale required
);

COMMENT ON TYPE gap_reason_code IS
  'Structured reason codes for SNOMED CT gap declarations (PRD v2.4 §5.7, FR-108).
   Used in mapping_decisions, adjudication_decisions, and canonical_mappings.
   Gap terms exported to SNOMED International Content Request System (CRS).';

-- ---------------------------------------------------------------
-- mapping_decisions — add gap_reason_code
-- ---------------------------------------------------------------
ALTER TABLE mapping_decisions
  ADD COLUMN IF NOT EXISTS gap_reason_code gap_reason_code;

COMMENT ON COLUMN mapping_decisions.gap_reason_code IS
  'Populated when is_unmappable = TRUE and the reviewer has identified this as a SNOMED CT gap.
   Required for GAP-06 (Other); optional but recommended for all gap decisions.';

-- ---------------------------------------------------------------
-- adjudication_decisions — add gap_reason_code
-- ---------------------------------------------------------------
ALTER TABLE adjudication_decisions
  ADD COLUMN IF NOT EXISTS gap_reason_code gap_reason_code;

COMMENT ON COLUMN adjudication_decisions.gap_reason_code IS
  'Adjudicator-confirmed gap reason code. Set when adjudicator confirms a gap decision
   or when adjudicator overrides a concept mapping with a gap declaration.';

-- ---------------------------------------------------------------
-- canonical_mappings — add is_snomed_gap + gap_reason_code
-- ---------------------------------------------------------------
ALTER TABLE canonical_mappings
  ADD COLUMN IF NOT EXISTS is_snomed_gap   BOOLEAN        NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS gap_reason_code gap_reason_code;

COMMENT ON COLUMN canonical_mappings.is_snomed_gap IS
  'TRUE for terms confirmed as having no SNOMED CT mapping. These terms are included
   in the SNOMED Gap Report (Node 13 EXPORT) and flagged in the corpus to prevent
   duplicate review in future projects (FR-111, FR-113).';

COMMENT ON COLUMN canonical_mappings.gap_reason_code IS
  'The confirmed gap reason code from the reviewer or adjudicator workflow.
   Carried through from mapping_decisions or adjudication_decisions.';

-- ---------------------------------------------------------------
-- Index: fast gap report queries
-- ---------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_canonical_mappings_snomed_gap
  ON canonical_mappings (project_id, is_snomed_gap)
  WHERE is_snomed_gap = TRUE;

-- ---------------------------------------------------------------
-- Index: deduplication cross-reference for known gaps
-- ---------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_canonical_mappings_gap_source_term
  ON canonical_mappings (source_term_id, is_snomed_gap)
  WHERE is_snomed_gap = TRUE AND is_current = TRUE;
