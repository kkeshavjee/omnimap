// OmniMap — Cognito JWT Authentication Middleware
// Validates AWS Cognito JWT tokens on every request.
// Attaches verified user payload to req.user.
// MFA is enforced for Administrator and Adjudicator roles (FR-878).

import { Request, Response, NextFunction } from 'express';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { UserRole } from '../types';
import { db } from '../services/db';

// Extend Express Request with verified user context
declare global {
  namespace Express {
    interface Request {
      user?: {
        id:         string;   // users.id (UUID from DB)
        cognitoSub: string;
        email:      string;
        role:       UserRole;
        mfaEnabled: boolean;
      };
    }
  }
}

// -----------------------------------------------------------------
// Dev bypass — set AUTH_BYPASS=true in backend/.env to skip Cognito
// -----------------------------------------------------------------

const DEV_BYPASS = process.env.AUTH_BYPASS === 'true';
const DEV_ROLE   = (process.env.AUTH_BYPASS_ROLE ?? 'administrator') as UserRole;

// Only instantiate the verifier when Cognito creds are present
const verifier = DEV_BYPASS ? null : CognitoJwtVerifier.create({
  userPoolId: process.env.COGNITO_USER_POOL_ID!,
  tokenUse:   'id',
  clientId:   process.env.COGNITO_CLIENT_ID!,
});

// Roles that require MFA to be active on the token (FR-878).
// Set ENFORCE_MFA=true in backend/.env when MFA is configured in Cognito.
const ENFORCE_MFA = process.env.ENFORCE_MFA === 'true';
const MFA_REQUIRED_ROLES: UserRole[] = ENFORCE_MFA
  ? [UserRole.Administrator, UserRole.Adjudicator]
  : [];

export async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // ------------------------------------------------------------------
  // Dev bypass path — inject a fixed dev user without hitting Cognito
  // ------------------------------------------------------------------
  if (DEV_BYPASS) {
    // Upsert a dev user so created_by FKs resolve to a real UUID
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO users (cognito_sub, email, display_name, role, is_active, mfa_enabled)
       VALUES ('dev-bypass-sub', 'dev@omnimap.local', 'Dev Admin', $1, TRUE, FALSE)
       ON CONFLICT (cognito_sub) DO UPDATE SET role = EXCLUDED.role
       RETURNING id`,
      [DEV_ROLE],
    );

    req.user = {
      id:         rows[0].id,
      cognitoSub: 'dev-bypass-sub',
      email:      'dev@omnimap.local',
      role:       DEV_ROLE,
      mfaEnabled: false,
    };
    next();
    return;
  }

  // ------------------------------------------------------------------
  // Normal Cognito JWT path
  // ------------------------------------------------------------------
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or malformed Authorization header' });
    return;
  }

  const token = authHeader.slice(7);

  try {
    const payload = await verifier!.verify(token);

    const role = (payload['custom:Role'] ?? payload['custom:role']) as UserRole;
    const mfaEnabled = payload['custom:mfa_enabled'] === 'true';

    if (MFA_REQUIRED_ROLES.includes(role) && !mfaEnabled) {
      res.status(403).json({ error: 'MFA required for this role' });
      return;
    }

    // Look up DB user — auto-provision on first login from Cognito claims
    const { rows: existing } = await db.query<{ id: string; is_active: boolean }>(
      `SELECT id, is_active FROM users WHERE cognito_sub = $1 LIMIT 1`,
      [payload.sub],
    );

    let userId: string;

    if (existing.length === 0) {
      // First login — insert row from JWT claims
      const { rows: created } = await db.query<{ id: string }>(
        `INSERT INTO users (cognito_sub, email, display_name, role, is_active, mfa_enabled)
         VALUES ($1, $2, $3, $4, TRUE, $5)
         ON CONFLICT (cognito_sub) DO UPDATE SET updated_at = now()
         RETURNING id`,
        [
          payload.sub,
          (payload.email as string) ?? '',
          (payload['name'] as string) ?? (payload.email as string) ?? payload.sub,
          role,
          mfaEnabled,
        ],
      );
      userId = created[0].id;
    } else if (!existing[0].is_active) {
      res.status(401).json({ error: 'Account is inactive' });
      return;
    } else {
      userId = existing[0].id;
    }

    req.user = {
      id:         userId,
      cognitoSub: payload.sub,
      email:      payload.email as string,
      role,
      mfaEnabled,
    };

    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}
