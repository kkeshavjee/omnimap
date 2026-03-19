// OmniMap — Node 5: ALLOCATE
// Assigns every non-auto-matched term in the mapping pool to exactly 2 independent
// reviewers from the certified project pool, weighted by affinity score and availability.
// Long tail terms fill reviewer capacity above the power-determined minimum task load.
//
// Rules (from PRD FR-24 to FR-26):
//   • Every term → exactly 2 reviewers (enforced at INSERT level).
//   • No reviewer sees another reviewer's assignment or decision (data-layer independence).
//   • Allocation is affinity-weighted: reviewers with higher affinity for the target
//     terminology receive a proportionally larger share.
//   • Long tail terms fill remaining capacity after minimum load is covered.
//   • Load balancer runs silently — no notifications, no admin override.
//
// Triggers: Node 6 — MAP (event per reviewer queue item)

import { v4 as uuidv4 }  from 'uuid';
import { db }            from './db';
import { emit }          from './events';
import { AuditAction }   from '../middleware/auditLog';
import { TermStatus }    from '../types/enums';

// -----------------------------------------------------------------
// Internal types
// -----------------------------------------------------------------

interface Reviewer {
  userId:       string;
  affinityScore: number;   // 0–1; higher = more terminology-aligned
  termsPerDay:   number | null;
  hoursPerWeek:  number | null;
}

interface TermToAllocate {
  projectTermId:       string;
  longTailPriorityScore: number | null;  // null = sampled (main pool)
  isLongTail:          boolean;
}

// -----------------------------------------------------------------
// Public types
// -----------------------------------------------------------------

export interface AllocateInput {
  projectId:   string;
  triggeredBy: string;  // users.id (system)
}

export interface AllocateResult {
  termsAllocated:       number;
  longTailAllocated:    number;
  assignmentsCreated:   number;
}

// -----------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------

/**
 * Capacity weight for a reviewer — normalised affinity + availability proxy.
 * Terms per day is the primary capacity signal; affinity breaks ties.
 */
function capacityWeight(r: Reviewer): number {
  const dailyCap = r.termsPerDay ?? 10;  // assume 10 terms/day if not set
  return dailyCap * (0.5 + 0.5 * r.affinityScore);
}

/**
 * Allocate terms to reviewers using affinity-weighted round robin.
 * Each term must be assigned to exactly 2 different reviewers.
 * Returns a list of (projectTermId, reviewerId) pairs.
 */
function allocateTerms(
  terms: TermToAllocate[],
  reviewers: Reviewer[],
  minimumPerReviewer: number,
): Array<{ projectTermId: string; reviewerId: string }> {
  if (reviewers.length < 2) {
    throw new Error('At least 2 reviewers required for dual-independent-review allocation');
  }

  const assignments: Array<{ projectTermId: string; reviewerId: string }> = [];

  // Track how many terms each reviewer has been assigned
  const load = new Map<string, number>(reviewers.map(r => [r.userId, 0]));

  // Compute weights (used to bias selection toward higher-capacity reviewers)
  const weights = reviewers.map(r => ({ userId: r.userId, w: capacityWeight(r) }));
  const totalWeight = weights.reduce((s, w) => s + w.w, 0);

  for (const term of terms) {
    // Select 2 reviewers, different from each other, biased by weight
    const picked: string[] = [];

    // Weighted selection without replacement for 2 slots
    const available = [...weights];
    for (let slot = 0; slot < 2; slot++) {
      let rand = Math.random() * available.reduce((s, w) => s + w.w, 0);
      let chosen: string | null = null;
      for (const w of available) {
        rand -= w.w;
        if (rand <= 0) { chosen = w.userId; break; }
      }
      if (!chosen) chosen = available[available.length - 1].userId;

      picked.push(chosen);
      // Remove chosen from available pool for this term (independence)
      const idx = available.findIndex(w => w.userId === chosen);
      if (idx >= 0) available.splice(idx, 1);
    }

    for (const reviewerId of picked) {
      assignments.push({ projectTermId: term.projectTermId, reviewerId });
      load.set(reviewerId, (load.get(reviewerId) ?? 0) + 1);
    }
  }

  return assignments;
}

// -----------------------------------------------------------------
// Service
// -----------------------------------------------------------------

