// OmniMap — Node 0: PROJECT_INIT
// Creates the project record, snapshots the current corpus count for the target
// terminology, optionally imports external reference mappings (read-only), then
// advances status → ingesting and emits PROJECT_INIT_COMPLETE → triggers Node 1.

import { v4 as uuidv4 }        from 'uuid';
import { db }                   from './db';
import { emit }                 from './events';
import { AuditAction }          from '../middleware/auditLog';
import { ProjectType, ProjectStatus } from '../types/enums';
import type { Project }         from '../types/models';

// -----------------------------------------------------------------
// Public types
// -----------------------------------------------------------------

export interface ExternalMappingRow {
  sourceCode:     string;
  displayTerm:    string;
  targetCode:     string;
  targetDisplay:  string;
  terminologyId?: string;  // null if not OmniMap-managed
}

export interface ProjectInitInput {
  name:                     string;
  description?:             string;
  projectType:              ProjectType;
  sourceTerminologyId?:     string;
  targetTerminologyId:      string;

  // Power-calculation params — defaults match PRD §5.5
  powerF1Threshold?:        number;  // default 0.90
  powerAlpha?:              number;  // default 0.05
  powerBeta?:               number;  // default 0.20  (power = 1 − beta = 0.80)

  // Quality thresholds
  greedinesRatioThreshold?:   number;  // default 2.0 (matches DB default)
  nearDuplicateEditDistance?: number;  // default 2

  // Optional prior mappings (read-only reference, not OmniMap output)
  externalMappings?: ExternalMappingRow[];

  createdBy: string;  // users.id of the administrator initiating the project
}

export interface ProjectInitResult {
  project:                  Project;
  corpusSnapshotCount:      number;  // canonical_mappings rows for target terminology at init time
  externalMappingsImported: number;
}

// -----------------------------------------------------------------
// Service
// -----------------------------------------------------------------

export async function initProject(input: ProjectInitInput): Promise<ProjectInitResult> {
  const {
    name,
    description              = null,
    projectType,
    sourceTerminologyId      = null,
    targetTerminologyId,
    powerF1Threshold         = 0.90,
    powerAlpha               = 0.05,
    powerBeta                = 0.20,
    greedinesRatioThreshold  = 2.0,
    nearDuplicateEditDistance = 2,
    externalMappings         = [],
    createdBy,
  } = input;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // 1. Verify target terminology exists and is active
    const { rows: termRows } = await client.query<{ id: string }>(
      `SELECT id FROM terminologies WHERE id = $1 AND is_active = TRUE`,
      [targetTerminologyId],
    );
    if (termRows.length === 0) {
      throw new Error(`Target terminology ${targetTerminologyId} not found or inactive`);
    }

    // 2. Verify source terminology if provided
    if (sourceTerminologyId) {
      const { rows: srcRows } = await client.query<{ id: string }>(
        `SELECT id FROM terminologies WHERE id = $1 AND is_active = TRUE`,
        [sourceTerminologyId],
      );
      if (srcRows.length === 0) {
        throw new Error(`Source terminology ${sourceTerminologyId} not found or inactive`);
      }
    }

    // 3. Create the project record (status = 'init')
    const projectId = uuidv4();
    const { rows: projectRows } = await client.query<Project>(
      `INSERT INTO projects (
        id,
        name,
        description,
        project_type,
        source_terminology_id,
        target_terminology_id,
        status,
        current_dag_node,
        power_f1_threshold,
        power_alpha,
        power_beta,
        computed_holdout_n,
        greediness_ratio_threshold,
        near_duplicate_edit_distance,
        created_by
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        'init',
        'NODE_0_PROJECT_INIT',
        $7, $8, $9,
        NULL,
        $10, $11,
        $12
      )
      RETURNING
        id,
        name,
        description,
        project_type                  AS "projectType",
        source_terminology_id         AS "sourceTerminologyId",
        target_terminology_id         AS "targetTerminologyId",
        status,
        current_dag_node              AS "currentDagNode",
        power_f1_threshold            AS "powerF1Threshold",
        power_alpha                   AS "powerAlpha",
        power_beta                    AS "powerBeta",
        computed_holdout_n            AS "computedHoldoutN",
        greediness_ratio_threshold    AS "greedinesRatioThreshold",
        near_duplicate_edit_distance  AS "nearDuplicateEditDistance",
        sample_locked_at              AS "sampleLockedAt",
        holdout_locked_at             AS "holdoutLockedAt",
        target_terminology_locked_at  AS "targetTerminologyLockedAt",
        prior_terminology_version     AS "priorTerminologyVersion",
        new_terminology_version       AS "newTerminologyVersion",
        created_by                    AS "createdBy",
        created_at                    AS "createdAt",
        updated_at                    AS "updatedAt"
      `,
      [
        projectId,
        name,
        description,
        projectType,
        sourceTerminologyId,
        targetTerminologyId,
        powerF1Threshold,
        powerAlpha,
        powerBeta,
        greedinesRatioThreshold,
        nearDuplicateEditDistance,
        createdBy,
      ],
    );
    const project = projectRows[0];

    // 4. Corpus snapshot — count current canonical_mappings for the target terminology.
    //    Recorded in the audit payload as a point-in-time watermark only.
    //    Node 2 (DEDUPLICATE) queries canonical_mappings live at execution time.
    const { rows: corpusRows } = await client.query<{ cnt: string }>(
      `SELECT COUNT(*)::TEXT AS cnt
       FROM  canonical_mappings cm
       JOIN  project_terms pt ON pt.id = cm.project_term_id
       JOIN  projects p       ON p.id  = pt.project_id
       WHERE p.target_terminology_id = $1
         AND cm.is_current = TRUE`,
      [targetTerminologyId],
    );
    const corpusSnapshotCount = parseInt(corpusRows[0].cnt, 10);

    // 5. Import external mappings (read-only reference corpus — not OmniMap output)
    let externalMappingsImported = 0;
    for (const row of externalMappings) {
      await client.query(
        `INSERT INTO external_mapping_imports (
          id, project_id, source_code, display_term,
          target_code, target_display, terminology_id, imported_by
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          uuidv4(),
          projectId,
          row.sourceCode,
          row.displayTerm,
          row.targetCode,
          row.targetDisplay,
          row.terminologyId ?? null,
          createdBy,
        ],
      );
      externalMappingsImported++;
    }

    // 6. Advance status: init → ingesting
    await client.query(
      `UPDATE projects
       SET status = 'ingesting', current_dag_node = 'NODE_1_INGEST', updated_at = now()
       WHERE id = $1`,
      [projectId],
    );
    project.status         = ProjectStatus.Ingesting;
    project.currentDagNode = 'NODE_1_INGEST';

    // 7. Audit log (within transaction — same client)
    await client.query(
      `INSERT INTO audit_log
         (user_id, system_flag, action, entity_type, entity_id, project_id, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        createdBy,
        null,
        AuditAction.PROJECT_CREATED,
        'project',
        projectId,
        projectId,
        JSON.stringify({ name, projectType, targetTerminologyId, sourceTerminologyId,
                         corpusSnapshotCount, externalMappingsImported }),
      ],
    );

    await client.query('COMMIT');

    // 8. Emit event → Node 1 INGEST (after commit — no rollback risk)
    await emit({
      source:     'omnimap',
      detailType: 'PROJECT_INIT_COMPLETE',
      detail: {
        projectId,
        node:     'NODE_0_PROJECT_INIT',
        nextNode: 'NODE_1_INGEST',
        corpusSnapshotCount,
        externalMappingsImported,
      },
    });

    return { project, corpusSnapshotCount, externalMappingsImported };

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
