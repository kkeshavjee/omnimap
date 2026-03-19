// OmniMap — Domain Model Types
// Row types mirroring the database schema in 001_initial_schema.sql.
// All timestamps are UTC ISO-8601 strings (TIMESTAMPTZ → string in JS).

import {
  CorrectionPathway,
  ConceptType,
  ExportFormat,
  MappingRelationship,
  ProjectStatus,
  ProjectType,
  RegexLayer,
  SamplingStrategy,
  TermStatus,
  UserRole,
  ValidationScore,
} from './enums';

// =============================================================
// USERS
// =============================================================

export interface User {
  id:           string;
  cognitoSub:   string;
  email:        string;
  displayName:  string;
  role:         UserRole;
  isActive:     boolean;
  mfaEnabled:   boolean;
  createdAt:    string;
  updatedAt:    string;
}

// =============================================================
// TERMINOLOGIES
// =============================================================

export interface Terminology {
  id:           string;
  code:         string;
  displayName:  string;
  version:      string | null;
  isActive:     boolean;
  createdAt:    string;
}

// =============================================================
// PROJECTS
// =============================================================

export interface Project {
  id:                          string;
  name:                        string;
  description:                 string | null;
  projectType:                 ProjectType;
  sourceTerminologyId:         string | null;
  targetTerminologyId:         string;
  status:                      ProjectStatus;
  currentDagNode:              string | null;

  // Power calculation parameters (FR-11)
  powerF1Threshold:            number;
  powerAlpha:                  number;
  powerBeta:                   number;
  computedHoldoutN:            number | null;

  // Configurable thresholds
  greedinesRatioThreshold:     number;
  nearDuplicateEditDistance:   number;

  // Lock timestamps
  sampleLockedAt:              string | null;
  holdoutLockedAt:             string | null;
  targetTerminologyLockedAt:   string | null;

  // Version validation fields
  priorTerminologyVersion:     string | null;
  newTerminologyVersion:       string | null;

  createdBy:    string;
  createdAt:    string;
  updatedAt:    string;
}

// =============================================================
// EMR EXTRACTS
// =============================================================

export interface EmrExtract {
  id:           string;
  projectId:    string;
  filename:     string;
  totalRows:    number | null;
  status:       'processing' | 'ready' | 'error';
  errorMessage: string | null;
  uploadedBy:   string;
  uploadedAt:   string;
}

// =============================================================
// SOURCE TERMS
// =============================================================

export interface SourceTerm {
  id:                   string;
  extractId:            string;
  projectId:            string;
  sourceCode:           string;
  displayTerm:          string;
  frequency:            number | null;
  clinicalDomain:       string | null;
  sourceTerminologyId:  string | null;
  isOutOfPlace:         boolean;
  createdAt:            string;
}

// =============================================================
// EXTERNAL MAPPING IMPORTS (Node 0 — read-only reference)
// =============================================================

export interface ExternalMappingImport {
  id:             string;
  projectId:      string;
  sourceCode:     string;
  displayTerm:    string;
  targetCode:     string;
  targetDisplay:  string;
  terminologyId:  string | null;
  importedBy:     string;
  importedAt:     string;
}

// =============================================================
// PROJECT TERMS
// =============================================================

export interface ProjectTerm {
  id:                           string;
  projectId:                    string;
  sourceTermId:                 string;
  status:                       TermStatus;

  isHoldout:                    boolean;
  holdoutLocked:                boolean;
  holdoutLockedAt:              string | null;

  isAutoMatched:                boolean;
  autoMatchedAt:                string | null;
  autoMatchedFsn:               string | null;

  alreadyMappedByProjectId:     string | null;

  longTailPriorityScore:        number | null;
  frequencyTrend:               number | null;
  domainRiskFlag:               boolean;

  createdAt:                    string;
  updatedAt:                    string;
}

// =============================================================
// SAMPLE CONFIGS
// =============================================================

export interface SampleConfig {
  id:               string;
  projectId:        string;
  strategy:         SamplingStrategy;
  paretoThreshold:  number | null;
  randomN:          number | null;
  isLocked:         boolean;
  lockedAt:         string | null;
  createdBy:        string;
  createdAt:        string;
}

// =============================================================
// REVIEWER CERTIFICATIONS
// =============================================================

export interface ReviewerCertification {
  id:                string;
  reviewerId:        string;
  terminologyId:     string;
  practiceSetScore:  number | null;
  attemptCount:      number;
  isActive:          boolean;
  grantedAt:         string;
  expiresAt:         string | null;
  grantedBy:         string | null;
}

