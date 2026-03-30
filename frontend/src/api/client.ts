// OmniMap — Typed API Client
// Injects the Cognito access token on every request.
// All methods throw on non-2xx responses with a structured error.

import { fetchAuthSession } from 'aws-amplify/auth';

// -----------------------------------------------------------------
// Shared domain types (mirrors backend models)
// -----------------------------------------------------------------

// -----------------------------------------------------------------
// Qualifier Pattern types
// -----------------------------------------------------------------

export type QualifierCategory =
  | 'negation'
  | 'stop_word'
  | 'location'
  | 'timing'
  | 'family_history'
  | 'causation'
  | 'screening';

export type QualifierAction = 'tag' | 'ignore' | 'detect' | 'screening';

export interface QualifierPattern {
  id:             string;
  category:       QualifierCategory;
  patternText:    string;
  flags:          string;
  replaceWith:    string | null;
  prefix:         string | null;
  suffix:         string | null;
  canonicalLabel: string | null;
  action:         QualifierAction;
  sortOrder:      number;
  sourceFile:     string | null;
  sourceRow:      number | null;
  isActive:       boolean;
  version:        number;
  createdAt:      string;
  updatedAt:      string;
}

export interface CreateQualifierPatternInput {
  category:       QualifierCategory;
  patternText:    string;
  flags?:         string;
  replaceWith?:   string;
  prefix?:        string;
  suffix?:        string;
  canonicalLabel?: string;
  action?:        QualifierAction;
  sortOrder?:     number;
}

export interface UpdateQualifierPatternInput {
  patternText?:   string;
  flags?:         string;
  replaceWith?:   string;
  prefix?:        string;
  suffix?:        string;
  canonicalLabel?: string;
  action?:        QualifierAction;
  sortOrder?:     number;
  isActive?:      boolean;
}

// -----------------------------------------------------------------
// User management types
// -----------------------------------------------------------------

export type UserRole = 'administrator' | 'reviewer' | 'adjudicator' | 'auditor';

export interface OmniMapUser {
  id:          string;
  cognitoSub:  string;
  email:       string;
  displayName: string;
  role:        UserRole;
  isActive:    boolean;
  mfaEnabled:  boolean;
  createdAt:   string;
  updatedAt:   string;
}

export interface InviteUserInput {
  email:       string;
  displayName: string;
  role:        UserRole;
}

export interface ImportResult {
  inserted:    number;
  deactivated: number;
  sourceFile:  string;
}

export interface AuditLogEntry {
  id:          number;
  eventId:     string;
  userId:      string | null;
  userEmail:   string | null;
  systemFlag:  string | null;
  action:      string;
  entityType:  string;
  entityId:    string | null;
  projectId:   string | null;
  projectName: string | null;
  payload:     Record<string, unknown> | null;
  occurredAt:  string;
}

export interface SnomedParentConcept {
  code:    string;
  display: string;
}

export interface ConceptSearchResult {
  targetCode:       string;
  targetDisplay:    string;
  relationshipType: MappingRelationship;
  usageCount:       number;
  source?:          string;
  /** Immediate parent concepts in the SNOMED IS-A hierarchy */
  parents?:         SnomedParentConcept[];
  /** SNOMED semantic tag from the FSN, e.g. "disorder", "finding", "procedure" */
  semanticTag?:     string | null;
}

export interface AdjudicationDecision {
  decisionId:    string;
  isUnmappable:  boolean;
  gapReasonCode: GapReasonCode | null;
  rationale:     string | null;
  targets:       Array<{ targetCode: string; targetDisplay: string; relationshipType: string }>;
}

export interface AdjudicationQueueItem {
  queueItemId:   string;
  projectTermId: string;
  sourceCode:    string;
  displayTerm:   string;
  frequency:     number | null;
  clinicalDomain: string | null;
  status:        string;
  createdAt:     string;
  decisionA:     AdjudicationDecision | null;
  decisionB:     AdjudicationDecision | null;
}

export type ProjectType =
  | 'standard_mapping'
  | 'automation_evaluation'
  | 'version_validation';

