// OmniMap — Node 3: SAMPLE
// Applies a sampling strategy to the working term set (project_terms with status = 'raw').
// Strategies: random | stratified | frequency | pareto
//
// Outputs:
//   sampled         → enters mapping pool (status = 'sampled')
//   long_tail_queued → below Pareto cutoff or frequency threshold; prioritised by
//                      frequency trend + clinical domain risk score (status = 'long_tail_queued')
//
// The sample config must be created and locked before calling this service.
// Triggers: Node 4 — HOLDOUT_DRAW

import { db }             from './db';
import { emit }           from './events';
import { AuditAction }    from '../middleware/auditLog';
import { TermStatus, SamplingStrategy } from '../types/enums';

// -----------------------------------------------------------------
// Public types
// -----------------------------------------------------------------

export interface SampleInput {
  projectId:    string;
  configId:     string;   // sample_configs.id (must already exist + be unlocked)
  triggeredBy:  string;   // users.id
}

export interface SampleResult {
  sampled:          number;
  longTailQueued:   number;
}

// -----------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------

interface CandidateTerm {
  projectTermId: string;
  frequency:     number | null;
  clinicalDomain: string | null;
}

/** Fisher-Yates in-place shuffle */
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Domain risk weights — higher = more likely to be prioritised in long tail */
const DOMAIN_RISK: Record<string, number> = {
  diagnosis: 1.0,
  medication: 1.0,
  lab:        0.9,
  procedure:  0.8,
  symptom:    0.7,
  allergy:    0.8,
  device:     0.6,
  risk_factor: 0.7,
};

function domainRisk(domain: string | null): number {
  return domain ? (DOMAIN_RISK[domain.toLowerCase()] ?? 0.5) : 0.5;
}

/** Long-tail priority score: normalised frequency trend + domain risk (both 0–1) */
function priorityScore(term: CandidateTerm, maxFreq: number): number {
  const freqNorm = maxFreq > 0 ? (term.frequency ?? 0) / maxFreq : 0;
  return 0.5 * freqNorm + 0.5 * domainRisk(term.clinicalDomain);
}

// -----------------------------------------------------------------
// Strategy implementations — return sampled IDs
// -----------------------------------------------------------------

function strategyRandom(terms: CandidateTerm[], n: number): Set<string> {
  const shuffled = shuffle([...terms]);
  return new Set(shuffled.slice(0, Math.min(n, shuffled.length)).map(t => t.projectTermId));
}

function strategyFrequency(terms: CandidateTerm[], n: number): Set<string> {
  const sorted = [...terms].sort((a, b) => (b.frequency ?? 0) - (a.frequency ?? 0));
  return new Set(sorted.slice(0, Math.min(n, sorted.length)).map(t => t.projectTermId));
}

function strategyPareto(terms: CandidateTerm[], threshold: number): {
  sampled: Set<string>;
  longTail: Set<string>;
} {
  // Sort by frequency descending, take terms until cumulative frequency ≥ threshold% of total
  const sorted = [...terms].sort((a, b) => (b.frequency ?? 0) - (a.frequency ?? 0));
  const totalFreq = sorted.reduce((s, t) => s + (t.frequency ?? 0), 0);
  const cutoff    = totalFreq * threshold;

  const sampled  = new Set<string>();
  const longTail = new Set<string>();
  let   cumFreq  = 0;

  for (const term of sorted) {
    if (cumFreq < cutoff) {
      sampled.add(term.projectTermId);
      cumFreq += (term.frequency ?? 0);
    } else {
      longTail.add(term.projectTermId);
    }
  }
  return { sampled, longTail };
}

function strategyStratified(
  terms: CandidateTerm[],
  n: number,
): Set<string> {
  // Group by clinical_domain, sample proportionally from each stratum
  const strata = new Map<string, CandidateTerm[]>();
  for (const t of terms) {
    const key = t.clinicalDomain ?? '__unknown__';
    if (!strata.has(key)) strata.set(key, []);
    strata.get(key)!.push(t);
  }

  const sampled  = new Set<string>();
  const perStratum = Math.max(1, Math.floor(n / strata.size));

  for (const group of strata.values()) {
    const drawn = shuffle([...group]).slice(0, perStratum);
    drawn.forEach(t => sampled.add(t.projectTermId));
  }
  // Top up to n from remaining if needed
  if (sampled.size < n) {
    const remaining = shuffle(terms.filter(t => !sampled.has(t.projectTermId)));
    for (const t of remaining) {
      if (sampled.size >= n) break;
      sampled.add(t.projectTermId);
    }
  }
  return sampled;
}

// -----------------------------------------------------------------
// Service
// -----------------------------------------------------------------

