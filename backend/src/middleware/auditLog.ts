// OmniMap — Audit Log Writer
// Writes append-only entries to the audit_log table.
// Called explicitly by service functions — not a route middleware —
// so each entry carries full business context (entity_id, project_id, payload).
//
// RULES (from migration 001 and Section 7.6):
//   • Never call UPDATE or DELETE on audit_log.
//   • Every state-changing action must produce an entry.
//   • userId is NULL for system-generated events; use systemFlag instead.
//   • All timestamps are UTC (PostgreSQL DEFAULT now() handles this).

import { Pool } from 'pg';

export interface AuditLogParams {
  userId?:     string;   // null for system events
  systemFlag?: string;   // e.g. 'AUTO_MATCH' | 'LOAD_BALANCER'
  action:      string;   // e.g. 'PROJECT_CREATED' | 'MAPPING_SUBMITTED'
  entityType:  string;   // e.g. 'project' | 'mapping_decision'
  entityId?:   string;
  projectId?:  string;
  payload?:    Record<string, unknown>;
}

export class AuditLogWriter {
  constructor(private readonly db: Pool) {}

  async write(params: AuditLogParams): Promise<void> {
    await this.db.query(
      `INSERT INTO audit_log
         (user_id, system_flag, action, entity_type, entity_id, project_id, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        params.userId    ?? null,
        params.systemFlag ?? null,
        params.action,
        params.entityType,
        params.entityId  ?? null,
        params.projectId ?? null,
        params.payload   ? JSON.stringify(params.payload) : null,
      ],
    );
  }
}

// Canonical action constants — use these throughout services to
// prevent spelling drift and simplify log queries.
export const AuditAction = {
  // Projects
  PROJECT_CREATED:             'PROJECT_CREATED',
  PROJECT_STATUS_CHANGED:      'PROJECT_STATUS_CHANGED',
  PROJECT_ARCHIVED:            'PROJECT_ARCHIVED',

  // Ingestion
  EXTRACT_UPLOADED:            'EXTRACT_UPLOADED',
  EXTRACT_PROCESSED:           'EXTRACT_PROCESSED',
  TERM_OUT_OF_PLACE_FLAGGED:   'TERM_OUT_OF_PLACE_FLAGGED',

  // Sampling
  SAMPLE_CONFIG_CREATED:       'SAMPLE_CONFIG_CREATED',
  SAMPLE_LOCKED:               'SAMPLE_LOCKED',
  SAMPLE_REGENERATED:          'SAMPLE_REGENERATED',

  // Holdout
  HOLDOUT_DRAWN:               'HOLDOUT_DRAWN',
  HOLDOUT_LOCKED:              'HOLDOUT_LOCKED',

  // Auto-match (Node 4)
  TERM_AUTO_MATCHED:           'TERM_AUTO_MATCHED',

  // Allocation
  REVIEWER_POOL_ASSIGNED:      'REVIEWER_POOL_ASSIGNED',
  TERM_ALLOCATED:              'TERM_ALLOCATED',
  TERM_REALLOCATED:            'TERM_REALLOCATED',

  // Mapping (Node 6)
  MAPPING_SUBMITTED:           'MAPPING_SUBMITTED',
  MAPPING_AGREED:              'MAPPING_AGREED',
  MAPPING_ESCALATED:           'MAPPING_ESCALATED',

  // Adjudication (Node 7)
  ADJUDICATION_ASSIGNED:       'ADJUDICATION_ASSIGNED',
  ADJUDICATION_RESOLVED:       'ADJUDICATION_RESOLVED',

  // Canonicalisation (Node 8)
  MAPPING_CANONICALISED:       'MAPPING_CANONICALISED',

  // Error correction (FR-57–FR-61)
  MAPPING_FLAGGED:             'MAPPING_FLAGGED',
  MAPPING_CORRECTION_STARTED:  'MAPPING_CORRECTION_STARTED',
  MAPPING_SUPERSEDED:          'MAPPING_SUPERSEDED',
  CORRECTION_CASCADE_FLAGGED:  'CORRECTION_CASCADE_FLAGGED',

  // Regex pipeline (Nodes 9–11)
  REGEX_PIPELINE_RUN:          'REGEX_PIPELINE_RUN',
  REGEX_PATTERN_VALIDATED:     'REGEX_PATTERN_VALIDATED',
  REGEX_CORPUS_UPDATED:        'REGEX_CORPUS_UPDATED',

  // Scoring (Node 12)
  HOLDOUT_SCORING_TRIGGERED:   'HOLDOUT_SCORING_TRIGGERED',
  HOLDOUT_SCORED:              'HOLDOUT_SCORED',

  // Export (Node 13)
  EXPORT_GENERATED:            'EXPORT_GENERATED',

  // Certification
  CERTIFICATION_GRANTED:       'CERTIFICATION_GRANTED',
  CERTIFICATION_EXPIRED:       'CERTIFICATION_EXPIRED',
  PRACTICE_ATTEMPT_COMPLETED:  'PRACTICE_ATTEMPT_COMPLETED',

  // Corpus import
  CORPUS_IMPORTED:             'CORPUS_IMPORTED',
} as const;

export type AuditActionType = typeof AuditAction[keyof typeof AuditAction];