export async function allocateTerms_service(input: AllocateInput): Promise<AllocateResult> {
  const { projectId, triggeredBy } = input;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Load project
    const { rows: projRows } = await client.query<{
      targetTerminologyId: string;
      computedHoldoutN:    number | null;
    }>(
      `SELECT target_terminology_id AS "targetTerminologyId",
              computed_holdout_n    AS "computedHoldoutN"
       FROM   projects WHERE id = $1`,
      [projectId],
    );
    if (projRows.length === 0) throw new Error(`Project ${projectId} not found`);
    const { targetTerminologyId, computedHoldoutN } = projRows[0];

    // Load certified reviewers in the pool for this project
    const { rows: poolRows } = await client.query<Reviewer>(
      `SELECT
         rp.reviewer_id    AS "userId",
         COALESCE(ras.score, 0.5) AS "affinityScore",
         ra.terms_per_day  AS "termsPerDay",
         ra.hours_per_week AS "hoursPerWeek"
       FROM reviewer_pools rp
       -- Affinity score for target terminology
       LEFT JOIN reviewer_affinity_scores ras
         ON  ras.reviewer_id    = rp.reviewer_id
         AND ras.terminology_id = $2
       -- Availability per project
       LEFT JOIN reviewer_availability ra
         ON  ra.reviewer_id = rp.reviewer_id
         AND ra.project_id  = $1
       WHERE rp.project_id = $1
         AND rp.is_active  = TRUE`,
      [projectId, targetTerminologyId],
    );

    if (poolRows.length < 2) {
      throw new Error(
        `Reviewer pool for project ${projectId} has fewer than 2 active reviewers`,
      );
    }

    // Fetch main pool terms (status = 'sampled', not holdout, not auto-matched)
    const { rows: mainTerms } = await client.query<TermToAllocate>(
      `SELECT
         pt.id                       AS "projectTermId",
         pt.long_tail_priority_score AS "longTailPriorityScore",
         FALSE                       AS "isLongTail"
       FROM project_terms pt
       WHERE pt.project_id = $1
         AND pt.status     = 'sampled'
       ORDER BY pt.created_at`,
      [projectId],
    );

    // Fetch long-tail terms, ordered by priority score descending
    const { rows: longTailTerms } = await client.query<TermToAllocate>(
      `SELECT
         pt.id                       AS "projectTermId",
         pt.long_tail_priority_score AS "longTailPriorityScore",
         TRUE                        AS "isLongTail"
       FROM project_terms pt
       WHERE pt.project_id = $1
         AND pt.status     = 'long_tail_queued'
       ORDER BY pt.long_tail_priority_score DESC NULLS LAST`,
      [projectId],
    );

    // Determine minimum per-reviewer load from power calculation
    // Distribute holdout n across the pool (each reviewer covers minimum)
    const minimumPerReviewer = computedHoldoutN
      ? Math.ceil(computedHoldoutN / poolRows.length)
      : 0;

    // Determine long-tail fill: how many long-tail terms fit within reviewer capacity
    const totalCapacity = poolRows.reduce((s, r) => s + (r.termsPerDay ?? 10), 0);
    const mainLoadEstimate = mainTerms.length * 2;  // each term → 2 reviewers
    const remainingCapacity = Math.max(0, totalCapacity - mainLoadEstimate);
    // Each long-tail term also needs 2 reviewers; compute how many fit
    const longTailToInclude = Math.min(
      longTailTerms.length,
      Math.floor(remainingCapacity / 2),
    );
    const selectedLongTail = longTailTerms.slice(0, longTailToInclude);

    const allTerms = [...mainTerms, ...selectedLongTail];
    if (allTerms.length === 0) {
      await client.query('ROLLBACK');
      return { termsAllocated: 0, longTailAllocated: 0, assignmentsCreated: 0 };
    }

    // Generate assignment pairs
    const assignments = allocateTerms(allTerms, poolRows, minimumPerReviewer);

    // Persist assignments
    for (const { projectTermId, reviewerId } of assignments) {
      await client.query(
        `INSERT INTO reviewer_assignments
           (id, project_term_id, reviewer_id, project_id, assigned_at, is_active)
         VALUES ($1, $2, $3, $4, now(), TRUE)`,
        [uuidv4(), projectTermId, reviewerId, projectId],
      );
    }

    // Update project_term status → allocated
    const allTermIds = allTerms.map(t => t.projectTermId);
    await client.query(
      `UPDATE project_terms
       SET status = 'allocated', updated_at = now()
       WHERE id = ANY($1::uuid[])`,
      [allTermIds],
    );

    // Advance project status → mapping
    await client.query(
      `UPDATE projects
       SET status = 'mapping', current_dag_node = 'NODE_6_MAP', updated_at = now()
       WHERE id = $1`,
      [projectId],
    );

    // Audit log
    await client.query(
      `INSERT INTO audit_log
         (user_id, system_flag, action, entity_type, entity_id, project_id, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        triggeredBy, null,
        AuditAction.REVIEWER_POOL_ASSIGNED,
        'project', projectId, projectId,
        JSON.stringify({
          reviewerCount:     poolRows.length,
          termsAllocated:    mainTerms.length,
          longTailAllocated: selectedLongTail.length,
          assignmentsCreated: assignments.length,
        }),
      ],
    );

    await client.query('COMMIT');

    // Emit event → Node 6 MAP (one event per reviewer queue)
    for (const reviewer of poolRows) {
      await emit({
        source:     'omnimap',
        detailType: 'ALLOCATION_COMPLETE',
        detail: {
          projectId,
          node:       'NODE_5_ALLOCATE',
          nextNode:   'NODE_6_MAP',
          reviewerId: reviewer.userId,
        },
      });
    }

    return {
      termsAllocated:     mainTerms.length,
      longTailAllocated:  selectedLongTail.length,
      assignmentsCreated: assignments.length,
    };

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
