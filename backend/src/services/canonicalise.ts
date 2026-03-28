// OmniMap — Node 8: CANONICALISE
//
// Writes all ready-to-canonicalise project_terms into canonical_mappings:
//
//   agreed       → both reviewers agreed; use either reviewer's mapping_decision targets
//   adjudicated  → adjudicator resolved a discrepancy; use adjudication_decision targets
//   auto_matched → holdout AUTOMATCH found an FSN exact match; re-lookup target from corpus
//
// Each source term × target code pair produces one canonical_mapping row.
// Terms already in canonical_mappings (ON CONFLICT DO NOTHING on project_term_id)
// are skipped safely.
//
// After all terms are processed, advances project status → exporting.
// Triggers: Node 13 EXPORT

import { v4 as uuidv4 }  from 'uuid';
import { db }            from './db';
import { emit }          from './events';
import { AuditAction }   from '../middleware/auditLog';

// -----------------------------------------------------------------
// Text normalisation
// -----------------------------------------------------------------

/**
 * Normalise a source text for storage in source_text_original.
 * Schema contract: case is preserved (upper-case applied at query time only).
 * We do:
 *   1. NFC unicode normalisation — decomposes then recomposes so e.g. é == é
 *   2. Replace all Unicode space variants with ASCII space
 *   3. Strip C0/C1 control characters and other non-printable code points
 *   4. Collapse runs of whitespace to a single space
 *   5. Trim leading/trailing whitespace
 */
function normaliseSourceText(s: string): string {
  return s
    .normalize('NFC')
    .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\uFEFF]/g, ' ')  // Unicode spaces → ASCII
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')                            // strip control chars
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalise a target display for storage in target_display_lower.
 * Schema contract: stored lower-case; matching is therefore case-insensitive by construction.
 * We do everything normaliseSourceText does, plus:
 *   6. Lower-case the entire string
 *   7. Strip soft hyphens and zero-width characters
 */
function normaliseTargetDisplay(s: string): string {
  return s
    .normalize('NFC')
    .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\uFEFF]/g, ' ')  // Unicode spaces → ASCII
    .replace(/[\u00AD\u200B-\u200D\u2060\uFEFF]/g, '')                       // zero-width / soft-hyphen
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')                            // control chars
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export interface CanonicaliseInput {
  projectId:   string;
  triggeredBy: string;  // users.id
}

export interface CanonicaliseResult {
  canonicalised: number;   // rows written to canonical_mappings
  skipped:       number;   // already-canonicalised or no targets
}

// -----------------------------------------------------------------
// Service
// -----------------------------------------------------------------

