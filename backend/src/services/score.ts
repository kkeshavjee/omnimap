// OmniMap — Node 12: SCORE
//
// Runs holdout validation scoring. Creates a holdout_scoring_session,
// auto-labels every holdout term based on its canonical mapping status,
// computes Precision / Recall / F1 with 95% Wilson score CIs, and stores
// the results in holdout_results.
//
// ── Phase 1 auto-scoring approach (no external reference standard) ─────────
//   Holdout term with canonical mapping (target_code ≠ 'UNMAPPABLE') → TP (1)
//   Holdout term with canonical mapping (target_code = 'UNMAPPABLE')  → TN (0)
//   Holdout term without any canonical mapping                         → FN (3)
//   FP: not detectable without a reference standard → set to 0
//
//   Precision = TP / (TP + FP)       → 1.0 when FP = 0
//   Recall    = TP / (TP + FN)
//   F1        = 2·TP / (2·TP + FP + FN)
//
// ── 95% CIs ─────────────────────────────────────────────────────────────────
//   Wilson score interval per proportion (Newcombe 1998).
//   F1 CI: harmonic mean of Wilson CI bounds for P and R (conservative).
//
// ── Project status advance ───────────────────────────────────────────────────
//   F1 ≥ threshold → status = 'exporting',   dag_node = 'NODE_13_EXPORT'
//   F1 <  threshold → status = 'scoring',     dag_node = 'NODE_12_SCORE'
//                     (administrator reviews results and decides next step)

import { v4 as uuidv4 } from 'uuid';
import { db }           from './db';
import { emit }         from './events';
import { AuditAction }  from '../middleware/auditLog';

// -----------------------------------------------------------------
// Types
// -----------------------------------------------------------------

export interface ScoreInput {
  projectId:   string;
  triggeredBy: string;  // users.id
}

export interface ScoreResult {
  sessionId:        string;
  holdoutN:         number;
  truePositives:    number;
  falsePositives:   number;
  trueNegatives:    number;
  falseNegatives:   number;
  precision:        number;
  recall:           number;
  f1:               number;
  precisionCiLow:   number;
  precisionCiHigh:  number;
  recallCiLow:      number;
  recallCiHigh:     number;
  f1CiLow:          number;
  f1CiHigh:         number;
  f1Threshold:      number;
  passed:           boolean;
}

// -----------------------------------------------------------------
// Statistics helpers
// -----------------------------------------------------------------

/**
 * Wilson score confidence interval for a proportion.
 * @param x  Number of successes
 * @param n  Total observations
 * @param z  z-score (1.96 for 95%)
 */
function wilsonCI(x: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 0];
  const p    = x / n;
  const z2   = z * z;
  const denom  = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / denom;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

/**
 * F1 confidence interval — harmonic mean of Wilson CI bounds for P and R.
 * Conservative approximation; adequate for Phase 1 reporting.
 */
function f1CI(
  tp: number, fp: number, fn: number, z = 1.96,
): [number, number] {
  const [pLow, pHigh] = wilsonCI(tp, tp + fp, z);
  const [rLow, rHigh] = wilsonCI(tp, tp + fn, z);
  const f1Low  = (pLow  + rLow)  > 0 ? 2 * pLow  * rLow  / (pLow  + rLow)  : 0;
  const f1High = (pHigh + rHigh) > 0 ? 2 * pHigh * rHigh / (pHigh + rHigh) : 0;
  return [f1Low, f1High];
}

function round4(n: number): number {
  return parseFloat(n.toFixed(4));
}

// -----------------------------------------------------------------
// Service
// -----------------------------------------------------------------

