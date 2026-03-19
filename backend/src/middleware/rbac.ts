// OmniMap — Role-Based Access Control Middleware
// Enforces role permissions at the route layer.
// Data-layer isolation (reviewer blinding) is separate and
// enforced in service queries — RBAC alone is not sufficient.

import { Request, Response, NextFunction } from 'express';
import { UserRole } from '../types';

/**
 * Require the authenticated user to hold one of the specified roles.
 * Chain after authenticate().
 *
 * Example:
 *   router.post('/projects', authenticate, requireRole(UserRole.Administrator), handler)
 */
export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }

    if (!roles.includes(req.user.role)) {
      res.status(403).json({
        error:    'Forbidden',
        required: roles,
        actual:   req.user.role,
      });
      return;
    }

    next();
  };
}

// Convenience role-set constants — use these in routes for clarity.
export const adminOnly      = [UserRole.Administrator] as const;
export const reviewerRoles  = [UserRole.Reviewer] as const;
export const adjudicatorOnly = [UserRole.Adjudicator] as const;
export const readRoles      = [
  UserRole.Administrator,
  UserRole.Reviewer,
  UserRole.Adjudicator,
  UserRole.Auditor,
] as const;
export const writeRoles     = [
  UserRole.Administrator,
  UserRole.Reviewer,
  UserRole.Adjudicator,
] as const;
