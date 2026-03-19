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

const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.COGNITO_USER_POOL_ID!,
  tokenUse:   'access',
  clientId:   process.env.COGNITO_CLIENT_ID!,
});

// Roles that require MFA to be active on the token (FR-878)
const MFA_REQUIRED_ROLES: UserRole[] = [
  UserRole.Administrator,
  UserRole.Adjudicator,
];

export async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or malformed Authorization header' });
    return;
  }

  const token = authHeader.slice(7);

  try {
    const payload = await verifier.verify(token);

    const role = payload['custom:role'] as UserRole;
    const mfaEnabled = payload['custom:mfa_enabled'] === 'true';

    if (MFA_REQUIRED_ROLES.includes(role) && !mfaEnabled) {
      res.status(403).json({ error: 'MFA required for this role' });
      return;
    }

    // Look up DB user id from cognitoSub
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM users WHERE cognito_sub = $1 AND is_active = TRUE LIMIT 1`,
      [payload.sub],
    );
    if (rows.length === 0) {
      res.status(401).json({ error: 'User not found or inactive' });
      return;
    }

    req.user = {
      id:         rows[0].id,
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
