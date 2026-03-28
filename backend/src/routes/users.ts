// OmniMap — User Management API
//
// Administrators can invite, view, update, and deactivate users.
// Each operation touches BOTH layers:
//   1. AWS Cognito User Pool  — actual credentials + custom:role attribute
//   2. PostgreSQL users table — DB UUID used for all foreign keys
//
// Endpoints:
//   GET  /api/users              list all users (admin only)
//   POST /api/users/invite       create Cognito user + DB record; sends temp-password email
//   PUT  /api/users/:id          update display_name and/or role
//   PUT  /api/users/:id/deactivate   disable in Cognito + set is_active = false in DB
//   PUT  /api/users/:id/reactivate   re-enable in Cognito + set is_active = true in DB

import { Router, Request, Response, NextFunction } from 'express';
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminUpdateUserAttributesCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { db }          from '../services/db';
import { requireRole } from '../middleware/rbac';
import { UserRole }    from '../types/enums';
import { v4 as uuidv4 } from 'uuid';

const router   = Router();
const adminOnly = requireRole(UserRole.Administrator);

// -----------------------------------------------------------------
// Cognito client — credentials from environment / IAM role
// -----------------------------------------------------------------

const cognitoClient = new CognitoIdentityProviderClient({
  region: process.env.AWS_REGION ?? process.env.COGNITO_REGION ?? 'us-east-1',
});

const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID!;

const VALID_ROLES: UserRole[] = [
  UserRole.Administrator,
  UserRole.Reviewer,
  UserRole.Adjudicator,
  UserRole.Auditor,
];

// -----------------------------------------------------------------
// GET /api/users
// Returns all users ordered by role then email
// -----------------------------------------------------------------

router.get('/', adminOnly, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { rows } = await db.query(
      `SELECT
         id, cognito_sub AS "cognitoSub", email, display_name AS "displayName",
         role, is_active AS "isActive", mfa_enabled AS "mfaEnabled",
         created_at AS "createdAt", updated_at AS "updatedAt"
       FROM users
       WHERE cognito_sub != 'dev-bypass-sub'
       ORDER BY
         CASE role
           WHEN 'administrator' THEN 1
           WHEN 'adjudicator'   THEN 2
           WHEN 'reviewer'      THEN 3
           WHEN 'auditor'       THEN 4
         END,
         email`,
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// -----------------------------------------------------------------
// POST /api/users/invite
// Body: { email, displayName, role }
//
// Creates the Cognito user (triggers temp-password email), sets
// custom:role, then inserts into the users DB table.
// -----------------------------------------------------------------

router.post('/invite', adminOnly, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, displayName, role } = req.body as Record<string, unknown>;

    if (typeof email !== 'string' || !email.includes('@')) {
      res.status(400).json({ error: 'Valid email is required' });
      return;
    }
    if (typeof displayName !== 'string' || !displayName.trim()) {
      res.status(400).json({ error: 'displayName is required' });
      return;
    }
    if (!VALID_ROLES.includes(role as UserRole)) {
      res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });
      return;
    }

    // Check for duplicate in DB
    const { rows: existing } = await db.query(
      `SELECT id FROM users WHERE email = $1`,
      [email.toLowerCase()],
    );
    if (existing.length > 0) {
      res.status(409).json({ error: 'A user with this email already exists' });
      return;
    }

    // 1. Create in Cognito — Cognito generates a temp password and emails it
    const cognitoResult = await cognitoClient.send(new AdminCreateUserCommand({
      UserPoolId: USER_POOL_ID,
      Username:   email.toLowerCase(),
      UserAttributes: [
        { Name: 'email',          Value: email.toLowerCase() },
        { Name: 'email_verified', Value: 'true' },
        { Name: 'name',           Value: (displayName as string).trim() },
        { Name: 'custom:Role',    Value: role as string },
      ],
      DesiredDeliveryMediums: ['EMAIL'],
    }));
    const cognitoSub = cognitoResult.User?.Attributes?.find(a => a.Name === 'sub')?.Value;

    if (!cognitoSub) {
      throw new Error('Cognito did not return a sub for the new user');
    }

    // 2. Insert into DB
    const userId = uuidv4();
    const { rows } = await db.query(
      `INSERT INTO users (id, cognito_sub, email, display_name, role, is_active, mfa_enabled)
       VALUES ($1, $2, $3, $4, $5, TRUE, FALSE)
       RETURNING
         id, cognito_sub AS "cognitoSub", email, display_name AS "displayName",
         role, is_active AS "isActive", mfa_enabled AS "mfaEnabled",
         created_at AS "createdAt", updated_at AS "updatedAt"`,
      [userId, cognitoSub, email.toLowerCase(), (displayName as string).trim(), role],
    );

    res.status(201).json(rows[0]);
  } catch (err: unknown) {
    // Surface Cognito-specific errors clearly
    const e = err as Error & { name?: string };
    if (e.name === 'UsernameExistsException') {
      res.status(409).json({ error: 'This email already exists in Cognito. Sync the DB record manually if needed.' });
      return;
    }
    next(err);
  }
});

