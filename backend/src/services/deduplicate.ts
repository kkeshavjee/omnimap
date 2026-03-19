// OmniMap — Node 2: DEDUPLICATE
// Cross-references every raw source term in the project against:
//   (a) OmniMap canonical corpus (canonical_mappings — current, same target terminology)
//   (b) External reference corpus (external_mapping_imports for this project)
//
// Results:
//   already_mapped  → term exists in corpus; creates a project_term and skips review queue
//   net_new_queued  → not in any corpus from a prior cycle; staged for next project cycle (terminal)
//   raw → (remaining) forwarded to Node 3 SAMPLE
//
// Net-new detection: a term is net-new when it appears in this extract but has never appeared
// in any prior extract for the same project. Cross-extract deduplication is by (source_code,
// project_id) across emr_extracts.
//
// Triggers: Node 3 — SAMPLE

import { db }          from './db';
import { emit }        from './events';
import { AuditAction } from '../middleware/auditLog';
import { TermStatus }  from '../types/enums';
import { v4 as uuidv4 } from 'uuid';

// -----------------------------------------------------------------
// Public types
// -----------------------------------------------------------------

export interface DeduplicateInput {
  projectId:  string;
  extractId:  string;
  triggeredBy: string;  // users.id (system or admin)
}

export interface DeduplicateResult {
  alreadyMapped:   number;
  netNewQueued:    number;
  forwardedToSample: number;
}

// -----------------------------------------------------------------
// Service
// -----------------------------------------------------------------