export async function sampleTerms(input: SampleInput): Promise<SampleResult> {
  const { projectId, configId, triggeredBy } = input;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Guard: refuse to re-sample once holdout is locked
    const { rows: projGuard } = await client.query<{ holdoutLockedAt: string | null }>(
      `SELECT holdout_locked_at AS "holdoutLockedAt" FROM projects WHERE id = $1`,
      [projectId],
    );
    if (projGuard[0]?.holdoutLockedAt) {
      throw new Error(
        `Cannot re-sample after the holdout is locked (locked at ${projGuard[0].holdoutLockedAt}). ` +
        `Node 3 cannot be run again once Node 4 has completed.`,
      );
    }

    // Load sample config
    const { rows: cfgRows } = await client.query<{
      strategy:        string;
      paretoThreshold: number | null;
      randomN:         number | null;
      isLocked:        boolean;
    }>(
      `SELECT strategy, pareto_threshold AS "paretoThreshold",
              random_n AS "randomN", is_locked AS "isLocked"
       FROM   sample_configs
       WHERE  id = $1 AND project_id = $2`,
      [configId, projectId],
    );
    if (cfgRows.length === 0) throw new Error(`Sample config ${configId} not found`);
    if (cfgRows[0].isLocked) throw new Error('Sample config is already locked — cannot re-sample');

    const cfg = cfgRows[0];

    // Fetch candidate project_terms (status = 'raw')
    const { rows: candidates } = await client.query<CandidateTerm>(
      `SELECT
         pt.id              AS "projectTermId",
         st.frequency       AS frequency,
         st.clinical_domain AS "clinicalDomain"
       FROM project_terms pt
       JOIN source_terms  st ON st.id = pt.source_term_id
       WHERE pt.project_id = $1
         AND pt.status = 'raw'`,
      [projectId],
    );

    if (candidates.length === 0) {
      await client.query('ROLLBACK');
      return { sampled: 0, longTailQueued: 0 };
    }

    const maxFreq = Math.max(...candidates.map(t => t.frequency ?? 0), 1);

    // Apply strategy
    let sampledIds  = new Set<string>();
    let longTailIds = new Set<string>();

    const strategy = cfg.strategy as SamplingStrategy;

    switch (strategy) {
      case SamplingStrategy.Random: {
        const n = cfg.randomN ?? Math.ceil(candidates.length * 0.8);
        sampledIds = strategyRandom(candidates, n);
        longTailIds = new Set(candidates
          .filter(t => !sampledIds.has(t.projectTermId))
          .map(t => t.projectTermId));
        break;
      }
      case SamplingStrategy.Frequency: {
        const n = cfg.randomN ?? Math.ceil(candidates.length * 0.8);
        sampledIds = strategyFrequency(candidates, n);
        longTailIds = new Set(candidates
          .filter(t => !sampledIds.has(t.projectTermId))
          .map(t => t.projectTermId));
        break;
      }
      case SamplingStrategy.Pareto: {
        const threshold = cfg.paretoThreshold ?? 0.80;
        const result = strategyPareto(candidates, threshold);
        sampledIds  = result.sampled;
        longTailIds = result.longTail;
        break;
      }
      case SamplingStrategy.Stratified: {
        const n = cfg.randomN ?? Math.ceil(candidates.length * 0.8);
        sampledIds = strategyStratified(candidates, n);
        longTailIds = new Set(candidates
          .filter(t => !sampledIds.has(t.projectTermId))
          .map(t => t.projectTermId));
        break;
      }
      default:
        throw new Error(`Unknown sampling strategy: ${strategy}`);
    }

    // Compute long-tail priority scores
    const longTailTerms = candidates.filter(t => longTailIds.has(t.projectTermId));

    // Update sampled terms (single bulk query)
    if (sampledIds.size > 0) {
      await client.query(
        `UPDATE project_terms
         SET status = 'sampled', updated_at = now()
         WHERE id = ANY($1::uuid[])`,
        [Array.from(sampledIds)],
      );
    }

    // Update long-tail terms — single UNNEST bulk query instead of N individual UPDATEs
    if (longTailTerms.length > 0) {
      const ids         = longTailTerms.map(t => t.projectTermId);
      const scores      = longTailTerms.map(t => priorityScore(t, maxFreq));
      const domainRisks = longTailTerms.map(t => domainRisk(t.clinicalDomain) >= 0.8);

      await client.query(
        `UPDATE project_terms AS pt
         SET status                   = 'long_tail_queued',
             long_tail_priority_score = data.score,
             domain_risk_flag         = data.risk,
             updated_at               = now()
         FROM (
           SELECT UNNEST($1::uuid[])    AS id,
                  UNNEST($2::float8[])  AS score,
                  UNNEST($3::boolean[]) AS risk
         ) AS data
         WHERE pt.id = data.id`,
        [ids, scores, domainRisks],
      );
    }

    // Lock the sample config
    await client.query(
      `UPDATE sample_configs SET is_locked = TRUE, locked_at = now() WHERE id = $1`,
      [configId],
    );

    // Lock the project sample
    await client.query(
      `UPDATE projects
       SET sample_locked_at = now(), status = 'holdout_draw',
           current_dag_node = 'NODE_4_HOLDOUT_DRAW', updated_at = now()
       WHERE id = $1`,
      [projectId],
    );

    // Audit log
    await client.query(
      `INSERT INTO audit_log
         (user_id, system_flag, action, entity_type, entity_id, project_id, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        triggeredBy,
        null,
        AuditAction.SAMPLE_LOCKED,
        'project',
        projectId,
        projectId,
        JSON.stringify({ strategy, sampled: sampledIds.size, longTailQueued: longTailIds.size }),
      ],
    );

    await client.query('COMMIT');

    // Emit event → Node 4 HOLDOUT_DRAW
    await emit({
      source:     'omnimap',
      detailType: 'SAMPLE_COMPLETE',
      detail: {
        projectId,
        node:           'NODE_3_SAMPLE',
        nextNode:       'NODE_4_HOLDOUT_DRAW',
        sampled:        sampledIds.size,
        longTailQueued: longTailIds.size,
      },
    });

    return { sampled: sampledIds.size, longTailQueued: longTailIds.size };

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
