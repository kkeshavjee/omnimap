// OmniMap — Terminologies Router
// Returns the list of active terminologies for use in project creation.

import { Router, Request, Response, NextFunction } from 'express';
import { db } from '../services/db';
import { requireRole } from '../middleware/rbac';
import { UserRole } from '../types/enums';

const router = Router();

router.get(
  '/',
  requireRole(UserRole.Administrator, UserRole.Reviewer, UserRole.Adjudicator, UserRole.Auditor),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const { rows } = await db.query(
        `SELECT id, code, display_name AS "displayName", version, is_active AS "isActive"
         FROM terminologies WHERE is_active = TRUE ORDER BY display_name`,
      );
      res.json(rows);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