// =============================================================
// PRACTICE SETS
// =============================================================

export interface PracticeSet {
  id:             string;
  terminologyId:  string;
  name:           string;
  passingScore:   number;
  isActive:       boolean;
  createdBy:      string;
  createdAt:      string;
}

export interface PracticeSetItem {
  id:             string;
  practiceSetId:  string;
  sourceTerm:     string;
  correctCode:    string;
  correctDisplay: string;
  scoringNote:    string | null;
  createdAt:      string;
}

export interface PracticeAttempt {
  id:             string;
  practiceSetId:  string;
  reviewerId:     string;
  score:          number | null;
  passed:         boolean | null;
  attemptedAt:    string;
}

// =============================================================
// REVIEWER POOLS & AVAILABILITY
// =============================================================

export interface ReviewerPool {
  id:          string;
  projectId:   string;
  reviewerId:  string;
  isActive:    boolean;
  addedBy:     string;
  addedAt:     string;
}

export interface ReviewerAvailability {
  id:            string;
  projectId:     string;
  reviewerId:    string;
  termsPerDay:   number | null;
  hoursPerWeek:  number | null;
  updatedAt:     string;
}

export interface ReviewerAffinityScore {
  id:             string;
  reviewerId:     string;
  terminologyId:  string;
  score:          number;
  computedAt:     string;
}

// =============================================================
// REVIEWER ASSIGNMENTS
// =============================================================

export interface ReviewerAssignment {
  id:              string;
  projectTermId:   string;
  reviewerId:      string;
  projectId:       string;
  assignedAt:      string;
  startedAt:       string | null;
  completedAt:     string | null;
  isActive:        boolean;
}

// =============================================================
// MAPPING DECISIONS (immutable)
// =============================================================

export interface MappingDecision {
  id:                  string;
  projectTermId:       string;
  assignmentId:        string;
  reviewerId:          string;
  projectId:           string;
  isUnmappable:        boolean;
  unmappableReason:    string | null;
  rationale:           string | null;
  isAiAssisted:        boolean;
  version:             number;
  supersededBy:        string | null;
  isCurrent:           boolean;
  correctionPathway:   CorrectionPathway | null;
  correctionRationale: string | null;
  createdAt:           string;
}

export interface MappingDecisionTarget {
  id:                 string;
  mappingDecisionId:  string;
  targetCode:         string;
  targetDisplay:      string;
  relationshipType:   MappingRelationship;
  createdAt:          string;
}

// =============================================================
// ADJUDICATION
// =============================================================

export interface AdjudicationQueueItem {
  id:               string;
  projectTermId:    string;
  projectId:        string;
  mappingDecisionA: string;
  mappingDecisionB: string;
  adjudicatorId:    string | null;
  status:           'pending' | 'in_progress' | 'resolved';
  resolvedAt:       string | null;
  createdAt:        string;
}

export interface AdjudicationDecision {
  id:                   string;
  adjudicationQueueId:  string;
  adjudicatorId:        string;
  projectTermId:        string;
  isUnmappable:         boolean;
  rationale:            string | null;
  createdAt:            string;
}

export interface AdjudicationDecisionTarget {
  id:                      string;
  adjudicationDecisionId:  string;
  targetCode:              string;
  targetDisplay:           string;
  relationshipType:        MappingRelationship;
  createdAt:               string;
}

// =============================================================
// CANONICAL MAPPINGS (Node 8 output, immutable)
// =============================================================

export interface CanonicalMapping {
  id:                       string;
  projectTermId:            string;
  projectId:                string;
  sourceTermId:             string;
  sourceTextOriginal:       string;   // stored as-is; upper-case only at match time
  targetCode:               string;
  targetDisplayLower:       string;   // lower-case per output convention
  relationshipType:         MappingRelationship;
  conceptType:              ConceptType | null;
  xmlTaggedOutput:          string | null;  // e.g. <dx>diabetes mellitus</dx>
  isAutoMatched:            boolean;
  autoMatchBasis:           string | null;
  mappingDecisionId:        string | null;
  adjudicationDecisionId:   string | null;
  version:                  number;
  supersededBy:             string | null;
  isCurrent:                boolean;
  createdAt:                string;
}

// =============================================================
// CONCEPT CLUSTERS
// =============================================================

