-- =============================================================
-- OmniMap — Migration 001: Initial Schema
-- =============================================================
-- Rules:
--   • All timestamps are TIMESTAMPTZ (UTC). No exceptions.
--   • Mapping records are immutable. Corrections create new
--     versioned records; superseded records are never deleted.
--   • audit_log is append-only. UPDATE and DELETE are blocked
--     at the trigger level. No exceptions.
--   • Holdout terms are locked at draw time. Locked records
--     cannot be reassigned or removed.
--   • Reviewer independence is enforced at the data layer.
--     Queries MUST filter by reviewer_id — never expose
--     another reviewer's assignments or decisions.
-- =============================================================

BEGIN;

-- Extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "pg_trgm";    -- trigram index for source term search

-- =============================================================
-- ENUMERATIONS
-- =============================================================

CREATE TYPE user_role AS ENUM (
  'administrator',
  'reviewer',
  'adjudicator',
  'auditor'
);

CREATE TYPE project_type AS ENUM (
  'standard_mapping',
  'automation_evaluation',
  'version_validation'
);

CREATE TYPE project_status AS ENUM (
  'init',
  'ingesting',
  'deduplicating',
  'sampling',
  'holdout_draw',
  'automatch',
  'allocating',
  'mapping',
  'adjudicating',
  'canonicalising',
  'regex_pipeline',
  'regex_validate',
  'corpus_update',
  'scoring',
  'exporting',
  'complete',
  'archived'
);

CREATE TYPE term_status AS ENUM (
  'raw',
  'already_mapped',       -- resolved by deduplication
  'out_of_place',         -- data quality exclusion
  'net_new_queued',       -- not in any prior extract; staged for next cycle
  'long_tail_queued',     -- below Pareto cutoff; priority queue
  'sampled',              -- in main mapping pool
  'holdout',              -- drawn into holdout set (locked)
  'auto_matched',         -- identical SNOMED CT FSN match; bypassed reviewers
  'allocated',            -- assigned to two reviewers
  'mapping_in_progress',
  'agreed',               -- both reviewers matched; ready for canonicalisation
  'adjudication_queued',  -- discrepancy escalated
  'adjudicated',          -- adjudicator resolved
  'canonicalised'         -- output convention applied; in corpus
);

CREATE TYPE mapping_relationship AS ENUM (
  'equivalent_to',
  'broader_than',
  'narrower_than',
  'related_to',
  'not_mappable'
);

-- Four-point validation scoring scheme (maps to confusion matrix)
-- 0 = TN  Correctly not coded
-- 1 = TP  Correctly coded
-- 2 = FP  Incorrectly coded
-- 3 = FN  Incorrectly not coded
CREATE TYPE validation_score AS ENUM ('0', '1', '2', '3');

CREATE TYPE concept_type AS ENUM (
  'diagnosis',
  'medication',
  'procedure',
  'lab',
  'symptom',
  'allergy',
  'device',
  'risk_factor'
);

CREATE TYPE regex_layer AS ENUM (
  'normalise',
  'negation',
  'qualifier',
  'manufacturer',
  'concept'
);

CREATE TYPE correction_pathway AS ENUM (
  'reopen',          -- reassigned to single reviewer; targeted
  'direct_override'  -- senior expert proposes; accepted immediately
);

CREATE TYPE export_format AS ENUM (
  'fhir_r4',
  'fhir_r5',
  'regex_json',
  'csv',
  'excel',
  'pdf'
);

CREATE TYPE sampling_strategy AS ENUM (
  'random',
  'stratified',
  'frequency',
  'pareto'
);

-- =============================================================
-- USERS
-- =============================================================

