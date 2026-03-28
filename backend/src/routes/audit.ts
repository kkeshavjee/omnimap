// OmniMap — Audit Log Router
// GET /audit  — paginated, filterable audit log (admin + auditor only)
//
// Query params:
//   projectId  — filter to one project
//   action     — filter to one action type
//   limit      — page size (default 50, max 200)
//   before     — ISO timestamp cursor (occurred_at < before)

import { Router, Request, Response, NextFunction } from 'express';
import { db }          from '../services/db';
import { requireRole } from '../middleware/rbac';
import { UserRole }    from '../types/enums';

const router = Router();

router.get(
  '/',
  requireRole(UserRole.Administrator, UserRole.Auditor),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { projectId, action, before } = req.query as Record<string, string | undefined>;
      const limit = Math.min(parseInt((req.query.limit as string) ?? '50', 10), 200);

      const conditions: string[] = [];
      const params: unknown[]    = [];

      if (projectId) {
        params.push(projectId);
        conditions.push(`al.project_id = $${params.length}`);
      }
      if (action) {
        params.push(action);
        conditions.push(`al.action = $${params.length}`);
      }
      if (before) {
        params.push(before);
        conditions.push(`al.occurred_at < $${params.length}`);
      }

      params.push(limit);
      const WHERE = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

      const { rows } = await db.query(
        `SELECT
           al.id           AS id,
           al.event_id     AS "eventId",
           al.user_id      AS "userId",
           u.email         AS "userEmail",
           al.system_flag  AS "systemFlag",
           al.action,
           al.entity_type  AS "entityType",
           al.entity_id    AS "entityId",
           al.project_id   AS "projectId",
           p.name          AS "projectName",
           al.payload,
           al.occurred_at  AS "occurredAt"
         FROM audit_log al
         LEFT JOIN users       u ON u.id = al.user_id
         LEFT JOIN projects    p ON p.id = al.project_id
         ${WHERE}
         ORDER BY al.occurred_at DESC
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
