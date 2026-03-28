// OmniMap — Adjudicator Router (Node 7: ADJUDICATE)
//
// GET  /adjudicator/:projectId/queue            — pending items for this adjudicator
// POST /adjudicator/:projectId/resolve/:itemId  — submit resolution
//
// Adjudicator sees both reviewers' decisions and selects or creates a binding decision.
// Independence: adjudicator cannot see reviewer identities (IDs are hidden).

import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 }  from 'uuid';
import { db }            from '../services/db';
import { requireRole }   from '../middleware/rbac';
import { AuditAction }   from '../middleware/auditLog';
import { UserRole, GapReasonCode } from '../types/enums';

const router = Router({ mergeParams: true });

router.use(requireRole(UserRole.Adjudicator, UserRole.Administrator));

// -----------------------------------------------------------------
// GET /adjudicator/:projectId/queue
// Returns pending adjudication queue items with both decisions.
// -----------------------------------------------------------------
router.get(
  '/:projectId/queue',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Get queue items
      const { rows: items } = await db.query(
        `SELECT
           aq.id              AS "queueItemId",
           aq.project_term_id AS "projectTermId",
           st.source_code     AS "sourceCode",
           st.display_term    AS "displayTerm",
           st.frequency,
           st.clinical_domain AS "clinicalDomain",
           aq.status,
           aq.created_at      AS "createdAt"
         FROM adjudication_queue aq
         JOIN project_terms  pt ON pt.id = aq.project_term_id
         JOIN source_terms   st ON st.id = pt.source_term_id
         WHERE aq.project_id = $1
           AND aq.status     = 'pending'
         ORDER BY st.frequency DESC NULLS LAST, aq.created_at ASC`,
        [req.params.projectId],
      );

      // For each item fetch both decisions + their targets
      const result = [];
      for (const item of items) {
        const { rows: decisions } = await db.query(
          `SELECT
             md.id               AS "decisionId",
             md.is_unmappable    AS "isUnmappable",
             md.gap_reason_code  AS "gapReasonCode",
             md.rationale,
             COALESCE(
               json_agg(
                 json_build_object(
                   'targetCode',       mdt.target_code,
                   'targetDisplay',    mdt.target_display,
                   'relationshipType', mdt.relationship_type
                 ) ORDER BY mdt.target_code
               ) FILTER (WHERE mdt.id IS NOT NULL),
               '[]'::json
             ) AS targets
           FROM mapping_decisions md
           LEFT JOIN mapping_decision_targets mdt ON mdt.mapping_decision_id = md.id
           WHERE md.project_term_id = $1 AND md.is_current = TRUE
           GROUP BY md.id, md.is_unmappable, md.gap_reason_code, md.rationale`,
          [item.projectTermId],
        );

        result.push({
          ...item,
          decisionA: decisions[0] ?? null,
          decisionB: decisions[1] ?? null,
        });
      }

      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// -----------------------------------------------------------------
// POST /adjudicator/:projectId/resolve/:itemId
// Body: { isUnmappable, targets[], rationale?, acceptDecisionId? }
//   acceptDecisionId — if set, accepts an existing reviewer's decision verbatim
//   targets[]        — required if isUnmappable=false and acceptDecisionId not set
// -----------------------------------------------------------------
router.post(
  '/:projectId/resolve/:itemId',
  async (req: Request, res: Response, next: NextFunction) => {
    const { projectId, itemId } = req.params;
    const { isUnmappable, gapReasonCode, targets, rationale, acceptDecisionId } = req.body as {
      isUnmappable:      boolean;
      gapReasonCode?:    GapReasonCode;
      targets?:          Array<{ targetCode: string; targetDisplay: string; relationshipType: string }>;
      rationale?:        string;
      acceptDecisionId?: string;
    };

    if (!isUnmappable && !acceptDecisionId && (!Array.isArray(targets) || targets.length === 0)) {
      return res.status(400).json({ error: 'targets or acceptDecisionId required' });
    }
    if (isUnmappable && !acceptDecisionId && !gapReasonCode) {
      return res.status(400).json({ error: 'gapReasonCode is required when isUnmappable is true' });
    }
    if (isUnmappable && gapReasonCode === GapReasonCode.Other && !rationale?.trim()) {
      return res.status(400).json({ error: 'rationale is required for GAP-06 (Other)' });
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      // Verify queue item exists and is pending
      const { rows: qRows } = await client.query(
        `SELECT aq.id, aq.project_term_id AS "projectTermId",
                aq.mapping_decision_a AS "decisionA", aq.mapping_decision_b AS "decisionB"
         FROM adjudication_queue aq
         WHERE aq.id = $1 AND aq.project_id = $2 AND aq.status = 'pending'`,
        [itemId, projectId],
      );
      if (qRows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Queue item not found or already resolved' });
      }
      const { projectTermId, decisionA, decisionB } = qRows[0];

      // Resolve targets: either from acceptDecisionId or from body
      let resolvedTargets: Array<{ targetCode: string; targetDisplay: string; relationshipType: string }> = [];

      if (acceptDecisionId) {
        // Copy targets from the accepted decision
        const validDecision = [decisionA, decisionB].includes(acceptDecisionId) ? acceptDecisionId : null;
        if (!validDecision) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'acceptDecisionId must be one of the two queue decisions' });
        }
        const { rows: copiedTargets } = await client.query(
          `SELECT target_code AS "targetCode", target_display AS "targetDisplay",
                  relationship_type AS "relationshipType"
           FROM mapping_decision_targets WHERE mapping_decision_id = $1`,
          [acceptDecisionId],
        );
        resolvedTargets = copiedTargets;
      } else if (!isUnmappable) {
        resolvedTargets = targets ?? [];
      }

      // Resolve gap_reason_code: use provided value, or inherit from accepted decision
      let resolvedGapReasonCode: GapReasonCode | null = gapReasonCode ?? null;
      if (acceptDecisionId && isUnmappable && !gapReasonCode) {
        const { rows: gapRows } = await client.query<{ gap_reason_code: GapReasonCode | null }>(
          `SELECT gap_reason_code FROM mapping_decisions WHERE id = $1`,
          [acceptDecisionId],
        );
        resolvedGapReasonCode = gapRows[0]?.gap_reason_code ?? null;
      }

      // Insert adjudication decision
      const adjDecisionId = uuidv4();
      await client.query(
        `INSERT INTO adjudication_decisions
           (id, adjudication_queue_id, adjudicator_id, project_term_id,
            is_unmappable, gap_reason_code, rationale)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [adjDecisionId, itemId, req.user!.id, projectTermId,
         isUnmappable, resolvedGapReasonCode, rationale ?? null],
      );

      // Insert targets
      for (const t of resolvedTargets) {
        await client.query(
          `INSERT INTO adjudication_decision_targets
             (id, adjudication_decision_id, target_code, target_display, relationship_type)
           VALUES ($1, $2, $3, $4, $5)`,
          [uuidv4(), adjDecisionId, t.targetCode, t.targetDisplay, t.relationshipType],
        );
      }

      // Close queue item
      await client.query(
        `UPDATE adjudication_queue
         SET status = 'resolved', resolved_at = now(), adjudicator_id = $1
         WHERE id = $2`,
        [req.user!.id, itemId],
      );

      // Advance project_term status
      await client.query(
        `UPDATE project_terms
         SET status = 'adjudicated', updated_at = now()
         WHERE id = $1`,
        [projectTermId],
      );

      // Audit
      await client.query(
        `INSERT INTO audit_log
           (user_id, system_flag, action, entity_type, entity_id, project_id, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          req.user!.id, null,
          AuditAction.ADJUDICATION_RESOLVED,
          'adjudication_queue', itemId, projectId,
          JSON.stringify({ adjDecisionId, isUnmappable, acceptDecisionId: acceptDecisionId ?? null }),
        ],
      );

      await client.query('COMMIT');
      res.status(201).json({ adjudicationDecisionId: adjDecisionId });

    } catch (err) {
      await client.query('ROLLBACK');
      next(err);
    } finally {
      client.release();
    }
  },
);

// -----------------------------------------------------------------
// GET /adjudicator/:projectId/stats
// -----------------------------------------------------------------
router.get(
  '/:projectId/stats',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { rows } = await db.query(
        `SELECT
           COUNT(*) FILTER (WHERE aq.status = 'pending')  AS pending,
           COUNT(*) FILTER (WHERE aq.status = 'resolved') AS resolved,
           COUNT(*)                                        AS total
         FROM adjudication_queue aq
         WHERE aq.project_id = $1`,
        [req.params.projectId],
      );
      res.json(rows[0]);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
