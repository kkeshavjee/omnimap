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