export type ProjectStatus =
  | 'init' | 'ingesting' | 'deduplicating' | 'sampling'
  | 'holdout_draw' | 'automatch' | 'allocating' | 'mapping'
  | 'adjudicating' | 'canonicalising' | 'regex_pipeline'
  | 'regex_validate' | 'corpus_update' | 'scoring' | 'exporting'
  | 'complete' | 'archived';

export type TermStatus =
  | 'raw' | 'already_mapped' | 'out_of_place' | 'net_new_queued'
  | 'long_tail_queued' | 'sampled' | 'holdout' | 'auto_matched'
  | 'allocated' | 'mapping_in_progress' | 'agreed'
  | 'adjudication_queued' | 'adjudicated' | 'canonicalised';

export type MappingRelationship =
  | 'equivalent_to' | 'broader_than' | 'narrower_than'
  | 'related_to'    | 'not_mappable';

// SNOMED Gap reason codes — mirrors backend GapReasonCode enum (FR-108)
export type GapReasonCode =
  | 'GAP-01'   // Too specific: concept exists at broader level only
  | 'GAP-02'   // Local abbreviation: no standard equivalent
  | 'GAP-03'   // Compound concept: conflates 2+ SNOMED concepts
  | 'GAP-04'   // Novel clinical concept: genuinely absent from current release
  | 'GAP-05'   // Data quality: not a clinical concept
  | 'GAP-06';  // Other: free-text rationale required

export const GAP_REASON_LABELS: Record<GapReasonCode, string> = {
  'GAP-01': 'Too specific — no sufficiently granular SNOMED CT concept',
  'GAP-02': 'Local abbreviation — no standard equivalent',
  'GAP-03': 'Compound concept — conflates 2+ SNOMED CT concepts',
  'GAP-04': 'Novel clinical concept — absent from current release',
  'GAP-05': 'Data quality issue — not a clinical concept',
  'GAP-06': 'Other — rationale required',
};

export interface GapReportRow {
  sourceCode:    string;
  displayTerm:   string;
  frequency:     number | null;
  clinicalDomain: string | null;
  gapReasonCode: GapReasonCode | null;
  confirmedDate: string;
}

export interface Project {
  id:                    string;
  name:                  string;
  description:           string | null;
  projectType:           ProjectType;
  sourceTerminologyId:   string | null;
  targetTerminologyId:   string;
  status:                ProjectStatus;
  currentDagNode:        string | null;
  powerF1Threshold:      number;
  powerAlpha:            number;
  powerBeta:             number;
  computedHoldoutN:      number | null;
  greedinesRatioThreshold:    number;
  nearDuplicateEditDistance:  number;
  sampleLockedAt:        string | null;
  holdoutLockedAt:       string | null;
  sampleConfigId:        string | null;
  sampleSize:            number | null;
  createdBy:             string;
  createdAt:             string;
  updatedAt:             string;
}

export interface ReviewerPoolMember {
  id:           string;
  email:        string;
  displayName:  string;
  inPool:       boolean;
  termsPerDay:  number | null;
  hoursPerWeek: number | null;
}

export interface Terminology {
  id:          string;
  code:        string;
  displayName: string;
  version:     string | null;
  isActive:    boolean;
}

export interface ReviewerAssignment {
  id:            string;
  projectTermId: string;
  reviewerId:    string;
  projectId:     string;
  assignedAt:    string;
  startedAt:     string | null;
  completedAt:   string | null;
  isActive:      boolean;
}

export interface AssignedTerm {
  assignmentId:    string;
  projectTermId:   string;
  sourceCode:      string;
  displayTerm:     string;
  frequency:       number | null;
  clinicalDomain:  string | null;
  status:          TermStatus;
}

export interface MappingTarget {
  targetCode:       string;
  targetDisplay:    string;
  relationshipType: MappingRelationship;
}

export interface CreateProjectInput {
  name:                     string;
  description?:             string;
  projectType:              ProjectType;
  sourceTerminologyId?:     string;
  targetTerminologyId:      string;
  powerF1Threshold?:        number;
  powerAlpha?:              number;
  powerBeta?:               number;
}

export interface SubmitMappingInput {
  assignmentId:  string;
  projectTermId: string;
  isUnmappable:  boolean;
  gapReasonCode?: GapReasonCode;
  targets:       MappingTarget[];
  rationale?:    string;
  isAiAssisted?: boolean;
}

