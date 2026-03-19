// OmniMap — Typed API Client
// Injects the Cognito access token on every request.
// All methods throw on non-2xx responses with a structured error.

import { fetchAuthSession } from 'aws-amplify/auth';

// -----------------------------------------------------------------
// Shared domain types (mirrors backend models)
// -----------------------------------------------------------------

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
  createdBy:             string;
  createdAt:             string;
  updatedAt:             string;
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
  targets:       MappingTarget[];
  rationale?:    string;
  isAiAssisted?: boolean;
}

// -----------------------------------------------------------------
// HTTP helper
// -----------------------------------------------------------------

async function getToken(): Promise<string> {
  const session = await fetchAuthSession();
  const token   = session.tokens?.accessToken?.toString();
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
