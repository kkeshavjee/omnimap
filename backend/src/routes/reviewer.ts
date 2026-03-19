// OmniMap — Reviewer Router (Node 6: MAP)
// Endpoints:
//   GET  /reviewer/:projectId/queue  — reviewer's assigned terms (own only)
//   POST /reviewer/:projectId/map    — submit a mapping decision
//   GET  /reviewer/:projectId/stats  — personal metrics (own only)
//
// Independence constraint: all queries are scoped to req.user.id.
// Never expose another reviewer's assignments or decisions.

import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 }   from 'uuid';
import { db }             from '../services/db';
import { requireRole }    from '../middleware/rbac';
import { AuditAction }    from '../middleware/auditLog';
import { UserRole, TermStatus, MappingRelationship } from '../types/enums';

const router = Router({ mergeParams: true });

// All reviewer routes require the Reviewer role
router.use(requireRole(UserRole.Reviewer));

// -----------------------------------------------------------------
// GET /reviewer/:projectId/queue
// Returns this reviewer's assigned terms, not yet completed.
// -----------------------------------------------------------------
router.get(
  '/:projectId/queue',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { rows } = await db.query(
        `SELECT
           ra.id            AS "assignmentId",
           pt.id            AS "projectTermId",
           st.source_code   AS "sourceCode",
           st.display_term  AS "displayTerm",
           st.frequency     AS frequency,
           st.clinical_domain AS "clinicalDomain",
           pt.status        AS status
         FROM reviewer_assignments ra
         JOIN project_terms  pt ON pt.id = ra.project_term_id
         JOIN source_terms   st ON st.id = pt.source_term_id
         WHERE ra.project_id  = $1
           AND ra.reviewer_id = $2
           AND ra.is_active   = TRUE
           AND ra.completed_at IS NULL
         ORDER BY pt.long_tail_priority_score DESC NULLS LAST,
                  ra.assigned_at ASC`,
        [req.params.projectId, req.user!.id],
      );
      res.json(rows);
    } catch (err) {
      next(err);
    }
  },
);

