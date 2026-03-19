// OmniMap — Live Database Trigger Tests
// Verifies the four critical DB-level constraints against Supabase.
// Run with: npx ts-node scripts/test-triggers.ts
//
// Tests:
//   1. audit_log is append-only (UPDATE and DELETE blocked)
//   2. Locked holdout terms cannot be modified
//   3. mapping_decisions are immutable (only archival UPDATE allowed)
//   4. A project_term cannot have more than 2 active reviewer assignments

import * as path from 'path';
import * as dotenv from 'dotenv';
import { Pool } from 'pg';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL!,
  ssl: { rejectUnauthorized: false },
});

let passed = 0;
let failed = 0;

async function expect_error(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.error(`  FAIL  ${label} — expected an error but got none`);
    failed++;
  } catch (err: any) {
    console.log(`  PASS  ${label}`);
    console.log(`        → ${err.message.split('\n')[0]}`);
    passed++;
  }
}

async function expect_ok(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  PASS  ${label}`);
    passed++;
  } catch (err: any) {
    console.error(`  FAIL  ${label} — unexpected error: ${err.message.split('\n')[0]}`);
    failed++;
  }
}

async function run() {
  const client = await pool.connect();

  try {
    // -------------------------------------------------------
    // Seed minimal required rows for FK chains
    // -------------------------------------------------------
    await client.query('BEGIN');

    // Terminology (already seeded — just fetch snomed_ct id)
    const { rows: [{ id: termId }] } = await client.query(
      `SELECT id FROM terminologies WHERE code = 'snomed_ct'`
    );

    // User
    const { rows: [{ id: userId }] } = await client.query(`
      INSERT INTO users (cognito_sub, email, display_name, role)
      VALUES ('test-sub-trigger', 'trigger@test.com', 'Trigger Test', 'administrator')
      RETURNING id
    `);

    // Project
    const { rows: [{ id: projectId }] } = await client.query(`
      INSERT INTO projects (name, target_terminology_id, created_by)
      VALUES ('Trigger Test Project', $1, $2)
      RETURNING id
    `, [termId, userId]);

    // EMR Extract
    const { rows: [{ id: extractId }] } = await client.query(`
      INSERT INTO emr_extracts (project_id, filename, uploaded_by)
      VALUES ($1, 'test.csv', $2)
      RETURNING id
    `, [projectId, userId]);

    // Source term
    const { rows: [{ id: sourceTermId }] } = await client.query(`
      INSERT INTO source_terms (extract_id, project_id, source_code, display_term)
      VALUES ($1, $2, 'TEST001', 'Test Term')
      RETURNING id
    `, [extractId, projectId]);

    // Project term
    const { rows: [{ id: projectTermId }] } = await client.query(`
      INSERT INTO project_terms (project_id, source_term_id)
      VALUES ($1, $2)
      RETURNING id
    `, [projectId, sourceTermId]);

    await client.query('COMMIT');

    // -------------------------------------------------------
    // TEST 1 — audit_log: UPDATE blocked
    // -------------------------------------------------------
    console.log('\n1. audit_log is append-only');

    const { rows: [{ id: auditId }] } = await client.query(`
      INSERT INTO audit_log (action, entity_type, project_id)
      VALUES ('TEST_EVENT', 'project', $1)
      RETURNING id
    `, [projectId]);

    await expect_error('UPDATE on audit_log is blocked', async () => {
      await client.query(`UPDATE audit_log SET action = 'TAMPERED' WHERE id = $1`, [auditId]);
    });

    await expect_error('DELETE on audit_log is blocked', async () => {
      await client.query(`DELETE FROM audit_log WHERE id = $1`, [auditId]);
    });

    // -------------------------------------------------------
    // TEST 2 — holdout lock: locked terms cannot be modified
    // -------------------------------------------------------
    console.log('\n2. Locked holdout terms are immutable');

    // Lock the project_term as holdout
    await client.query(`
      UPDATE project_terms
      SET is_holdout = TRUE, holdout_locked = TRUE, holdout_locked_at = now(),
          status = 'holdout'
      WHERE id = $1
    `, [projectTermId]);

    await expect_error('Cannot change is_holdout on locked term', async () => {
      await client.query(`
        UPDATE project_terms SET is_holdout = FALSE WHERE id = $1
      `, [projectTermId]);
    });

    await expect_ok('Non-holdout fields (status) can still be updated', async () => {
      await client.query(`
        UPDATE project_terms SET status = 'canonicalised' WHERE id = $1
      `, [projectTermId]);
    });

    // Reset for next tests
    await client.query(`
      UPDATE project_terms
      SET holdout_locked = FALSE, is_holdout = FALSE, status = 'allocated'
      WHERE id = $1
    `, [projectTermId]);

    // -------------------------------------------------------
    // TEST 3 — reviewer assignments: max 2 per project_term
    // -------------------------------------------------------
    console.log('\n3. Max 2 active reviewer assignments per project_term');

    // Create two reviewer users
    const { rows: [{ id: rev1Id }] } = await client.query(`
      INSERT INTO users (cognito_sub, email, display_name, role)
      VALUES ('rev1-sub', 'rev1@test.com', 'Reviewer One', 'reviewer')
      RETURNING id
    `);
    const { rows: [{ id: rev2Id }] } = await client.query(`
      INSERT INTO users (cognito_sub, email, display_name, role)
      VALUES ('rev2-sub', 'rev2@test.com', 'Reviewer Two', 'reviewer')
      RETURNING id
    `);
    const { rows: [{ id: rev3Id }] } = await client.query(`
      INSERT INTO users (cognito_sub, email, display_name, role)
      VALUES ('rev3-sub', 'rev3@test.com', 'Reviewer Three', 'reviewer')
      RETURNING id
    `);

    await expect_ok('First assignment succeeds', async () => {
      await client.query(`
        INSERT INTO reviewer_assignments (project_term_id, reviewer_id, project_id)
        VALUES ($1, $2, $3)
      `, [projectTermId, rev1Id, projectId]);
    });

    await expect_ok('Second assignment succeeds', async () => {
      await client.query(`
        INSERT INTO reviewer_assignments (project_term_id, reviewer_id, project_id)
        VALUES ($1, $2, $3)
      `, [projectTermId, rev2Id, projectId]);
    });

    await expect_error('Third assignment is blocked', async () => {
      await client.query(`
        INSERT INTO reviewer_assignments (project_term_id, reviewer_id, project_id)
        VALUES ($1, $2, $3)
      `, [projectTermId, rev3Id, projectId]);
    });

    // -------------------------------------------------------
    // TEST 4 — mapping_decisions: immutable (no arbitrary UPDATE)
    // -------------------------------------------------------
    console.log('\n4. mapping_decisions are immutable');

    // Need an assignment first
    const { rows: [{ id: assignId }] } = await client.query(`
      SELECT id FROM reviewer_assignments
      WHERE project_term_id = $1 AND reviewer_id = $2
    `, [projectTermId, rev1Id]);

    const { rows: [{ id: decisionId }] } = await client.query(`
      INSERT INTO mapping_decisions (project_term_id, assignment_id, reviewer_id, project_id)
      VALUES ($1, $2, $3, $4)
      RETURNING id
    `, [projectTermId, assignId, rev1Id, projectId]);

    await expect_error('Arbitrary UPDATE on mapping_decisions is blocked', async () => {
      await client.query(`
        UPDATE mapping_decisions SET rationale = 'tampered' WHERE id = $1
      `, [decisionId]);
    });

    await expect_ok('Archival UPDATE (is_current=FALSE + superseded_by) is allowed', async () => {
      // Create a new decision to supersede with
      const { rows: [{ id: newDecisionId }] } = await client.query(`
        INSERT INTO mapping_decisions (project_term_id, assignment_id, reviewer_id, project_id, version)
        VALUES ($1, $2, $3, $4, 2)
        RETURNING id
      `, [projectTermId, assignId, rev1Id, projectId]);

      await client.query(`
        UPDATE mapping_decisions
        SET is_current = FALSE, superseded_by = $1
        WHERE id = $2
      `, [newDecisionId, decisionId]);
    });

    // -------------------------------------------------------
    // Cleanup
    // -------------------------------------------------------
    await client.query(`DELETE FROM mapping_decisions WHERE project_id = $1`, [projectId]);
    await client.query(`DELETE FROM reviewer_assignments WHERE project_id = $1`, [projectId]);
    await client.query(`DELETE FROM project_terms WHERE project_id = $1`, [projectId]);
    await client.query(`DELETE FROM source_terms WHERE project_id = $1`, [projectId]);
    await client.query(`DELETE FROM emr_extracts WHERE project_id = $1`, [projectId]);
    await client.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
    await client.query(`DELETE FROM users WHERE id IN ($1, $2, $3, $4)`,
      [userId, rev1Id, rev2Id, rev3Id]);

  } finally {
    client.release();
    await pool.end();
  }

  // -------------------------------------------------------
  // Results
  // -------------------------------------------------------
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`  ${passed + failed} tests — ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