// -----------------------------------------------------------------
// PUT /api/users/:id
// Body: { displayName?, role? }
// Updates display_name in DB and custom:role in both DB and Cognito.
// -----------------------------------------------------------------

router.put('/:id', adminOnly, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { displayName, role } = req.body as Record<string, unknown>;

    if (role !== undefined && !VALID_ROLES.includes(role as UserRole)) {
      res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });
      return;
    }

    // Fetch current user to get cognitoSub
    const { rows: current } = await db.query(
      `SELECT cognito_sub, role FROM users WHERE id = $1 AND is_active = TRUE`,
      [id],
    );
    if (current.length === 0) {
      res.status(404).json({ error: 'User not found or inactive' });
      return;
    }

    const cognitoSub = current[0].cognito_sub;

    // Update DB
    const setClauses: string[] = [];
    const params: unknown[]    = [];

    if (displayName !== undefined) {
      params.push((displayName as string).trim());
      setClauses.push(`display_name = $${params.length}`);
    }
    if (role !== undefined) {
      params.push(role);
      setClauses.push(`role = $${params.length}`);
    }

    if (setClauses.length === 0) {
      res.status(400).json({ error: 'Nothing to update' });
      return;
    }

    params.push(id);
    const { rows } = await db.query(
      `UPDATE users SET ${setClauses.join(', ')}, updated_at = now()
       WHERE id = $${params.length}
       RETURNING
         id, cognito_sub AS "cognitoSub", email, display_name AS "displayName",
         role, is_active AS "isActive", mfa_enabled AS "mfaEnabled",
         created_at AS "createdAt", updated_at AS "updatedAt"`,
      params,
    );

    // Sync role change to Cognito
    if (role !== undefined) {
      await cognitoClient.send(new AdminUpdateUserAttributesCommand({
        UserPoolId:     USER_POOL_ID,
        Username:       cognitoSub,
        UserAttributes: [{ Name: 'custom:Role', Value: role as string }],
      }));
    }

    res.json(rows[0]);
  } catch (err) { next(err); }
});

// -----------------------------------------------------------------
// PUT /api/users/:id/deactivate
// Disables in Cognito (prevents login) + sets is_active = false in DB.
// Does NOT delete — all mapping history is preserved.
// -----------------------------------------------------------------

router.put('/:id/deactivate', adminOnly, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    // Prevent self-deactivation
    if (req.user?.id === id) {
      res.status(400).json({ error: 'You cannot deactivate your own account' });
      return;
    }

    const { rows } = await db.query(
      `UPDATE users SET is_active = FALSE, updated_at = now()
       WHERE id = $1 AND is_active = TRUE
       RETURNING cognito_sub AS "cognitoSub", email`,
      [id],
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'User not found or already inactive' });
      return;
    }

    await cognitoClient.send(new AdminDisableUserCommand({
      UserPoolId: USER_POOL_ID,
      Username:   rows[0].cognitoSub,
    }));

    res.json({ id, isActive: false, email: rows[0].email });
  } catch (err) { next(err); }
});

// -----------------------------------------------------------------
// PUT /api/users/:id/reactivate
// Re-enables in Cognito + sets is_active = true in DB.
// -----------------------------------------------------------------

router.put('/:id/reactivate', adminOnly, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const { rows } = await db.query(
      `UPDATE users SET is_active = TRUE, updated_at = now()
       WHERE id = $1 AND is_active = FALSE
       RETURNING cognito_sub AS "cognitoSub", email`,
      [id],
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'User not found or already active' });
      return;
    }

    await cognitoClient.send(new AdminEnableUserCommand({
      UserPoolId: USER_POOL_ID,
      Username:   rows[0].cognitoSub,
    }));

    res.json({ id, isActive: true, email: rows[0].email });
  } catch (err) { next(err); }
});

export default router;