// -----------------------------------------------------------------
// POST /reviewer/:projectId/map
// Submit a mapping decision for one assigned term.
// Body: { assignmentId, projectTermId, isUnmappable, targets[], rationale?, isAiAssisted? }
// targets: [{ targetCode, targetDisplay, relationshipType }]
//
// Batch accept of AI suggestions is PROHIBITED at the API level (PRD FR-48).
// -----------------------------------------------------------------
router.post(
  '/:projectId/map',
  async (req: Request, res: Response, next: NextFunction) => {
    const { assignmentId, projectTermId, isUnmappable, targets, rationale, isAiAssisted } =
      req.body as {
        assignmentId:  string;
        projectTermId: string;
        isUnmappable:  boolean;
        targets:       Array<{
          targetCode:       string;
          targetDisplay:    string;
          relationshipType: MappingRelationship;
        }>;
        rationale?:    string;
        isAiAssisted?: boolean;
      };

    // Validation
    if (!assignmentId || !projectTermId) {
      return res.status(400).json({ error: 'assignmentId and projectTermId are required' });
    }
    if (!isUnmappable && (!Array.isArray(targets) || targets.length === 0)) {
      return res.status(400).json({ error: 'targets required when isUnmappable is false' });
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      // Verify this assignment belongs to the authenticated reviewer
      const { rows: assignRows } = await client.query(
        `SELECT id FROM reviewer_assignments
         WHERE id = $1 AND reviewer_id = $2 AND project_id = $3
           AND is_active = TRUE AND completed_at IS NULL`,
        [assignmentId, req.user!.id, req.params.projectId],
      );
      if (assignRows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Assignment not found or already completed' });
      }

      // Determine next version number (corrections create new records)
      const { rows: versionRows } = await client.query<{ maxVersion: number }>(
        `SELECT COALESCE(MAX(version), 0) AS "maxVersion"
         FROM mapping_decisions WHERE project_term_id = $1`,
        [projectTermId],
      );
      const version = (versionRows[0]?.maxVersion ?? 0) + 1;

      // Insert mapping decision (immutable record)
      const decisionId = uuidv4();
      await client.query(
        `INSERT INTO mapping_decisions (
           id, project_term_id, assignment_id, reviewer_id, project_id,
           is_unmappable, unmappable_reason, rationale, is_ai_assisted,
           version, is_current
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE)`,
        [
          decisionId,
          projectTermId,
          assignmentId,
          req.user!.id,
          req.params.projectId,
          isUnmappable,
          isUnmappable ? (rationale ?? null) : null,
          rationale ?? null,
          isAiAssisted ?? false,
          version,
        ],
      );

      // Insert target mappings
      if (!isUnmappable && targets.length > 0) {
        for (const t of targets) {
          await client.query(
            `INSERT INTO mapping_decision_targets
               (id, mapping_decision_id, target_code, target_display, relationship_type)
             VALUES ($1, $2, $3, $4, $5)`,
            [uuidv4(), decisionId, t.targetCode, t.targetDisplay, t.relationshipType],
          );
        }
      }

      // Mark assignment completed; update project_term to in_progress
      await client.query(
        `UPDATE reviewer_assignments
         SET completed_at = now(), is_active = FALSE
         WHERE id = $1`,
        [assignmentId],
      );

      await client.query(
        `UPDATE project_terms
         SET status = $1, updated_at = now()
         WHERE id = $2`,
        [TermStatus.MappingInProgress, projectTermId],
      );

      // Check if BOTH reviewers have now submitted for this term
      const { rows: bothRows } = await client.query<{ cnt: string }>(
        `SELECT COUNT(*)::TEXT AS cnt
         FROM mapping_decisions md
         WHERE md.project_term_id = $1 AND md.is_current = TRUE`,
        [projectTermId],
      );
      const bothSubmitted = parseInt(bothRows[0].cnt, 10) >= 2;

      if (bothSubmitted) {
        // Compare decisions: do targets match?
        const { rows: decRows } = await client.query<{
          decisionId: string;
          isUnmappable: boolean;
          targets: string;
        }>(
          `SELECT
             md.id AS "decisionId",
             md.is_unmappable AS "isUnmappable",
             COALESCE(
               json_agg(
                 json_build_object(
                   'targetCode', mdt.target_code,
                   'relationshipType', mdt.relationship_type
                 ) ORDER BY mdt.target_code
               ) FILTER (WHERE mdt.id IS NOT NULL),
               '[]'
             )::TEXT AS targets
           FROM mapping_decisions md
           LEFT JOIN mapping_decision_targets mdt ON mdt.mapping_decision_id = md.id
           WHERE md.project_term_id = $1 AND md.is_current = TRUE
           GROUP BY md.id, md.is_unmappable`,
          [projectTermId],
        );

        const agreed =
          decRows.length === 2 &&
          decRows[0].isUnmappable === decRows[1].isUnmappable &&
          decRows[0].targets === decRows[1].targets;

        if (agreed) {
          // Both agree → canonicalise
          await client.query(
            `UPDATE project_terms SET status = 'agreed', updated_at = now() WHERE id = $1`,
            [projectTermId],
          );
        } else {
          // Discrepancy → adjudication queue
          await client.query(
            `UPDATE project_terms SET status = 'adjudication_queued', updated_at = now()
             WHERE id = $1`,
            [projectTermId],
          );
          await client.query(
            `INSERT INTO adjudication_queue
               (id, project_term_id, project_id, mapping_decision_a, mapping_decision_b, status)
             VALUES ($1, $2, $3, $4, $5, 'pending')`,
            [
              uuidv4(),
              projectTermId,
              req.params.projectId,
              decRows[0].decisionId,
              decRows[1].decisionId,
            ],
          );
        }
      }

      // Audit log
      await client.query(
        `INSERT INTO audit_log
           (user_id, system_flag, action, entity_type, entity_id, project_id, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          req.user!.id, null,
          AuditAction.MAPPING_SUBMITTED,
          'mapping_decision', decisionId, req.params.projectId,
          JSON.stringify({ assignmentId, projectTermId, isUnmappable, isAiAssisted }),
        ],
      );

      if (bothSubmitted) {
        await client.query(
          `INSERT INTO audit_log
             (user_id, system_flag, action, entity_type, entity_id, project_id, payload)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            null, 'COMPARISON',
            AuditAction.MAPPING_AGREED,
            'project_term', projectTermId, req.params.projectId,
            JSON.stringify({ agreed: true }),
          ],
        );
      }

      await client.query('COMMIT');
      res.status(201).json({ mappingDecisionId: decisionId });

    } catch (err) {
      await client.query('ROLLBACK');
      next(err);
    } finally {
      client.release();
    }
  },
);

// -----------------------------------------------------------------
// GET /reviewer/:projectId/stats  — personal metrics (own data only)
// -----------------------------------------------------------------
router.get(
  '/:projectId/stats',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { rows } = await db.query(
        `SELECT
           COUNT(*)                                        AS assigned,
           COUNT(*) FILTER (WHERE ra.completed_at IS NOT NULL) AS completed,
           COUNT(*) FILTER (WHERE ra.completed_at IS NULL
                              AND ra.started_at IS NOT NULL)    AS "inProgress",
           ROUND(
             AVG(
               EXTRACT(EPOCH FROM (ra.completed_at - ra.started_at)) / 60
             ) FILTER (WHERE ra.completed_at IS NOT NULL
                         AND ra.started_at   IS NOT NULL),
           1)::FLOAT AS "averageMinutesPerTerm"
         FROM reviewer_assignments ra
         WHERE ra.project_id  = $1
           AND ra.reviewer_id = $2`,
        [req.params.projectId, req.user!.id],
      );
      res.json(rows[0]);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
