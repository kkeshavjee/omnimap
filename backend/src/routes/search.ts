// OmniMap — Terminology Concept Search
// GET /search/concepts?q=&terminologyId=&limit=
//
// Search strategy (in priority order):
//   1. Infoway FHIR Terminology Server (SNOMED CT CA) — if INFOWAY_CLIENT_ID is set
//      Searches against live SNOMED CT Canadian Edition via ValueSet/$expand
//   2. Corpus fallback — searches canonical_mappings for previously used codes
//      Used when Infoway is not configured or the query fails
//
// Returns at most `limit` (default 20, max 50) candidates.

import { Router, Request, Response, NextFunction } from 'express';
import { db }                from '../services/db';
import { requireRole }       from '../middleware/rbac';
import { UserRole }          from '../types/enums';
import {
  isInfowayConfigured,
  searchSnomedConcepts,
} from '../services/infowayFhir';

const router = Router();

router.get(
  '/concepts',
  requireRole(UserRole.Reviewer, UserRole.Adjudicator, UserRole.Administrator),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { q, terminologyId } = req.query as Record<string, string | undefined>;
      const limit = Math.min(parseInt((req.query.limit as string) ?? '20', 10), 50);

      if (!q || q.trim().length < 2) {
        return res.json([]);
      }

      // ── (1) Infoway FHIR — live SNOMED CT CA ──────────────────
      if (isInfowayConfigured()) {
        try {
          const concepts = await searchSnomedConcepts(q.trim(), limit);
          if (concepts.length > 0) {
            return res.json(
              concepts.map(c => ({
                targetCode:       c.code,
                targetDisplay:    c.display,
                relationshipType: 'equivalent_to',
                usageCount:       0,
                source:           'infoway',
              })),
            );
          }
          // Fall through to corpus if Infoway returns nothing
        } catch (err) {
          // Log but don't fail — fall through to corpus
          console.warn('[search] Infoway lookup failed, falling back to corpus:', (err as Error).message);
        }
      }

      // ── (2) Corpus fallback — canonical_mappings ───────────────
      const qLike = `%${q.trim().toLowerCase()}%`;

      const conditions: string[] = [
        `cm.is_current = TRUE`,
        `cm.target_code != 'UNMAPPABLE'`,
        `(cm.target_display_lower ILIKE $1 OR LOWER(cm.target_code) ILIKE $1)`,
      ];
      const params: unknown[] = [qLike];

      if (terminologyId) {
        params.push(terminologyId);
        conditions.push(
          `EXISTS (
             SELECT 1 FROM project_terms pt2
             JOIN projects p2 ON p2.id = pt2.project_id
             WHERE pt2.id = cm.project_term_id
               AND p2.target_terminology_id = $${params.length}
           )`,
        );
      }

      params.push(limit);

      const { rows } = await db.query(
        `SELECT
           cm.target_code                                  AS "targetCode",
           cm.target_display_lower                         AS "targetDisplay",
           cm.relationship_type                            AS "relationshipType",
           COUNT(*)::INT                                   AS "usageCount"
         FROM canonical_mappings cm
         WHERE ${conditions.join(' AND ')}
         GROUP BY cm.target_code, cm.target_display_lower, cm.relationship_type
         ORDER BY COUNT(*) DESC
         LIMIT $${params.length}`,
        params,
      );

      res.json(rows);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
