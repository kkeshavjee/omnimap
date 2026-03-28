#!/usr/bin/env ts-node
// OmniMap — One-time admin bootstrap
//
// Creates the first administrator account in BOTH:
//   1. AWS Cognito User Pool  (sends a temporary password to the email)
//   2. PostgreSQL users table (so the backend can look up the user)
//
// Run once, then use the Users page in the OmniMap UI for all future accounts.
//
// Usage:
//   npx ts-node scripts/bootstrapAdmin.ts \
//     --email="you@hospital.ca" \
//     --name="Dr. Your Name"
//
// Prerequisites:
//   • backend/.env must have DATABASE_URL, COGNITO_USER_POOL_ID, AWS_REGION
//   • AWS credentials must be available:
//       - AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY in .env, OR
//       - ~/.aws/credentials (from `aws configure`), OR
//       - an IAM role attached to this machine
//   Required Cognito permission: cognito-idp:AdminCreateUser

import * as path   from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminGetUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { v4 as uuidv4 } from 'uuid';
import { db }           from '../src/services/db';

// -----------------------------------------------------------------
// Parse CLI args
// -----------------------------------------------------------------

function arg(name: string): string | undefined {
  return process.argv
    .find(a => a.startsWith(`--${name}=`))
    ?.replace(`--${name}=`, '');
}

const email       = arg('email');
const displayName = arg('name');

if (!email || !displayName) {
  console.error(`
Usage:
  npx ts-node scripts/bootstrapAdmin.ts --email="you@hospital.ca" --name="Dr. Your Name"
`);
  process.exit(1);
}

const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;
const AWS_REGION   = process.env.AWS_REGION ?? process.env.COGNITO_REGION ?? 'us-east-1';

if (!USER_POOL_ID) {
  console.error('ERROR: COGNITO_USER_POOL_ID is not set in .env');
  process.exit(1);
}

// -----------------------------------------------------------------
// Main
// -----------------------------------------------------------------

async function bootstrap() {
  const cognito = new CognitoIdentityProviderClient({ region: AWS_REGION });

  console.log(`\nBootstrapping admin account for: ${email}`);
  console.log(`User Pool: ${USER_POOL_ID}  (${AWS_REGION})\n`);

  // ---- Step 1: Check if user already exists in DB ----
  const { rows: existing } = await db.query(
    `SELECT id, role FROM users WHERE email = $1`,
    [email!.toLowerCase()],
  );
  if (existing.length > 0) {
    console.log(`✓ DB record already exists (role: ${existing[0].role}, id: ${existing[0].id})`);
    console.log('  Nothing to do — account is already bootstrapped.');
    return;
  }

  // ---- Step 2: Create or retrieve Cognito user ----
  let cognitoSub: string | undefined;

  // Check if already in Cognito
  try {
    const existing = await cognito.send(new AdminGetUserCommand({
      UserPoolId: USER_POOL_ID,
      Username:   email!.toLowerCase(),
    }));
    cognitoSub = existing.UserAttributes?.find(a => a.Name === 'sub')?.Value;
    console.log(`✓ Cognito user already exists (sub: ${cognitoSub})`);
    console.log('  Skipping Cognito creation — will only insert DB record.\n');
  } catch (e: unknown) {
    if ((e as Error & { name?: string }).name !== 'UserNotFoundException') throw e;
    // Not in Cognito yet — create them
  }

  if (!cognitoSub) {
    console.log('Creating Cognito user…');
    const result = await cognito.send(new AdminCreateUserCommand({
      UserPoolId: USER_POOL_ID,
      Username:   email!.toLowerCase(),
      UserAttributes: [
        { Name: 'email',          Value: email!.toLowerCase() },
        { Name: 'email_verified', Value: 'true' },
        { Name: 'name',           Value: displayName! },
        { Name: 'custom:role',    Value: 'administrator' },
      ],
      DesiredDeliveryMediums: ['EMAIL'],
      // Cognito will generate a temporary password and email it
    }));

    cognitoSub = result.User?.Attributes?.find(a => a.Name === 'sub')?.Value;

    if (!cognitoSub) {
      throw new Error('Cognito did not return a sub — cannot continue');
    }
    console.log(`✓ Cognito user created (sub: ${cognitoSub})`);
    console.log(`  A temporary password has been sent to: ${email}\n`);
  }

  // ---- Step 3: Insert into DB ----
  const userId = uuidv4();
  await db.query(
    `INSERT INTO users (id, cognito_sub, email, display_name, role, is_active, mfa_enabled)
     VALUES ($1, $2, $3, $4, 'administrator', TRUE, FALSE)`,
    [userId, cognitoSub, email!.toLowerCase(), displayName!],
  );

  console.log(`✓ DB record inserted (id: ${userId})`);
  console.log(`\n✅  Bootstrap complete!`);
  console.log(`\n   Email:    ${email}`);
  console.log(`   Role:     administrator`);
  console.log(`   DB id:    ${userId}`);
  console.log(`   Cognito:  ${cognitoSub}`);
  console.log(`\n   Check your email for the temporary password.`);
  console.log(`   On first login Cognito will ask you to set a permanent password.\n`);
}

bootstrap()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('\n✗ Bootstrap failed:', err.message ?? err);
    if (err.message?.includes('credential')) {
      console.error(`
  AWS credentials not found. Add to backend/.env:
    AWS_ACCESS_KEY_ID=...
    AWS_SECRET_ACCESS_KEY=...
  Or run: aws configure
`);
    }
    process.exit(1);
  });
