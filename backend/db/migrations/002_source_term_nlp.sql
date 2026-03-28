-- =============================================================
-- Migration 002: NLP Annotation Columns on source_terms
--
-- Adds lightweight clinical NLP signal columns generated at
-- ingest time (Node 1).  Original display_term is NEVER modified.
--
-- display_term_match:
--   Normalised form used exclusively for dedup / automatch comparison.
--   Pipeline: abbreviation expansion → stop word removal →
--             punctuation strip → whitespace collapse → UPPER.
--   Never shown to users; never written to canonical_mappings.
--
-- is_negated:
--   TRUE when the display term contains a negation signal
--   (e.g. "no diabetes", "without fever", "denies chest pain").
--   Negated terms still flow through the full review pipeline so
--   reviewers can map them to the correct SNOMED "absence" concept.
--
-- laterality:
--   'left' | 'right' | 'bilateral' | null (unspecified / not applicable).
--
-- qualifier_severity:
--   'mild' | 'moderate' | 'severe' | null.
--
-- qualifier_acuity:
--   'acute' | 'subacute' | 'chronic' | null.
--
-- qualifier_certainty:
--   'possible' | 'probable' | 'definite' | null.
-- =============================================================

ALTER TABLE source_terms
  ADD COLUMN IF NOT EXISTS display_term_match  TEXT,
  ADD COLUMN IF NOT EXISTS is_negated          BOOLEAN  NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS laterality          TEXT
    CHECK (laterality IN ('left', 'right', 'bilateral')),
  ADD COLUMN IF NOT EXISTS qualifier_severity  TEXT
    CHECK (qualifier_severity IN ('mild', 'moderate', 'severe')),
  ADD COLUMN IF NOT EXISTS qualifier_acuity    TEXT
    CHECK (qualifier_acuity IN ('acute', 'subacute', 'chronic')),
  ADD COLUMN IF NOT EXISTS qualifier_certainty TEXT
    CHECK (qualifier_certainty IN ('possible', 'probable', 'definite'));

-- Fast lookup for negated / lateralised terms (Node 6 reviewer filter)
CREATE INDEX IF NOT EXISTS idx_source_terms_negated
  ON source_terms(project_id, is_negated) WHERE is_negated = TRUE;

CREATE INDEX IF NOT EXISTS idx_source_terms_laterality
  ON source_terms(project_id, laterality) WHERE laterality IS NOT NULL;

-- Trigram index on match form for fast substring search (optional, requires pg_trgm)
-- CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- CREATE INDEX IF NOT EXISTS idx_source_terms_match_trgm
--   ON source_terms USING GIN (display_term_match gin_trgm_ops);