export interface ConceptCluster {
  id:             string;
  projectId:      string;
  targetCode:     string;
  targetDisplay:  string;
  terminologyId:  string;
  conceptType:    ConceptType | null;
  createdAt:      string;
  updatedAt:      string;
}

export interface ConceptClusterMember {
  id:                 string;
  clusterId:          string;
  canonicalMappingId: string;
  createdAt:          string;
}

// =============================================================
// REGEX PATTERNS
// =============================================================

export interface RegexPattern {
  id:               string;
  clusterId:        string;
  patternText:      string;
  targetCode:       string;
  targetDisplay:    string;
  terminologyId:    string;
  layer:            RegexLayer;
  authoredBy:       string | null;  // null = AI agent
  isAiGenerated:    boolean;
  version:          number;
  priorVersionId:   string | null;
  isActive:         boolean;
  validationStatus: 'pending' | 'validated' | 'flagged' | 'deprecated';
  validatedBy:      string | null;
  validatedAt:      string | null;
  hitRate:          number | null;
  lastHitAt:        string | null;
  createdAt:        string;
  updatedAt:        string;
}

export interface RegexCorpusImport {
  id:           string;
  layer:        RegexLayer;
  patternText:  string;
  replacement:  string | null;
  tagType:      string | null;
  importedBy:   string;
  version:      number;
  isActive:     boolean;
  createdAt:    string;
}

// =============================================================
// REGEX RUN REPORTS
// =============================================================

export interface RegexRun {
  id:                       string;
  projectId:                string;
  canonicalMappingId:       string | null;
  patternId:                string | null;
  ranAt:                    string;
  ranBy:                    string | null;
  outputAfterNormalise:     string | null;
  outputAfterNegation:      string | null;
  outputAfterQualifier:     string | null;
  outputAfterManufacturer:  string | null;
  outputAfterConcept:       string | null;
  finalOutput:              string | null;
  hasResidualUppercase:     boolean;   // R-01
  noMatch:                  boolean;   // R-02
  isOverGreedy:             boolean;
  greedinesRatio:           number | null;
  isRedundant:              boolean;
  matchPosition:            'start' | 'middle' | 'end' | null;
  matchStartOffset:         number | null;
  matchLength:              number | null;
  replacementLength:        number | null;
}

// =============================================================
// HOLDOUT SCORING
// =============================================================

export interface HoldoutScoringSession {
  id:           string;
  projectId:    string;
  triggeredBy:  string;
  triggeredAt:  string;
  status:       'pending' | 'in_progress' | 'complete';
  completedAt:  string | null;
}

export interface HoldoutLabel {
  id:                string;
  scoringSessionId:  string;
  projectTermId:     string;
  reviewerId:        string;
  score:             ValidationScore;
  createdAt:         string;
}

export interface HoldoutResult {
  id:                string;
  scoringSessionId:  string;
  projectId:         string;
  truePositives:     number;
  falsePositives:    number;
  trueNegatives:     number;
  falseNegatives:    number;
  precisionScore:    number | null;
  recallScore:       number | null;
  f1Score:           number | null;
  precisionCiLow:    number | null;
  precisionCiHigh:   number | null;
  recallCiLow:       number | null;
  recallCiHigh:      number | null;
  f1CiLow:           number | null;
  f1CiHigh:          number | null;
  f1Threshold:       number;
  passedThreshold:   boolean | null;
  computedAt:        string;
}

// =============================================================
// EXPORTS
// =============================================================

export interface Export {
  id:                 string;
  projectId:          string;
  format:             ExportFormat;
  exportedBy:         string;
  exportedAt:         string;
  fileKey:            string | null;
  includesSuperseded: boolean;
  provenanceBlock:    Record<string, unknown> | null;
}

// =============================================================
// REVIEWER PREFERENCES
// =============================================================

export interface ReviewerPreferences {
  reviewerId:         string;
  fontSize:           'small' | 'medium' | 'large';
  displayDensity:     'compact' | 'normal' | 'comfortable';
  defaultSearchMode:  'free_text' | 'ecl' | 'code';
  keyboardShortcuts:  Record<string, string>;
  updatedAt:          string;
}

// =============================================================
// AUDIT LOG
// =============================================================

export interface AuditLogEntry {
  id:          number;   // BIGSERIAL — sequential
  eventId:     string;
  userId:      string | null;
  systemFlag:  string | null;
  action:      string;
  entityType:  string;
  entityId:    string | null;
  projectId:   string | null;
  payload:     Record<string, unknown> | null;
  occurredAt:  string;
}
