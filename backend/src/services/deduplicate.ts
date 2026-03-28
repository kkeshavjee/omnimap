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
// Service — set-based classification (single round-trip per phase)
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

    // ---------------------------------------------------------------
    // Single CTE to classify all raw terms at once:
    //   in_canon   → matched in canonical_mappings (same target terminology, is_current)
    //   in_external → matched in external_mapping_imports for this project
    //   is_net_new  → source_code never appeared in any *prior* extract for this project
    // ---------------------------------------------------------------
    const { rows: classified } = await client.query<{
      id:                  string;
      sourceCode:          string;
      displayTerm:         string;
      frequency:           number | null;
      clinicalDomain:      string | null;
      sourceTerminologyId: string | null;
      inCanon:             boolean;
      inExternal:          boolean;
      isNetNew:            boolean;
      mappedByProjectId:   string | null;
    }>(
      `WITH raw_terms AS (
         SELECT
           st.id, st.source_code, st.display_term, st.frequency,
           st.clinical_domain, st.source_terminology_id
         FROM source_terms st
         LEFT JOIN project_terms pt
           ON pt.source_term_id = st.id AND pt.project_id = $1
         WHERE st.extract_id    = $2
           AND st.is_out_of_place = FALSE
           AND pt.id IS NULL
       ),
       canon_hit AS (
         -- One row per unique source_code that matches the canonical corpus
         SELECT DISTINCT ON (UPPER(TRIM(st2.source_code)))
           UPPER(TRIM(st2.source_code)) AS sc_upper,
           pt2.project_id               AS mapped_by_project_id
         FROM   canonical_mappings cm
         JOIN   project_terms  pt2 ON pt2.id  = cm.project_term_id
         JOIN   projects        p   ON p.id   = pt2.project_id
         JOIN   source_terms   st2  ON st2.id = pt2.source_term_id
         WHERE  p.target_terminology_id = $3
           AND  cm.is_current = TRUE
         ORDER BY UPPER(TRIM(st2.source_code))
       ),
       ext_hit AS (
         SELECT DISTINCT UPPER(TRIM(source_code)) AS sc_upper
         FROM   external_mapping_imports
         WHERE  project_id = $1
       ),
       prior_hit AS (
         -- source_codes that have appeared in at least one *other* extract for this project
         SELECT DISTINCT UPPER(TRIM(st2.source_code)) AS sc_upper
         FROM   source_terms   st2
         JOIN   emr_extracts   ex  ON ex.id = st2.extract_id
         WHERE  ex.project_id = $1
           AND  st2.extract_id != $2
       )
       SELECT
         rt.id,
         rt.source_code            AS "sourceCode",
         rt.display_term           AS "displayTerm",
         rt.frequency,
         rt.clinical_domain        AS "clinicalDomain",
         rt.source_terminology_id  AS "sourceTerminologyId",
         (ch.sc_upper IS NOT NULL) AS "inCanon",
         (eh.sc_upper IS NOT NULL) AS "inExternal",
         (ph.sc_upper IS NULL)     AS "isNetNew",
         ch.mapped_by_project_id   AS "mappedByProjectId"
       FROM      raw_terms rt
       LEFT JOIN canon_hit ch ON ch.sc_upper = UPPER(TRIM(rt.source_code))
       LEFT JOIN ext_hit   eh ON eh.sc_upper = UPPER(TRIM(rt.source_code))
       LEFT JOIN prior_hit ph ON ph.sc_upper = UPPER(TRIM(rt.source_code))`,
      [projectId, extractId, targetTerminologyId],
    );

    // ---------------------------------------------------------------
    // Classify and build arrays for bulk insert
    // ---------------------------------------------------------------
    let alreadyMapped     = 0;
    let netNewQueued      = 0;
    let forwardedToSample = 0;

    const ids:                    string[]        = [];
    const sourceTermIds:          string[]        = [];
    const statuses:               string[]        = [];
    const alreadyMappedByProjIds: (string|null)[] = [];

    for (const term of classified) {
      let status: TermStatus;
      let mappedByProjectId: string | null = null;

      if (term.inCanon) {
        status           = TermStatus.AlreadyMapped;
        mappedByProjectId = term.mappedByProjectId;
        alreadyMapped++;
      } else if (term.inExternal) {
        status = TermStatus.AlreadyMapped;
        alreadyMapped++;
      } else if (term.isNetNew) {
        status = TermStatus.NetNewQueued;
        netNewQueued++;
      } else {
        status = TermStatus.Raw;
        forwardedToSample++;
      }

      ids.push(uuidv4());
      sourceTermIds.push(term.id);
      statuses.push(status);
      alreadyMappedByProjIds.push(mappedByProjectId);
    }

    // ---------------------------------------------------------------
    // Bulk insert project_terms — single round-trip
    // ---------------------------------------------------------------
    if (ids.length > 0) {
      await client.query(
        `INSERT INTO project_terms (
           id, project_id, source_term_id, status,
           is_holdout, holdout_locked, is_auto_matched,
           already_mapped_by_project_id
         )
         SELECT
           unnest($1::uuid[]),
           $2::uuid,
           unnest($3::uuid[]),
           unnest($4::text[])::term_status,
           FALSE, FALSE, FALSE,
           unnest($5::uuid[])
         ON CONFLICT DO NOTHING`,
        [ids, projectId, sourceTermIds, statuses, alreadyMappedByProjIds],
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