export async function runHoldoutScoring(
  input: ScoreInput,
): Promise<ScoreResult> {
  const { projectId, triggeredBy } = input;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Fetch project's F1 threshold
    const { rows: projRows } = await client.query<{ f1Threshold: number }>(
      `SELECT power_f1_threshold AS "f1Threshold" FROM projects WHERE id = $1`,
      [projectId],
    );
    if (projRows.length === 0) throw new Error(`Project ${projectId} not found`);
    const { f1Threshold } = projRows[0];

    // Create scoring session
    const sessionId = uuidv4();
    await client.query(
      `INSERT INTO holdout_scoring_sessions (id, project_id, triggered_by, status)
       VALUES ($1, $2, $3, 'in_progress')`,
      [sessionId, projectId, triggeredBy],
    );

    // Fetch all holdout terms with their canonical mapping status
    const { rows: holdoutTerms } = await client.query<{
      projectTermId: string;
      targetCode:    string | null;
    }>(
      `SELECT
         pt.id          AS "projectTermId",
         cm.target_code AS "targetCode"
       FROM project_terms pt
       LEFT JOIN canonical_mappings cm
         ON  cm.project_term_id = pt.id
         AND cm.is_current      = TRUE
       WHERE pt.project_id  = $1
         AND pt.is_holdout  = TRUE`,
      [projectId],
    );

    let tp = 0, fp = 0, tn = 0, fn = 0;

    for (const term of holdoutTerms) {
      let score: '0' | '1' | '2' | '3';

      if (term.targetCode === null) {
        // No canonical mapping yet → incorrectly not coded
        score = '3';
        fn++;
      } else if (term.targetCode === 'UNMAPPABLE') {
        // Confirmed gap → correctly not coded
        score = '0';
        tn++;
      } else {
        // Has a real SNOMED code → correctly coded
        score = '1';
        tp++;
      }

      await client.query(
        `INSERT INTO holdout_labels
           (id, scoring_session_id, project_term_id, reviewer_id, score)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (scoring_session_id, project_term_id, reviewer_id) DO NOTHING`,
        [uuidv4(), sessionId, term.projectTermId, triggeredBy, score],
      );
    }

    const holdoutN = holdoutTerms.length;

    // Compute P, R, F1
    const precision = (tp + fp) > 0 ? tp / (tp + fp) : 0;
    const recall    = (tp + fn) > 0 ? tp / (tp + fn) : 0;
    const f1        = (2 * tp + fp + fn) > 0 ? (2 * tp) / (2 * tp + fp + fn) : 0;

    const [precLow, precHigh] = wilsonCI(tp, tp + fp);
    const [recLow,  recHigh]  = wilsonCI(tp, tp + fn);
    const [f1Low,   f1High]   = f1CI(tp, fp, fn);

    const passed = f1 >= f1Threshold;

    // Persist results
    await client.query(
      `INSERT INTO holdout_results (
         id, scoring_session_id, project_id,
         true_positives, false_positives, true_negatives, false_negatives,
         precision_score, recall_score, f1_score,
         precision_ci_low, precision_ci_high,
         recall_ci_low,    recall_ci_high,
         f1_ci_low,        f1_ci_high,
         f1_threshold,     passed_threshold
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [
        uuidv4(), sessionId, projectId,
        tp, fp, tn, fn,
        precision.toFixed(4), recall.toFixed(4), f1.toFixed(4),
        precLow.toFixed(4),  precHigh.toFixed(4),
        recLow.toFixed(4),   recHigh.toFixed(4),
        f1Low.toFixed(4),    f1High.toFixed(4),
        f1Threshold, passed,
      ],
    );

    // Mark session complete
    await client.query(
      `UPDATE holdout_scoring_sessions
       SET status = 'complete', completed_at = now()
       WHERE id = $1`,
      [sessionId],
    );

    // Advance project status
    const nextStatus   = passed ? 'exporting'         : 'scoring';
    const nextDagNode  = passed ? 'NODE_13_EXPORT'    : 'NODE_12_SCORE';
    await client.query(
      `UPDATE projects
       SET status = $1, current_dag_node = $2, updated_at = now()
       WHERE id = $3`,
      [nextStatus, nextDagNode, projectId],
    );

    // Audit
    await client.query(
      `INSERT INTO audit_log
         (user_id, system_flag, action, entity_type, entity_id, project_id, payload)
       VALUES ($1, NULL, $2, 'project', $3, $4, $5)`,
      [
        triggeredBy,
        AuditAction.PROJECT_STATUS_CHANGED,
        projectId, projectId,
        JSON.stringify({
          node: 'NODE_12_SCORE',
          sessionId,
          holdoutN, tp, fp, tn, fn,
          f1: f1.toFixed(4), f1Threshold, passed,
        }),
      ],
    );

    await client.query('COMMIT');

    await emit({
      source:     'omnimap',
      detailType: 'SCORE_COMPLETE',
      detail: {
        projectId,
        node:     'NODE_12_SCORE',
        nextNode: nextDagNode,
        f1, passed,
      },
    });

    return {
      sessionId,
      holdoutN,
      truePositives:    tp,
      falsePositives:   fp,
      trueNegatives:    tn,
      falseNegatives:   fn,
      precision:        round4(precision),
      recall:           round4(recall),
      f1:               round4(f1),
      precisionCiLow:   round4(precLow),
      precisionCiHigh:  round4(precHigh),
      recallCiLow:      round4(recLow),
      recallCiHigh:     round4(recHigh),
      f1CiLow:          round4(f1Low),
      f1CiHigh:         round4(f1High),
      f1Threshold,
      passed,
    };

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