export async function deduplicateTerms(input: DeduplicateInput): Promise<DeduplicateResult> {
  const { projectId, extractId, triggeredBy } = input;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Fetch the target terminology for this project
    const { rows: projRows } = await client.query<{ targetTerminologyId: string }>(
      `SELECT target_terminology_id AS "targetTerminologyId" FROM projects WHERE id = $1`,
      [projectId],
    );
    if (projRows.length === 0) throw new Error(`Project ${projectId} not found`);
    const { targetTerminologyId } = projRows[0];

    // Fetch all raw source terms for this extract that don't already have a project_term
    const { rows: rawTerms } = await client.query<{
      id: string;
      sourceCode: string;
      displayTerm: string;
      frequency: number | null;
      clinicalDomain: string | null;
      sourceTerminologyId: string | null;
    }>(
      `SELECT
         st.id                      AS id,
         st.source_code             AS "sourceCode",
         st.display_term            AS "displayTerm",
         st.frequency               AS frequency,
         st.clinical_domain         AS "clinicalDomain",
         st.source_terminology_id   AS "sourceTerminologyId"
       FROM source_terms st
       LEFT JOIN project_terms pt
         ON pt.source_term_id = st.id AND pt.project_id = $1
       WHERE st.extract_id = $2
         AND st.is_out_of_place = FALSE
         AND pt.id IS NULL`,
      [projectId, extractId],
    );

    let alreadyMapped     = 0;
    let netNewQueued      = 0;
    let forwardedToSample = 0;

    for (const term of rawTerms) {
      // ── (a) Check OmniMap canonical corpus ─────────────────────────────
      const { rows: canonRows } = await client.query<{ id: string }>(
        `SELECT cm.id
         FROM   canonical_mappings cm
         JOIN   project_terms pt2 ON pt2.id = cm.project_term_id
         JOIN   projects p        ON p.id   = pt2.project_id
         JOIN   source_terms st   ON st.id  = pt2.source_term_id
         WHERE  p.target_terminology_id = $1
           AND  UPPER(TRIM(st.source_code)) = UPPER(TRIM($2))
           AND  cm.is_current = TRUE
         LIMIT 1`,
        [targetTerminologyId, term.sourceCode],
      );

      // ── (b) Check external reference corpus ────────────────────────────
      const { rows: extRows } = await client.query<{ id: string }>(
        `SELECT id
         FROM   external_mapping_imports
         WHERE  project_id = $1
           AND  UPPER(TRIM(source_code)) = UPPER(TRIM($2))
         LIMIT 1`,
        [projectId, term.sourceCode],
      );

      const inCorpus   = canonRows.length > 0;
      const inExternal = extRows.length > 0;

      // ── (c) Net-new detection ───────────────────────────────────────────
      // A term is net-new when its source_code has NEVER appeared in any prior
      // extract for this project (i.e., only exists in the current extract).
      let isNetNew = false;
      if (!inCorpus && !inExternal) {
        const { rows: priorRows } = await client.query<{ cnt: string }>(
          `SELECT COUNT(*)::TEXT AS cnt
           FROM   source_terms st
           JOIN   emr_extracts  ex ON ex.id = st.extract_id
           WHERE  ex.project_id = $1
             AND  st.id         != $2
             AND  UPPER(TRIM(st.source_code)) = UPPER(TRIM($3))`,
          [projectId, term.id, term.sourceCode],
        );
        isNetNew = parseInt(priorRows[0].cnt, 10) === 0;
      }

      // ── Classify and create project_term ───────────────────────────────
      let status: TermStatus;
      let alreadyMappedByProjectId: string | null = null;

      if (inCorpus) {
        status = TermStatus.AlreadyMapped;
        // Record which project originally mapped this term
        const { rows: srcProjRows } = await client.query<{ projectId: string }>(
          `SELECT pt2.project_id AS "projectId"
           FROM   canonical_mappings cm
           JOIN   project_terms pt2 ON pt2.id = cm.project_term_id
           JOIN   source_terms  st  ON st.id  = pt2.source_term_id
           JOIN   projects p        ON p.id   = pt2.project_id
           WHERE  p.target_terminology_id = $1
             AND  UPPER(TRIM(st.source_code)) = UPPER(TRIM($2))
             AND  cm.is_current = TRUE
           LIMIT 1`,
          [targetTerminologyId, term.sourceCode],
        );
        alreadyMappedByProjectId = srcProjRows[0]?.projectId ?? null;
        alreadyMapped++;
      } else if (inExternal) {
        status = TermStatus.AlreadyMapped;  // external reference — treat as mapped for dedup
        alreadyMapped++;
      } else if (isNetNew) {
        status = TermStatus.NetNewQueued;
        netNewQueued++;
      } else {
        status = TermStatus.Raw;  // existing term, not in corpus → forward to Sample
        forwardedToSample++;
      }

      await client.query(
        `INSERT INTO project_terms (
          id, project_id, source_term_id, status,
          is_holdout, holdout_locked, is_auto_matched,
          already_mapped_by_project_id
        ) VALUES ($1, $2, $3, $4, FALSE, FALSE, FALSE, $5)`,
        [uuidv4(), projectId, term.id, status, alreadyMappedByProjectId],
      );
    }

    // Advance project status: deduplicating → sampling
    await client.query(
      `UPDATE projects
       SET status = 'sampling', current_dag_node = 'NODE_3_SAMPLE', updated_at = now()
       WHERE id = $1`,
      [projectId],
    );

    // Audit log
    await client.query(
      `INSERT INTO audit_log
         (user_id, system_flag, action, entity_type, entity_id, project_id, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        triggeredBy,
        null,
        AuditAction.PROJECT_STATUS_CHANGED,
        'project',
        projectId,
        projectId,
        JSON.stringify({
          node: 'NODE_2_DEDUPLICATE',
          alreadyMapped,
          netNewQueued,
          forwardedToSample,
        }),
      ],
    );

    await client.query('COMMIT');

    // Emit event → Node 3 SAMPLE
    await emit({
      source:     'omnimap',
      detailType: 'DEDUPLICATE_COMPLETE',
      detail: {
        projectId,
        node:     'NODE_2_DEDUPLICATE',
        nextNode: 'NODE_3_SAMPLE',
        alreadyMapped,
        netNewQueued,
        forwardedToSample,
      },
    });

    return { alreadyMapped, netNewQueued, forwardedToSample };

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