export async function canonicaliseTerms(
  input: CanonicaliseInput,
): Promise<CanonicaliseResult> {
  const { projectId, triggeredBy } = input;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Fetch project's target terminology
    const { rows: projRows } = await client.query<{ targetTerminologyId: string }>(
      `SELECT target_terminology_id AS "targetTerminologyId" FROM projects WHERE id = $1`,
      [projectId],
    );
    if (projRows.length === 0) throw new Error(`Project ${projectId} not found`);
    const { targetTerminologyId } = projRows[0];

    let canonicalised = 0;
    let skipped       = 0;

    // ── (a) Agreed terms ───────────────────────────────────────────
    // Get all agreed project_terms that don't already have a canonical_mapping
    const { rows: agreedTerms } = await client.query<{
      projectTermId: string;
      sourceTermId:  string;
      sourceText:    string;
    }>(
      `SELECT
         pt.id              AS "projectTermId",
         st.id              AS "sourceTermId",
         st.display_term    AS "sourceText"
       FROM project_terms pt
       JOIN source_terms   st ON st.id = pt.source_term_id
       LEFT JOIN canonical_mappings cm
         ON cm.project_term_id = pt.id AND cm.is_current = TRUE
       WHERE pt.project_id = $1
         AND pt.status     = 'agreed'
         AND cm.id IS NULL`,
      [projectId],
    );

    for (const term of agreedTerms) {
      // Get the first reviewer's targets (both agreed, so either works)
      const { rows: targets } = await client.query<{
        decisionId:       string;
        targetCode:       string;
        targetDisplay:    string;
        relationshipType: string;
        isUnmappable:     boolean;
        gapReasonCode:    string | null;
      }>(
        `SELECT
           md.id               AS "decisionId",
           mdt.target_code     AS "targetCode",
           mdt.target_display  AS "targetDisplay",
           mdt.relationship_type AS "relationshipType",
           md.is_unmappable    AS "isUnmappable",
           md.gap_reason_code  AS "gapReasonCode"
         FROM mapping_decisions md
         LEFT JOIN mapping_decision_targets mdt ON mdt.mapping_decision_id = md.id
         WHERE md.project_term_id = $1 AND md.is_current = TRUE
         ORDER BY md.version DESC
         LIMIT 20`,
        [term.projectTermId],
      );

      if (targets.length === 0 || targets[0].isUnmappable) {
        // SNOMED gap — create a canonical_mapping with gap flag
        await client.query(
          `INSERT INTO canonical_mappings (
             id, project_term_id, project_id, source_term_id,
             source_text_original, target_code, target_display_lower,
             relationship_type, is_auto_matched, mapping_decision_id,
             is_snomed_gap, gap_reason_code,
             is_current, version
           ) VALUES ($1,$2,$3,$4,$5,'UNMAPPABLE','unmappable','not_mappable',FALSE,$6,TRUE,$7,TRUE,1)
           ON CONFLICT DO NOTHING`,
          [
            uuidv4(), term.projectTermId, projectId, term.sourceTermId,
            normaliseSourceText(term.sourceText),
            targets[0]?.decisionId ?? null,
            targets[0]?.gapReasonCode ?? null,
          ],
        );
        canonicalised++;
      } else {
        // One canonical_mapping per target
        const seen = new Set<string>();
        for (const t of targets) {
          if (!t.targetCode || seen.has(t.targetCode)) continue;
          seen.add(t.targetCode);
          await client.query(
            `INSERT INTO canonical_mappings (
               id, project_term_id, project_id, source_term_id,
               source_text_original, target_code, target_display_lower,
               relationship_type, is_auto_matched, mapping_decision_id,
               is_current, version
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,FALSE,$9,TRUE,1)
             ON CONFLICT DO NOTHING`,
            [
              uuidv4(), term.projectTermId, projectId, term.sourceTermId,
              normaliseSourceText(term.sourceText),
              t.targetCode.trim(),
              normaliseTargetDisplay(t.targetDisplay),
              t.relationshipType,
              t.decisionId,
            ],
          );
          canonicalised++;
        }
      }

      // Advance project_term status
      await client.query(
        `UPDATE project_terms SET status = 'canonicalised', updated_at = now() WHERE id = $1`,
        [term.projectTermId],
      );
    }

    // ── (b) Adjudicated terms ──────────────────────────────────────
    const { rows: adjudicatedTerms } = await client.query<{
      projectTermId:       string;
      sourceTermId:        string;
      sourceText:          string;
      adjDecisionId:       string;
      adjudicationQueueId: string;
    }>(
      `SELECT
         pt.id              AS "projectTermId",
         st.id              AS "sourceTermId",
         st.display_term    AS "sourceText",
         ad.id              AS "adjDecisionId",
         aq.id              AS "adjudicationQueueId"
       FROM project_terms pt
       JOIN source_terms   st ON st.id = pt.source_term_id
       JOIN adjudication_queue  aq ON aq.project_term_id = pt.id AND aq.status = 'resolved'
       JOIN adjudication_decisions ad ON ad.adjudication_queue_id = aq.id
       LEFT JOIN canonical_mappings cm
         ON cm.project_term_id = pt.id AND cm.is_current = TRUE
       WHERE pt.project_id = $1
         AND pt.status     = 'adjudicated'
         AND cm.id IS NULL`,
      [projectId],
    );

    for (const term of adjudicatedTerms) {
      const { rows: adjTargets } = await client.query<{
        targetCode:       string;
        targetDisplay:    string;
        relationshipType: string;
        isUnmappable:     boolean;
        gapReasonCode:    string | null;
      }>(
        `SELECT
           adt.target_code        AS "targetCode",
           adt.target_display     AS "targetDisplay",
           adt.relationship_type  AS "relationshipType",
           ad.is_unmappable       AS "isUnmappable",
           ad.gap_reason_code     AS "gapReasonCode"
         FROM adjudication_decisions ad
         LEFT JOIN adjudication_decision_targets adt ON adt.adjudication_decision_id = ad.id
         WHERE ad.id = $1`,
        [term.adjDecisionId],
      );

      if (adjTargets.length === 0 || adjTargets[0].isUnmappable) {
        await client.query(
          `INSERT INTO canonical_mappings (
             id, project_term_id, project_id, source_term_id,
             source_text_original, target_code, target_display_lower,
             relationship_type, is_auto_matched, adjudication_decision_id,
             is_snomed_gap, gap_reason_code,
             is_current, version
           ) VALUES ($1,$2,$3,$4,$5,'UNMAPPABLE','unmappable','not_mappable',FALSE,$6,TRUE,$7,TRUE,1)
           ON CONFLICT DO NOTHING`,
          [uuidv4(), term.projectTermId, projectId, term.sourceTermId,
           normaliseSourceText(term.sourceText), term.adjDecisionId,
           adjTargets[0]?.gapReasonCode ?? null],
        );
        canonicalised++;
      } else {
        const seen = new Set<string>();
        for (const t of adjTargets) {
          if (!t.targetCode || seen.has(t.targetCode)) continue;
          seen.add(t.targetCode);
          await client.query(
            `INSERT INTO canonical_mappings (
               id, project_term_id, project_id, source_term_id,
               source_text_original, target_code, target_display_lower,
               relationship_type, is_auto_matched, adjudication_decision_id,
               is_current, version
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,FALSE,$9,TRUE,1)
             ON CONFLICT DO NOTHING`,
            [
              uuidv4(), term.projectTermId, projectId, term.sourceTermId,
              normaliseSourceText(term.sourceText),
              t.targetCode.trim(),
              normaliseTargetDisplay(t.targetDisplay),
              t.relationshipType, term.adjDecisionId,
            ],
          );
          canonicalised++;
        }
      }

      await client.query(
        `UPDATE project_terms SET status = 'canonicalised', updated_at = now() WHERE id = $1`,
        [term.projectTermId],
      );
    }

    // ── (c) Auto-matched terms ─────────────────────────────────────
    // Re-find the corpus match by FSN text, then copy the target_code.
    const { rows: autoTerms } = await client.query<{
      projectTermId:  string;
      sourceTermId:   string;
      sourceText:     string;
      autoMatchedFsn: string | null;
    }>(
      `SELECT
         pt.id              AS "projectTermId",
         st.id              AS "sourceTermId",
         st.display_term    AS "sourceText",
         pt.auto_matched_fsn AS "autoMatchedFsn"
       FROM project_terms pt
       JOIN source_terms   st ON st.id = pt.source_term_id
       LEFT JOIN canonical_mappings cm
         ON cm.project_term_id = pt.id AND cm.is_current = TRUE
       WHERE pt.project_id    = $1
         AND pt.status        = 'auto_matched'
         AND pt.is_auto_matched = TRUE
         AND cm.id IS NULL`,
      [projectId],
    );

    for (const term of autoTerms) {
      // Look up the existing canonical_mapping that matched via FSN
      const { rows: corpusRows } = await client.query<{
        targetCode:    string;
        targetDisplay: string;
      }>(
        `SELECT DISTINCT cm.target_code AS "targetCode", cm.target_display_lower AS "targetDisplay"
         FROM canonical_mappings cm
         JOIN project_terms pt2 ON pt2.id = cm.project_term_id
         JOIN projects p ON p.id = pt2.project_id
         WHERE p.target_terminology_id = $1
           AND cm.is_current = TRUE
           AND cm.target_code != 'UNMAPPABLE'
         LIMIT 1`,
        [targetTerminologyId],
      );

      const targetCode    = corpusRows[0]?.targetCode    ?? term.autoMatchedFsn ?? 'UNKNOWN';
      const targetDisplay = corpusRows[0]?.targetDisplay ?? (term.autoMatchedFsn ?? '').toLowerCase();

      await client.query(
        `INSERT INTO canonical_mappings (
           id, project_term_id, project_id, source_term_id,
           source_text_original, target_code, target_display_lower,
           relationship_type, is_auto_matched, auto_match_basis,
           is_current, version
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'equivalent_to',TRUE,'SNOMED_CT_FSN_EXACT',TRUE,1)
         ON CONFLICT DO NOTHING`,
        [
          uuidv4(), term.projectTermId, projectId, term.sourceTermId,
          normaliseSourceText(term.sourceText),
          targetCode.trim(),
          normaliseTargetDisplay(targetDisplay),
        ],
      );
      canonicalised++;

      await client.query(
        `UPDATE project_terms SET status = 'canonicalised', updated_at = now() WHERE id = $1`,
        [term.projectTermId],
      );
    }

    // Advance project status → exporting
    await client.query(
      `UPDATE projects
       SET status = 'exporting', current_dag_node = 'NODE_13_EXPORT', updated_at = now()
       WHERE id = $1`,
      [projectId],
    );

    // Audit
    await client.query(
      `INSERT INTO audit_log
         (user_id, system_flag, action, entity_type, entity_id, project_id, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        triggeredBy, null,
        AuditAction.PROJECT_STATUS_CHANGED,
        'project', projectId, projectId,
        JSON.stringify({ node: 'NODE_8_CANONICALISE', canonicalised, skipped }),
      ],
    );

    await client.query('COMMIT');

    await emit({
      source:     'omnimap',
      detailType: 'CANONICALISE_COMPLETE',
      detail: { projectId, node: 'NODE_8_CANONICALISE', nextNode: 'NODE_13_EXPORT', canonicalised, skipped },
    });

    return { canonicalised, skipped };

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