// -----------------------------------------------------------------
// HTTP helper
// -----------------------------------------------------------------

async function getToken(): Promise<string> {
  if (import.meta.env.VITE_AUTH_BYPASS === 'true') return 'dev-bypass-token';
  const session = await fetchAuthSession();
  const token   = session.tokens?.idToken?.toString();
  if (!token) throw new Error('Not authenticated');
  return token;
}

async function request<T>(
  method: string,
  path:   string,
  body?:  unknown,
): Promise<T> {
  const token = await getToken();
  const res   = await fetch(`/api${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw Object.assign(new Error(err.error ?? 'API error'), { status: res.status });
  }
  return res.json() as Promise<T>;
}

async function upload<T>(path: string, formData: FormData): Promise<T> {
  const token = await getToken();
  const res   = await fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
    body: formData,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw Object.assign(new Error(err.error ?? 'API error'), { status: res.status });
  }
  return res.json() as Promise<T>;
}

// -----------------------------------------------------------------
// API surface
// -----------------------------------------------------------------

export const api = {
  // Terminologies
  terminologies: {
    list: () => request<Terminology[]>('GET', '/terminologies'),
  },

  // Projects
  projects: {
    list:   ()          => request<Project[]>('GET', '/projects'),
    get:    (id: string) => request<Project>('GET',  `/projects/${id}`),
    create: (data: CreateProjectInput) =>
      request<{ project: Project }>('POST', '/projects', data),

    ingest: (projectId: string, file: File) => {
      const fd = new FormData();
      fd.append('file', file);
      return upload<{ extractId: string; totalRows: number; skippedRows: number }>(
        `/projects/${projectId}/ingest`, fd,
      );
    },

    deduplicate: (projectId: string) =>
      request<{ alreadyMapped: number; netNewQueued: number; forwardedToSample: number }>(
        'POST', `/projects/${projectId}/deduplicate`,
      ),

    sample: (projectId: string, strategy: string, paretoThreshold?: number, randomN?: number) =>
      request<{ sampled: number; longTailQueued: number }>(
        'POST', `/projects/${projectId}/sample`,
        { strategy, paretoThreshold, randomN },
      ),

    holdout: (projectId: string) =>
      request<{ holdoutN: number; holdoutDrawn: number; autoMatched: number; toAllocate: number }>(
        'POST', `/projects/${projectId}/holdout`,
      ),

    allocate: (projectId: string) =>
      request<{ termsAllocated: number; longTailAllocated: number; assignmentsCreated: number }>(
        'POST', `/projects/${projectId}/allocate`,
      ),

    canonicalise: (projectId: string) =>
      request<{ canonicalised: number; skipped: number }>(
        'POST', `/projects/${projectId}/canonicalise`,
      ),

    exportJson: async (projectId: string): Promise<{ projectId: string; exportedAt: string; rows: unknown[] }> => {
      return request(`GET`, `/projects/${projectId}/export?format=json`);
    },

    exportCsvUrl: (projectId: string) => `/api/projects/${projectId}/export?format=csv`,

    gapReport: (projectId: string) =>
      request<{ projectId: string; exportedAt: string; total: number; rows: GapReportRow[] }>(
        'GET', `/projects/${projectId}/gap-report`,
      ),

    gapReportCsvUrl: (projectId: string) => `/api/projects/${projectId}/gap-report?format=csv`,

    reviewerPool: {
      list:   (projectId: string) =>
        request<ReviewerPoolMember[]>('GET', `/projects/${projectId}/reviewer-pool`),
      add:    (projectId: string, reviewerId: string) =>
        request<{ ok: boolean }>('POST', `/projects/${projectId}/reviewer-pool`, { reviewerId }),
      remove: (projectId: string, reviewerId: string) =>
        request<{ ok: boolean }>('DELETE', `/projects/${projectId}/reviewer-pool/${reviewerId}`),
    },
  },

  // Adjudicator
  adjudicator: {
    queue:  (projectId: string) =>
      request<AdjudicationQueueItem[]>('GET', `/adjudicator/${projectId}/queue`),

    stats:  (projectId: string) =>
      request<{ pending: number; resolved: number; total: number }>('GET', `/adjudicator/${projectId}/stats`),

    resolve: (projectId: string, itemId: string, data: {
      isUnmappable:      boolean;
      gapReasonCode?:    GapReasonCode;
      targets?:          Array<{ targetCode: string; targetDisplay: string; relationshipType: string }>;
      rationale?:        string;
      acceptDecisionId?: string;
    }) => request<{ adjudicationDecisionId: string }>(
      'POST', `/adjudicator/${projectId}/resolve/${itemId}`, data,
    ),
  },

  // Audit log
  audit: {
    list: (params?: { projectId?: string; action?: string; limit?: number; before?: string }) => {
      const qs = new URLSearchParams();
      if (params?.projectId) qs.set('projectId', params.projectId);
      if (params?.action)    qs.set('action',    params.action);
      if (params?.limit)     qs.set('limit',     String(params.limit));
      if (params?.before)    qs.set('before',    params.before);
      const q = qs.toString();
      return request<AuditLogEntry[]>('GET', `/audit${q ? `?${q}` : ''}`);
    },
  },

  // Concept search
  search: {
    concepts: (q: string, terminologyId?: string) => {
      const qs = new URLSearchParams({ q });
      if (terminologyId) qs.set('terminologyId', terminologyId);
      return request<ConceptSearchResult[]>('GET', `/search/concepts?${qs.toString()}`);
    },
    // Async hierarchy enrichment — call after search results render.
    // Returns a map of SNOMED code → { parents, semanticTag }.
    conceptInfo: (codes: string[]) => {
      if (codes.length === 0) return Promise.resolve({} as Record<string, { parents: SnomedParentConcept[]; semanticTag: string | null }>);
      return request<Record<string, { parents: SnomedParentConcept[]; semanticTag: string | null }>>(
        'GET',
        `/search/concept-info?codes=${codes.join(',')}`,
      );
    },
  },

  // User management (admin only)
  users: {
    list: () =>
      request<OmniMapUser[]>('GET', '/users'),

    invite: (data: InviteUserInput) =>
      request<OmniMapUser>('POST', '/users/invite', data),

    update: (id: string, data: { displayName?: string; role?: UserRole }) =>
      request<OmniMapUser>('PUT', `/users/${id}`, data),

    deactivate: (id: string) =>
      request<{ id: string; isActive: false; email: string }>('PUT', `/users/${id}/deactivate`),

    reactivate: (id: string) =>
      request<{ id: string; isActive: true; email: string }>('PUT', `/users/${id}/reactivate`),
  },

  // Qualifier Pattern Library
  qualifierPatterns: {
    list: (params?: { category?: QualifierCategory; includeInactive?: boolean }) => {
      const qs = new URLSearchParams();
      if (params?.category)        qs.set('category',        params.category);
      if (params?.includeInactive) qs.set('includeInactive', 'true');
      const q = qs.toString();
      return request<QualifierPattern[]>('GET', `/qualifier-patterns${q ? `?${q}` : ''}`);
    },

    create: (data: CreateQualifierPatternInput) =>
      request<QualifierPattern>('POST', '/qualifier-patterns', data),

    update: (id: string, data: UpdateQualifierPatternInput) =>
      request<QualifierPattern>('PUT', `/qualifier-patterns/${id}`, data),

    remove: (id: string) =>
      request<{ id: string; isActive: false }>('DELETE', `/qualifier-patterns/${id}`),

    import: (category: QualifierCategory, file: File) => {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('category', category);
      return upload<ImportResult>('/qualifier-patterns/import', fd);
    },

    exportUrl: (category?: QualifierCategory) => {
      const qs = category ? `?category=${encodeURIComponent(category)}` : '';
      return `/api/qualifier-patterns/export${qs}`;
    },
  },

  // Reviewer — my queue
  reviewer: {
    myQueue: (projectId: string) =>
      request<AssignedTerm[]>('GET', `/reviewer/${projectId}/queue`),

    submitMapping: (projectId: string, data: SubmitMappingInput) =>
      request<{ mappingDecisionId: string }>('POST', `/reviewer/${projectId}/map`, data),

    myStats: (projectId: string) =>
      request<{
        assigned: number; completed: number; inProgress: number;
        averageMinutesPerTerm: number | null;
      }>('GET', `/reviewer/${projectId}/stats`),
  },
};