CREATE TABLE users (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  cognito_sub   TEXT        UNIQUE NOT NULL,
  email         TEXT        UNIQUE NOT NULL,
  display_name  TEXT        NOT NULL,
  role          user_role   NOT NULL,
  is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
  mfa_enabled   BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_users_role        ON users(role);
CREATE INDEX idx_users_cognito_sub ON users(cognito_sub);

-- =============================================================
-- TERMINOLOGIES
-- =============================================================

CREATE TABLE terminologies (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  code          TEXT        UNIQUE NOT NULL,  -- 'snomed_ct' | 'loinc' | 'atc' | 'ccdd' | 'icd10' | 'icd11' | 'custom'
  display_name  TEXT        NOT NULL,
  version       TEXT,
  is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Standard terminologies seeded in migration 002.

-- =============================================================
-- PROJECTS
-- =============================================================

CREATE TABLE projects (
  id                            UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  name                          TEXT           NOT NULL,
  description                   TEXT,
  project_type                  project_type   NOT NULL DEFAULT 'standard_mapping',
  source_terminology_id         UUID           REFERENCES terminologies(id),
  target_terminology_id         UUID           NOT NULL REFERENCES terminologies(id),
  status                        project_status NOT NULL DEFAULT 'init',
  current_dag_node              TEXT,

  -- Power calculation parameters (FR-11, FR-12)
  power_f1_threshold            NUMERIC(4,3)   NOT NULL DEFAULT 0.90,
  power_alpha                   NUMERIC(4,3)   NOT NULL DEFAULT 0.05,
  power_beta                    NUMERIC(4,3)   NOT NULL DEFAULT 0.20,   -- 1 - power
  computed_holdout_n            INTEGER,

  -- Configurable thresholds (not hard-coded per PRD)
  greediness_ratio_threshold    NUMERIC(5,2)   NOT NULL DEFAULT 2.0,    -- Section 5.11
  near_duplicate_edit_distance  INTEGER        NOT NULL DEFAULT 2,       -- FR-43

  -- Lock timestamps
  sample_locked_at              TIMESTAMPTZ,
  holdout_locked_at             TIMESTAMPTZ,
  target_terminology_locked_at  TIMESTAMPTZ,   -- locked once reviewer assignment begins

  -- Version validation fields (FR-84)
  prior_terminology_version     TEXT,
  new_terminology_version       TEXT,

  created_by  UUID        NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_projects_status     ON projects(status);
CREATE INDEX idx_projects_created_by ON projects(created_by);

-- =============================================================
-- EMR EXTRACTS (FR-01)
-- =============================================================

CREATE TABLE emr_extracts (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID        NOT NULL REFERENCES projects(id),
  filename        TEXT        NOT NULL,
  total_rows      INTEGER,
  status          TEXT        NOT NULL DEFAULT 'processing',  -- processing | ready | error
  error_message   TEXT,
  uploaded_by     UUID        NOT NULL REFERENCES users(id),
  uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_emr_extracts_project ON emr_extracts(project_id);

-- =============================================================
-- SOURCE TERMS (raw rows from EMR extract, FR-01)
-- =============================================================

CREATE TABLE source_terms (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  extract_id            UUID        NOT NULL REFERENCES emr_extracts(id),
  project_id            UUID        NOT NULL REFERENCES projects(id),
  source_code           TEXT        NOT NULL,
  display_term          TEXT        NOT NULL,
  frequency             INTEGER,                          -- NULL if not provided
  clinical_domain       TEXT,
  source_terminology_id UUID        REFERENCES terminologies(id),
  is_out_of_place       BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_source_terms_project     ON source_terms(project_id);
CREATE INDEX idx_source_terms_source_code ON source_terms(project_id, source_code);
CREATE INDEX idx_source_terms_trgm        ON source_terms USING gin(display_term gin_trgm_ops);

-- =============================================================
-- EXTERNAL MAPPING IMPORTS (Node 0 — read-only reference, FR-02)
-- Prior mappings not produced by OmniMap. Never enter canonical
-- output without going through the review workflow.
-- =============================================================

CREATE TABLE external_mapping_imports (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID        NOT NULL REFERENCES projects(id),
  source_code     TEXT        NOT NULL,
  display_term    TEXT        NOT NULL,
  target_code     TEXT        NOT NULL,
  target_display  TEXT        NOT NULL,
  terminology_id  UUID        REFERENCES terminologies(id),
  imported_by     UUID        NOT NULL REFERENCES users(id),
  imported_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ext_imports_project     ON external_mapping_imports(project_id);
CREATE INDEX idx_ext_imports_source_code ON external_mapping_imports(project_id, source_code);

-- =============================================================
-- PROJECT TERMS (working set with lifecycle status, FR-02–FR-10)
-- =============================================================

CREATE TABLE project_terms (
  id                              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id                      UUID        NOT NULL REFERENCES projects(id),
  source_term_id                  UUID        NOT NULL REFERENCES source_terms(id),
  status                          term_status NOT NULL DEFAULT 'raw',

  -- Holdout (FR-13, FR-14, Section 7.6)
  is_holdout                      BOOLEAN     NOT NULL DEFAULT FALSE,
  holdout_locked                  BOOLEAN     NOT NULL DEFAULT FALSE,
  holdout_locked_at               TIMESTAMPTZ,

  -- Auto-match (FR-106, Node 4 Branch A)
  is_auto_matched                 BOOLEAN     NOT NULL DEFAULT FALSE,
  auto_matched_at                 TIMESTAMPTZ,
  auto_matched_fsn                TEXT,        -- the SNOMED CT FSN that matched

  -- Deduplication cross-reference
  already_mapped_by_project_id    UUID        REFERENCES projects(id),

  -- Long tail / net-new queue priority (FR-07)
  long_tail_priority_score        NUMERIC(8,4),
  frequency_trend                 NUMERIC(8,4),
  domain_risk_flag                BOOLEAN     NOT NULL DEFAULT FALSE,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(project_id, source_term_id)
);

CREATE INDEX idx_project_terms_project  ON project_terms(project_id);
CREATE INDEX idx_project_terms_status   ON project_terms(project_id, status);
CREATE INDEX idx_project_terms_holdout  ON project_terms(project_id, is_holdout);

-- Prevent mutation of locked holdout records (Section 7.6)
CREATE OR REPLACE FUNCTION prevent_holdout_modification()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.holdout_locked = TRUE AND NEW.holdout_locked = TRUE THEN
    IF OLD.is_holdout      <> NEW.is_holdout      OR
       OLD.source_term_id  <> NEW.source_term_id
    THEN
      RAISE EXCEPTION
        'Cannot modify locked holdout term (project_term_id=%)', OLD.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_prevent_holdout_modification
  BEFORE UPDATE ON project_terms
  FOR EACH ROW EXECUTE FUNCTION prevent_holdout_modification();

-- =============================================================
-- SAMPLE CONFIGURATIONS (FR-05, FR-09, FR-10)
-- All prior configurations retained in audit log.
-- =============================================================

CREATE TABLE sample_configs (
  id                UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        UUID             NOT NULL REFERENCES projects(id),
  strategy          sampling_strategy NOT NULL,
  pareto_threshold  NUMERIC(5,4),    -- e.g. 0.80 for 80% cumulative frequency cutoff
  random_n          INTEGER,
  is_locked         BOOLEAN          NOT NULL DEFAULT FALSE,
  locked_at         TIMESTAMPTZ,
  created_by        UUID             NOT NULL REFERENCES users(id),
  created_at        TIMESTAMPTZ      NOT NULL DEFAULT now()
);

CREATE INDEX idx_sample_configs_project ON sample_configs(project_id);

-- =============================================================
-- REVIEWER CERTIFICATIONS (FR-94 – FR-99)
-- Hard gate: reviewers not certified for a terminology cannot
-- be added to a reviewer pool for that terminology.
-- =============================================================

CREATE TABLE reviewer_certifications (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  reviewer_id        UUID        NOT NULL REFERENCES users(id),
  terminology_id     UUID        NOT NULL REFERENCES terminologies(id),
  practice_set_score NUMERIC(5,4),
  attempt_count      INTEGER     NOT NULL DEFAULT 1,
  is_active          BOOLEAN     NOT NULL DEFAULT TRUE,
  granted_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ,
  granted_by         UUID        REFERENCES users(id),  -- NULL = system

  UNIQUE(reviewer_id, terminology_id)
);

CREATE INDEX idx_certs_reviewer    ON reviewer_certifications(reviewer_id);
CREATE INDEX idx_certs_terminology ON reviewer_certifications(terminology_id);

-- =============================================================
-- PRACTICE SETS & ATTEMPTS (FR-96, FR-97)
-- =============================================================

CREATE TABLE practice_sets (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  terminology_id  UUID        NOT NULL REFERENCES terminologies(id),
  name            TEXT        NOT NULL,
  passing_score   NUMERIC(4,3) NOT NULL DEFAULT 0.80,
  is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
  created_by      UUID        NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE practice_set_items (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_set_id  UUID        NOT NULL REFERENCES practice_sets(id),
  source_term      TEXT        NOT NULL,
  correct_code     TEXT        NOT NULL,
  correct_display  TEXT        NOT NULL,
  scoring_note     TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE practice_attempts (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_set_id  UUID        NOT NULL REFERENCES practice_sets(id),
  reviewer_id      UUID        NOT NULL REFERENCES users(id),
  score            NUMERIC(4,3),
  passed           BOOLEAN,
  attempted_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_practice_attempts_reviewer ON practice_attempts(reviewer_id);

-- =============================================================
-- REVIEWER POOLS (FR-22)
-- =============================================================

CREATE TABLE reviewer_pools (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   UUID        NOT NULL REFERENCES projects(id),
  reviewer_id  UUID        NOT NULL REFERENCES users(id),
  is_active    BOOLEAN     NOT NULL DEFAULT TRUE,
  added_by     UUID        NOT NULL REFERENCES users(id),
  added_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(project_id, reviewer_id)
);

CREATE INDEX idx_reviewer_pools_project  ON reviewer_pools(project_id);
CREATE INDEX idx_reviewer_pools_reviewer ON reviewer_pools(reviewer_id);

-- =============================================================
-- REVIEWER AVAILABILITY (FR-23)
-- =============================================================

CREATE TABLE reviewer_availability (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID        NOT NULL REFERENCES projects(id),
  reviewer_id     UUID        NOT NULL REFERENCES users(id),
  terms_per_day   INTEGER,
  hours_per_week  NUMERIC(5,2),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(project_id, reviewer_id)
);

-- =============================================================
-- REVIEWER AFFINITY SCORES (FR-25, FR-99)
-- Snapshots stored; recalculated incrementally after each
-- project completion.
-- =============================================================

CREATE TABLE reviewer_affinity_scores (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  reviewer_id     UUID        NOT NULL REFERENCES users(id),
  terminology_id  UUID        NOT NULL REFERENCES terminologies(id),
  score           NUMERIC(5,4) NOT NULL DEFAULT 0.5,
  computed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(reviewer_id, terminology_id)
);

-- =============================================================
-- REVIEWER ASSIGNMENTS (FR-24, Node 5 ALLOCATE)
-- Every term gets exactly 2 independent assignments.
-- Reviewers MUST NOT see each other's assignments.
-- Independence enforced here at the data layer.
-- =============================================================

CREATE TABLE reviewer_assignments (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_term_id  UUID        NOT NULL REFERENCES project_terms(id),
  reviewer_id      UUID        NOT NULL REFERENCES users(id),
  project_id       UUID        NOT NULL REFERENCES projects(id),
  assigned_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at       TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  is_active        BOOLEAN     NOT NULL DEFAULT TRUE,  -- FALSE if silently reassigned

  UNIQUE(project_term_id, reviewer_id)
);

CREATE INDEX idx_assignments_reviewer     ON reviewer_assignments(reviewer_id, project_id);
CREATE INDEX idx_assignments_project_term ON reviewer_assignments(project_term_id);

-- Enforce maximum 2 active assignments per project_term (FR-24)
CREATE OR REPLACE FUNCTION check_assignment_limit()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  active_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO active_count
    FROM reviewer_assignments
   WHERE project_term_id = NEW.project_term_id
     AND is_active = TRUE;
  IF active_count >= 2 THEN
    RAISE EXCEPTION
      'Term already has 2 active reviewer assignments (project_term_id=%)',
      NEW.project_term_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_check_assignment_limit
  BEFORE INSERT ON reviewer_assignments
  FOR EACH ROW EXECUTE FUNCTION check_assignment_limit();

-- =============================================================
-- MAPPING DECISIONS (immutable — FR-60, Section 7.6)
-- Corrections create new versioned records; prior records are
-- archived (is_current=FALSE) and never deleted.
-- =============================================================

CREATE TABLE mapping_decisions (
  id                    UUID               PRIMARY KEY DEFAULT gen_random_uuid(),
  project_term_id       UUID               NOT NULL REFERENCES project_terms(id),
  assignment_id         UUID               NOT NULL REFERENCES reviewer_assignments(id),
  reviewer_id           UUID               NOT NULL REFERENCES users(id),
  project_id            UUID               NOT NULL REFERENCES projects(id),

  is_unmappable         BOOLEAN            NOT NULL DEFAULT FALSE,
  unmappable_reason     TEXT,
  rationale             TEXT,
  is_ai_assisted        BOOLEAN            NOT NULL DEFAULT FALSE,  -- FR-37

  -- Versioning for corrections (FR-60)
  version               INTEGER            NOT NULL DEFAULT 1,
  superseded_by         UUID               REFERENCES mapping_decisions(id),
  is_current            BOOLEAN            NOT NULL DEFAULT TRUE,
  correction_pathway    correction_pathway,
  correction_rationale  TEXT,

  created_at            TIMESTAMPTZ        NOT NULL DEFAULT now()
  -- No updated_at: records are immutable. Use superseded_by chain.
);

CREATE INDEX idx_mapping_decisions_project_term ON mapping_decisions(project_term_id, is_current);
CREATE INDEX idx_mapping_decisions_reviewer     ON mapping_decisions(reviewer_id, project_id);

-- Prevent mutation of mapping_decisions (FR-60)
-- Only permitted operation: mark superseded (is_current FALSE → FALSE already invalid,
-- TRUE → FALSE allowed when setting superseded_by).
CREATE OR REPLACE FUNCTION prevent_mapping_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.is_current = TRUE AND NEW.is_current = FALSE
     AND NEW.superseded_by IS NOT NULL THEN
    RETURN NEW;  -- only allowed mutation: archive on correction
  END IF;
  RAISE EXCEPTION
    'mapping_decisions records are immutable (id=%)', OLD.id;
END;
$$;

CREATE TRIGGER trg_prevent_mapping_update
  BEFORE UPDATE ON mapping_decisions
  FOR EACH ROW EXECUTE FUNCTION prevent_mapping_update();

-- One-to-many target concepts per mapping decision (FR-20)
CREATE TABLE mapping_decision_targets (
  id                   UUID               PRIMARY KEY DEFAULT gen_random_uuid(),
  mapping_decision_id  UUID               NOT NULL REFERENCES mapping_decisions(id),
  target_code          TEXT               NOT NULL,
  target_display       TEXT               NOT NULL,
  relationship_type    mapping_relationship NOT NULL DEFAULT 'equivalent_to',
  created_at           TIMESTAMPTZ        NOT NULL DEFAULT now()
);

CREATE INDEX idx_mapping_targets_decision ON mapping_decision_targets(mapping_decision_id);

-- =============================================================
-- ADJUDICATION QUEUE (FR-53 – FR-55, Node 7)
-- =============================================================

CREATE TABLE adjudication_queue (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_term_id    UUID        NOT NULL REFERENCES project_terms(id),
  project_id         UUID        NOT NULL REFERENCES projects(id),
  mapping_decision_a UUID        NOT NULL REFERENCES mapping_decisions(id),
  mapping_decision_b UUID        NOT NULL REFERENCES mapping_decisions(id),
  adjudicator_id     UUID        REFERENCES users(id),
  status             TEXT        NOT NULL DEFAULT 'pending',  -- pending | in_progress | resolved
  resolved_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_adjudication_project     ON adjudication_queue(project_id, status);
CREATE INDEX idx_adjudication_adjudicator ON adjudication_queue(adjudicator_id, status);

CREATE TABLE adjudication_decisions (
  id                     UUID               PRIMARY KEY DEFAULT gen_random_uuid(),
  adjudication_queue_id  UUID               NOT NULL REFERENCES adjudication_queue(id),
  adjudicator_id         UUID               NOT NULL REFERENCES users(id),
  project_term_id        UUID               NOT NULL REFERENCES project_terms(id),
  is_unmappable          BOOLEAN            NOT NULL DEFAULT FALSE,
  rationale              TEXT,
  created_at             TIMESTAMPTZ        NOT NULL DEFAULT now()
);

CREATE TABLE adjudication_decision_targets (
  id                        UUID               PRIMARY KEY DEFAULT gen_random_uuid(),
  adjudication_decision_id  UUID               NOT NULL REFERENCES adjudication_decisions(id),
  target_code               TEXT               NOT NULL,
  target_display            TEXT               NOT NULL,
  relationship_type         mapping_relationship NOT NULL DEFAULT 'equivalent_to',
  created_at                TIMESTAMPTZ        NOT NULL DEFAULT now()
);

-- =============================================================
-- CANONICAL MAPPINGS (Node 8 CANONICALISE output, Section 7.6)
-- Immutable. Corrections create new versioned records.
-- Both reviewer-agreed and auto-matched terms land here.
-- =============================================================

CREATE TABLE canonical_mappings (
  id                        UUID               PRIMARY KEY DEFAULT gen_random_uuid(),
  project_term_id           UUID               NOT NULL REFERENCES project_terms(id),
  project_id                UUID               NOT NULL REFERENCES projects(id),
  source_term_id            UUID               NOT NULL REFERENCES source_terms(id),

  -- Source stored as original; upper-case applied at match time only (never persisted)
  source_text_original      TEXT               NOT NULL,

  -- Target (output convention: lower-case)
  target_code               TEXT               NOT NULL,
  target_display_lower      TEXT               NOT NULL,
  relationship_type         mapping_relationship NOT NULL,
  concept_type              concept_type,
  xml_tagged_output         TEXT,               -- e.g. <dx>diabetes mellitus</dx>

  -- Provenance
  is_auto_matched           BOOLEAN            NOT NULL DEFAULT FALSE,
  auto_match_basis          TEXT,               -- e.g. 'SNOMED_CT_FSN_EXACT'
  mapping_decision_id       UUID               REFERENCES mapping_decisions(id),
  adjudication_decision_id  UUID               REFERENCES adjudication_decisions(id),

  -- Versioning for corrections (FR-60)
  version                   INTEGER            NOT NULL DEFAULT 1,
  superseded_by             UUID               REFERENCES canonical_mappings(id),
  is_current                BOOLEAN            NOT NULL DEFAULT TRUE,

  created_at                TIMESTAMPTZ        NOT NULL DEFAULT now()
);

CREATE INDEX idx_canonical_project      ON canonical_mappings(project_id, is_current);
CREATE INDEX idx_canonical_source_code  ON canonical_mappings(source_term_id, is_current);
CREATE INDEX idx_canonical_target_code  ON canonical_mappings(target_code);

-- De-duplication cross-reference: high-cardinality source code lookups
-- must return within 100ms at 95th percentile (Section 7.6)
CREATE INDEX idx_canonical_dedup ON canonical_mappings(source_text_original, is_current)
  WHERE is_current = TRUE;

-- =============================================================
-- CONCEPT CLUSTERS (FR-62, FR-63)
-- One pattern per synonym group per target code.
-- =============================================================

CREATE TABLE concept_clusters (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID         NOT NULL REFERENCES projects(id),
  target_code     TEXT         NOT NULL,
  target_display  TEXT         NOT NULL,
  terminology_id  UUID         NOT NULL REFERENCES terminologies(id),
  concept_type    concept_type,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_clusters_project     ON concept_clusters(project_id);
CREATE INDEX idx_clusters_target_code ON concept_clusters(target_code, terminology_id);

CREATE TABLE concept_cluster_members (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  cluster_id           UUID        NOT NULL REFERENCES concept_clusters(id),
  canonical_mapping_id UUID        NOT NULL REFERENCES canonical_mappings(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(cluster_id, canonical_mapping_id)
);

-- =============================================================
-- REGEX PATTERNS (FR-62 – FR-72, Nodes 9–11)
-- Versioned. Each pattern carries version, author, timestamp,
-- cluster, and validation status (Section 7.6).
-- =============================================================

CREATE TABLE regex_patterns (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  cluster_id        UUID         NOT NULL REFERENCES concept_clusters(id),
  pattern_text      TEXT         NOT NULL,
  target_code       TEXT         NOT NULL,
  target_display    TEXT         NOT NULL,
  terminology_id    UUID         NOT NULL REFERENCES terminologies(id),
  layer             regex_layer  NOT NULL DEFAULT 'concept',

  -- Authorship
  authored_by       UUID         REFERENCES users(id),  -- NULL = AI agent
  is_ai_generated   BOOLEAN      NOT NULL DEFAULT FALSE,

  -- Versioning (FR-64, FR-71)
  version           INTEGER      NOT NULL DEFAULT 1,
  prior_version_id  UUID         REFERENCES regex_patterns(id),
  is_active         BOOLEAN      NOT NULL DEFAULT TRUE,

  -- Validation (FR-65, FR-66)
  validation_status TEXT         NOT NULL DEFAULT 'pending',  -- pending | validated | flagged | deprecated
  validated_by      UUID         REFERENCES users(id),
  validated_at      TIMESTAMPTZ,

  -- Metrics (Section 5.11)
  hit_rate          NUMERIC(7,4),
  last_hit_at       TIMESTAMPTZ,

  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_regex_patterns_cluster     ON regex_patterns(cluster_id);
CREATE INDEX idx_regex_patterns_active      ON regex_patterns(is_active, layer);
CREATE INDEX idx_regex_patterns_terminology ON regex_patterns(terminology_id, is_active);

-- Manually maintained corpora (negation, qualifier, manufacturer layers)
-- Imported and versioned by administrator (Section 5.10, Layers 2–4)
CREATE TABLE regex_corpus_imports (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  layer         regex_layer NOT NULL,
  pattern_text  TEXT        NOT NULL,
  replacement   TEXT,
  tag_type      TEXT,        -- e.g. 'neg' | 'qual' | 'strip'
  imported_by   UUID        NOT NULL REFERENCES users(id),
  version       INTEGER     NOT NULL DEFAULT 1,
  is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_corpus_imports_layer ON regex_corpus_imports(layer, is_active);

-- =============================================================
-- REGEX RUN REPORTS (Node 10 REGEX_VALIDATE, Section 5.11)
-- =============================================================

CREATE TABLE regex_runs (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id                  UUID        NOT NULL REFERENCES projects(id),
  canonical_mapping_id        UUID        REFERENCES canonical_mappings(id),
  pattern_id                  UUID        REFERENCES regex_patterns(id),
  ran_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ran_by                      UUID        REFERENCES users(id),  -- NULL = system

  -- Layer-by-layer outputs for R-03 view (Section 5.11.1)
  output_after_normalise      TEXT,
  output_after_negation       TEXT,
  output_after_qualifier      TEXT,
  output_after_manufacturer   TEXT,
  output_after_concept        TEXT,
  final_output                TEXT,

  -- Report flags
  has_residual_uppercase      BOOLEAN     NOT NULL DEFAULT FALSE,  -- R-01
  no_match                    BOOLEAN     NOT NULL DEFAULT FALSE,  -- R-02
  is_over_greedy              BOOLEAN     NOT NULL DEFAULT FALSE,
  greediness_ratio            NUMERIC(8,4),
  is_redundant                BOOLEAN     NOT NULL DEFAULT FALSE,
  match_position              TEXT,    -- 'start' | 'middle' | 'end'
  match_start_offset          INTEGER,
  match_length                INTEGER,
  replacement_length          INTEGER
);

CREATE INDEX idx_regex_runs_project ON regex_runs(project_id);
CREATE INDEX idx_regex_runs_pattern ON regex_runs(pattern_id);

-- =============================================================
-- HOLDOUT SCORING (FR-15, FR-16, Node 12 SCORE)
-- =============================================================

CREATE TABLE holdout_scoring_sessions (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID        NOT NULL REFERENCES projects(id),
  triggered_by  UUID        NOT NULL REFERENCES users(id),
  triggered_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  status        TEXT        NOT NULL DEFAULT 'pending',  -- pending | in_progress | complete
  completed_at  TIMESTAMPTZ
);

CREATE TABLE holdout_labels (
  id                  UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
  scoring_session_id  UUID             NOT NULL REFERENCES holdout_scoring_sessions(id),
  project_term_id     UUID             NOT NULL REFERENCES project_terms(id),
  reviewer_id         UUID             NOT NULL REFERENCES users(id),
  score               validation_score NOT NULL,
  created_at          TIMESTAMPTZ      NOT NULL DEFAULT now(),

  UNIQUE(scoring_session_id, project_term_id, reviewer_id)
);

CREATE TABLE holdout_results (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  scoring_session_id  UUID        NOT NULL REFERENCES holdout_scoring_sessions(id),
  project_id          UUID        NOT NULL REFERENCES projects(id),
  true_positives      INTEGER     NOT NULL,
  false_positives     INTEGER     NOT NULL,
  true_negatives      INTEGER     NOT NULL,
  false_negatives     INTEGER     NOT NULL,
  precision_score     NUMERIC(6,4),
  recall_score        NUMERIC(6,4),
  f1_score            NUMERIC(6,4),
  precision_ci_low    NUMERIC(6,4),
  precision_ci_high   NUMERIC(6,4),
  recall_ci_low       NUMERIC(6,4),
  recall_ci_high      NUMERIC(6,4),
  f1_ci_low           NUMERIC(6,4),
  f1_ci_high          NUMERIC(6,4),
  f1_threshold        NUMERIC(4,3),
  passed_threshold    BOOLEAN,
  computed_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================================
-- EXPORTS (FR-100 – FR-105, Node 13)
-- =============================================================

CREATE TABLE exports (
  id                   UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id           UUID          NOT NULL REFERENCES projects(id),
  format               export_format NOT NULL,
  exported_by          UUID          NOT NULL REFERENCES users(id),
  exported_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  file_key             TEXT,          -- S3 object key
  includes_superseded  BOOLEAN       NOT NULL DEFAULT FALSE,
  provenance_block     JSONB          -- snapshot: project name, reviewer IDs (hashed), terminology version, OmniMap version
);

CREATE INDEX idx_exports_project ON exports(project_id);

-- =============================================================
-- REVIEWER PREFERENCES (FR-40, FR-50)
-- =============================================================

CREATE TABLE reviewer_preferences (
  reviewer_id          UUID        PRIMARY KEY REFERENCES users(id),
  font_size            TEXT        NOT NULL DEFAULT 'medium',
  display_density      TEXT        NOT NULL DEFAULT 'normal',
  default_search_mode  TEXT        NOT NULL DEFAULT 'free_text',
  keyboard_shortcuts   JSONB       NOT NULL DEFAULT '{}',
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================================
-- AUDIT LOG (FR-19, Section 7.6)
-- Append-only. UPDATE and DELETE are blocked at the trigger
-- level. Records retained for minimum 7 years.
-- =============================================================

CREATE TABLE audit_log (
  id           BIGSERIAL   PRIMARY KEY,       -- sequential for ordering
  event_id     UUID        NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  user_id      UUID        REFERENCES users(id),  -- NULL for system events
  system_flag  TEXT,        -- e.g. 'AUTO_MATCH' | 'LOAD_BALANCER' | 'SYSTEM'
  action       TEXT        NOT NULL,           -- e.g. 'PROJECT_CREATED' | 'MAPPING_SUBMITTED'
  entity_type  TEXT        NOT NULL,           -- e.g. 'project' | 'mapping_decision'
  entity_id    UUID,
  project_id   UUID,                           -- denormalized for fast per-project log queries
  payload      JSONB,                          -- full event details / before+after snapshot
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Hot path: per-project log queries
CREATE INDEX idx_audit_log_project  ON audit_log(project_id, occurred_at DESC);
CREATE INDEX idx_audit_log_user     ON audit_log(user_id, occurred_at DESC);
CREATE INDEX idx_audit_log_entity   ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_log_occurred ON audit_log(occurred_at DESC);

-- Block all mutations on audit_log (Section 7.6, FR-19)
CREATE OR REPLACE FUNCTION prevent_audit_modification()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only. UPDATE and DELETE are not permitted.';
END;
$$;

CREATE TRIGGER trg_audit_no_update
  BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_modification();

CREATE TRIGGER trg_audit_no_delete
  BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_modification();

COMMIT;
