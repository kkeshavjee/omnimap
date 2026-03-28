// OmniMap — Domain Enumerations
// Mirror of database ENUMs in 001_initial_schema.sql.
// Keep in sync with the migration — do not add values here
// without a corresponding ALTER TYPE migration.

export enum UserRole {
  Administrator = 'administrator',
  Reviewer      = 'reviewer',
  Adjudicator   = 'adjudicator',
  Auditor       = 'auditor',
}

export enum ProjectType {
  StandardMapping       = 'standard_mapping',
  AutomationEvaluation  = 'automation_evaluation',
  VersionValidation     = 'version_validation',
}

export enum ProjectStatus {
  Init            = 'init',
  Ingesting       = 'ingesting',
  Deduplicating   = 'deduplicating',
  Sampling        = 'sampling',
  HoldoutDraw     = 'holdout_draw',
  Automatch       = 'automatch',
  Allocating      = 'allocating',
  Mapping         = 'mapping',
  Adjudicating    = 'adjudicating',
  Canonicalising  = 'canonicalising',
  RegexPipeline   = 'regex_pipeline',
  RegexValidate   = 'regex_validate',
  CorpusUpdate    = 'corpus_update',
  Scoring         = 'scoring',
  Exporting       = 'exporting',
  Complete        = 'complete',
  Archived        = 'archived',
}

export enum TermStatus {
  Raw                 = 'raw',
  AlreadyMapped       = 'already_mapped',
  OutOfPlace          = 'out_of_place',
  NetNewQueued        = 'net_new_queued',
  LongTailQueued      = 'long_tail_queued',
  Sampled             = 'sampled',
  Holdout             = 'holdout',
  AutoMatched         = 'auto_matched',
  Allocated           = 'allocated',
  MappingInProgress   = 'mapping_in_progress',
  Agreed              = 'agreed',
  AdjudicationQueued  = 'adjudication_queued',
  Adjudicated         = 'adjudicated',
  Canonicalised       = 'canonicalised',
}

export enum MappingRelationship {
  EquivalentTo  = 'equivalent_to',
  BroaderThan   = 'broader_than',
  NarrowerThan  = 'narrower_than',
  RelatedTo     = 'related_to',
  NotMappable   = 'not_mappable',
}

// Four-point validation scoring scheme — maps directly to confusion matrix (FR-73–FR-76)
export enum ValidationScore {
  TrueNegative  = '0',  // Correctly not coded
  TruePositive  = '1',  // Correctly coded
  FalsePositive = '2',  // Incorrectly coded
  FalseNegative = '3',  // Incorrectly not coded
}

export enum ConceptType {
  Diagnosis   = 'diagnosis',
  Medication  = 'medication',
  Procedure   = 'procedure',
  Lab         = 'lab',
  Symptom     = 'symptom',
  Allergy     = 'allergy',
  Device      = 'device',
  RiskFactor  = 'risk_factor',
}

export enum RegexLayer {
  Normalise     = 'normalise',
  Negation      = 'negation',
  Qualifier     = 'qualifier',
  Manufacturer  = 'manufacturer',
  Concept       = 'concept',
}

export enum CorrectionPathway {
  Reopen         = 'reopen',
  DirectOverride = 'direct_override',
}

export enum ExportFormat {
  FhirR4    = 'fhir_r4',
  FhirR5    = 'fhir_r5',
  RegexJson = 'regex_json',
  Csv       = 'csv',
  Excel     = 'excel',
  Pdf       = 'pdf',
}

export enum SamplingStrategy {
  Random      = 'random',
  Stratified  = 'stratified',
  Frequency   = 'frequency',
  Pareto      = 'pareto',
}

// SNOMED Gap reason codes — PRD v2.4 §5.7, FR-108
// Mirrors gap_reason_code ENUM in migration 005_snomed_gap.sql
export enum GapReasonCode {
  TooSpecific     = 'GAP-01',  // Concept exists at broader level only
  LocalAbbrev     = 'GAP-02',  // No standard equivalent exists
  CompoundConcept = 'GAP-03',  // Conflates 2+ SNOMED concepts; no pre-coordinated equivalent
  NovelConcept    = 'GAP-04',  // Genuinely absent from current SNOMED CT release
  DataQuality     = 'GAP-05',  // Not a clinical concept (free-text note, transcription artefact)
  Other           = 'GAP-06',  // Free-text rationale required
}

export const GAP_REASON_LABELS: Record<GapReasonCode, string> = {
  [GapReasonCode.TooSpecific]:     'Too specific — no sufficiently granular SNOMED CT concept',
  [GapReasonCode.LocalAbbrev]:     'Local abbreviation — no standard equivalent',
  [GapReasonCode.CompoundConcept]: 'Compound concept — conflates 2+ SNOMED CT concepts',
  [GapReasonCode.NovelConcept]:    'Novel clinical concept — absent from current release',
  [GapReasonCode.DataQuality]:     'Data quality issue — not a clinical concept',
  [GapReasonCode.Other]:           'Other — rationale required',
};
