// OmniMap — Node 4: HOLDOUT_DRAW + AUTOMATCH
//
// HOLDOUT_DRAW:
//   Power calculation using the Goutte & Gaussier (2005) asymptotic variance
//   framework for F1. Draws a stratified random holdout from the sampled pool.
//   Holdout terms are locked immediately (is_holdout = TRUE, holdout_locked = TRUE).
//
// AUTOMATCH:
//   For each remaining (non-holdout) term in the mapping pool, compares the
//   source term canonical form against SNOMED CT FSN canonical form.
//   Canonical form: UPPER(source_code) with punctuation stripped.
//
//   Match  → status = 'auto_matched'; routed to Node 8 CANONICALISE.
//   No match → remains 'sampled'; forwarded to Node 5 ALLOCATE.
//
// Power calculation formula (Goutte & Gaussier, asymptotic F1 variance):
//   V(f) = 2 * f * (1 - f)               [per-observation variance under equal P = R = f]
//   n = ceil( (z_α√V(f0) + z_β√V(f1))² / (f1 - f0)² )
//   f0 = configured F1 threshold (default 0.90)
//   f1 = hypothesized true F1 (default midpoint(f0, 1.0) capped at 0.99)
//   z_α = one-sided critical value at alpha (default 0.05 → 1.6449)
//   z_β = power critical value (default power 0.80 → 0.8416)
//
// Triggers: Node 5 ALLOCATE (non-matched terms) + Node 8 CANONICALISE (auto-matched)

import { v4 as uuidv4 }       from 'uuid';
import { db }                from './db';
import { emit }              from './events';
import { AuditAction }       from '../middleware/auditLog';
import { TermStatus }        from '../types/enums';
import { canonicalMatchForm } from './clinicalNlp';
import { isInfowayConfigured, findExactTerm } from './infowayFhir';

// -----------------------------------------------------------------
// Power calculation
// -----------------------------------------------------------------

/** One-sided z-critical values (standard normal) */
function zScore(p: number): number {
  // Rational approximation (Abramowitz & Stegun 26.2.17) — sufficient for 0.001 < p < 0.5
  const t = Math.sqrt(-2 * Math.log(p));
  const c = [2.515517, 0.802853, 0.010328];
  const d = [1.432788, 0.189269, 0.001308];
  return t - (c[0] + c[1] * t + c[2] * t * t) /
             (1 + d[0] * t + d[1] * t * t + d[2] * t * t * t);
}

/**
 * Compute required holdout n (Goutte & Gaussier F1 power calculation).
 * One-sided H0: F1 ≤ f0  vs  H1: F1 > f0.
 */
export function computeHoldoutN(params: {
  f0:    number;  // threshold (e.g. 0.90)
  alpha: number;  // one-sided significance (e.g. 0.05)
  beta:  number;  // 1 − power (e.g. 0.20 for 80% power)
  f1?:   number;  // hypothesized true F1 (default: midpoint(f0, 1.0) capped at 0.99)
}): number {
  const { f0, alpha, beta } = params;
  const f1 = params.f1 ?? Math.min((f0 + 1) / 2, 0.99);

  if (f1 <= f0) throw new Error('f1 must be greater than f0');

  const vF = (f: number) => 2 * f * (1 - f);  // F1 asymptotic variance per observation
  const za = zScore(alpha);
  const zb = zScore(beta);
  const nRaw = Math.pow(za * Math.sqrt(vF(f0)) + zb * Math.sqrt(vF(f1)), 2) /
               Math.pow(f1 - f0, 2);

  return Math.ceil(nRaw);
}


// -----------------------------------------------------------------
// Public types
// -----------------------------------------------------------------

export interface HoldoutDrawInput {
  projectId:   string;
  triggeredBy: string;  // users.id
}

export interface HoldoutDrawResult {
  holdoutN:     number;
  holdoutDrawn: number;
  autoMatched:  number;
  toAllocate:   number;
}

// -----------------------------------------------------------------
// Service
// -----------------------------------------------------------------

export async function holdoutDrawAndAutomatch(
  input: HoldoutDrawInput,
): Promise<HoldoutDrawResult> {
  const { projectId, triggeredBy } = input;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Load project power-calc params
    const { rows: projRows } = await client.query<{
      f0:    number;
      alpha: number;
      beta:  number;
      targetTerminologyId: string;
    }>(
      `SELECT
         power_f1_threshold       AS f0,
         power_alpha              AS alpha,
         power_beta               AS beta,
         target_terminology_id    AS "targetTerminologyId"
       FROM projects
       WHERE id = $1`,
      [projectId],
    );
    if (projRows.length === 0) throw new Error(`Project ${projectId} not found`);
    // Parse as numbers — node-postgres returns NUMERIC columns as strings
    const f0    = parseFloat(projRows[0].f0 as unknown as string);
    const alpha = parseFloat(projRows[0].alpha as unknown as string);
    const beta  = parseFloat(projRows[0].beta as unknown as string);
    const { targetTerminologyId } = projRows[0];

    // Compute required holdout n
    const holdoutN = computeHoldoutN({ f0, alpha, beta });

    // Fetch all sampled terms (status = 'sampled')
    const { rows: sampledTerms } = await client.query<{
      projectTermId: string;
      clinicalDomain: string | null;
    }>(
      `SELECT
         pt.id              AS "projectTermId",
         st.clinical_domain AS "clinicalDomain"
       FROM project_terms pt
       JOIN source_terms  st ON st.id = pt.source_term_id
       WHERE pt.project_id = $1
         AND pt.status     = 'sampled'`,
      [projectId],
    );

    if (sampledTerms.length < holdoutN) {
      throw new Error(
        `Insufficient sampled terms (${sampledTerms.length}) for holdout n=${holdoutN}. ` +
        `Expand the sample or adjust power parameters.`,
      );
    }

    // ── Stratified holdout draw ─────────────────────────────────────
    // Preserve domain proportions (same logic as sample.ts stratifiedStrategy).
    const strata = new Map<string, string[]>();
    for (const t of sampledTerms) {
      const key = t.clinicalDomain ?? '__unknown__';
      if (!strata.has(key)) strata.set(key, []);
      strata.get(key)!.push(t.projectTermId);
    }

    // Shuffle each stratum
    for (const arr of strata.values()) shuffleArr(arr);

    const holdoutIds = new Set<string>();
    const perStratum = Math.max(1, Math.floor(holdoutN / strata.size));

    for (const arr of strata.values()) {
      arr.slice(0, perStratum).forEach(id => holdoutIds.add(id));
    }
    // Top-up to exactly holdoutN if needed
    if (holdoutIds.size < holdoutN) {
      const pool = sampledTerms.map(t => t.projectTermId).filter(id => !holdoutIds.has(id));
      shuffleArr(pool);
      for (const id of pool) {
        if (holdoutIds.size >= holdoutN) break;
        holdoutIds.add(id);
      }
    }

    // Lock holdout terms
    const now = new Date().toISOString();
    for (const id of holdoutIds) {
      await client.query(
        `UPDATE project_terms
         SET status = 'holdout', is_holdout = TRUE,
             holdout_locked = TRUE, holdout_locked_at = now(),
             updated_at = now()
         WHERE id = $1`,
        [id],
      );
      // Audit each holdout term
      await client.query(
        `INSERT INTO audit_log
           (user_id, system_flag, action, entity_type, entity_id, project_id, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          triggeredBy, null,
          AuditAction.HOLDOUT_DRAWN,
          'project_term', id, projectId,
          JSON.stringify({ holdoutN }),
        ],
      );
    }

    // Lock holdout at project level
    await client.query(
      `UPDATE projects
       SET holdout_locked_at = now(), computed_holdout_n = $1,
           status = 'automatch', current_dag_node = 'NODE_4_AUTOMATCH',
           updated_at = now()
       WHERE id = $2`,
      [holdoutN, projectId],
    );

    await client.query(
      `INSERT INTO audit_log
         (user_id, system_flag, action, entity_type, entity_id, project_id, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        triggeredBy, null,
        AuditAction.HOLDOUT_LOCKED,
        'project', projectId, projectId,
        JSON.stringify({ holdoutN, drawn: holdoutIds.size }),
      ],
    );

    // ── AUTOMATCH pre-check ─────────────────────────────────────────
    // Fetch all non-holdout sampled terms
    const { rows: mappingPool } = await client.query<{
      projectTermId: string;
      sourceCode:    string;
      displayTerm:   string;
      matchForm:     string;
    }>(
      `SELECT
         pt.id                    AS "projectTermId",
         st.source_code           AS "sourceCode",
         st.display_term          AS "displayTerm",
         COALESCE(st.display_term_match, st.display_term) AS "matchForm"
       FROM project_terms pt
       JOIN source_terms  st ON st.id = pt.source_term_id
       WHERE pt.project_id = $1
         AND pt.status     = 'sampled'`,   // holdout terms now have status='holdout'
      [projectId],
    );

    // Fetch SNOMED CT FSN canonical forms from canonical_mappings
    // (Phase 1: only SNOMED CT; target_terminology_id must match snomed_ct)
    const { rows: snomed } = await client.query<{ id: string }>(
      `SELECT id FROM terminologies WHERE code = 'snomed_ct' AND is_active = TRUE LIMIT 1`,
      [],
    );
    const isSnomedProject = snomed.length > 0 && targetTerminologyId === snomed[0].id;

    let autoMatched = 0;
    let toAllocate  = 0;

    for (const term of mappingPool) {
      let matched = false;

      if (isSnomedProject) {
        const sourceCanonical = term.matchForm;  // pre-computed at ingest by clinicalNlp.annotate()

        if (isInfowayConfigured()) {
          // ── Infoway FHIR: live SNOMED CT CA FSN exact match ──
          try {
            const hit = await findExactTerm(term.displayTerm);
            if (hit) {
              matched = true;
              // Store SNOMED code in auto_matched_fsn for use by canonicalise
              await client.query(
                `UPDATE project_terms
                 SET status = 'auto_matched',
                     is_auto_matched = TRUE,
                     auto_matched_at = now(),
                     auto_matched_fsn = $1,
                     updated_at = now()
                 WHERE id = $2`,
                [hit.code, term.projectTermId],
              );
              await client.query(
                `INSERT INTO audit_log
                   (user_id, system_flag, action, entity_type, entity_id, project_id, payload)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [
                  null, 'AUTO_MATCH',
                  AuditAction.TERM_AUTO_MATCHED,
                  'project_term', term.projectTermId, projectId,
                  JSON.stringify({ sourceCode: term.sourceCode, snomedCode: hit.code, source: 'infoway' }),
                ],
              );
              autoMatched++;
              continue;
            }
          } catch (err) {
            console.warn('[automatch] Infoway lookup failed for term:', term.displayTerm, (err as Error).message);
            // Fall through to corpus match
          }
        }

        // ── Corpus fallback: match against canonical_mappings ──
        const { rows: fsnRows } = await client.query<{ targetDisplay: string }>(
          `SELECT cm.target_display_lower AS "targetDisplay"
           FROM   canonical_mappings cm
           JOIN   project_terms pt2 ON pt2.id = cm.project_term_id
           JOIN   projects p        ON p.id   = pt2.project_id
           WHERE  p.target_terminology_id = $1
             AND  cm.is_current = TRUE
           LIMIT 500`,
          [targetTerminologyId],
        );

        for (const fsn of fsnRows) {
          if (canonicalMatchForm(fsn.targetDisplay) === sourceCanonical) {
            matched = true;
            break;
          }
        }
      }

      if (matched) {
        const autoMatchedAt = new Date().toISOString();
        await client.query(
          `UPDATE project_terms
           SET status = 'auto_matched',
               is_auto_matched = TRUE,
               auto_matched_at = now(),
               auto_matched_fsn = $1,
               updated_at = now()
           WHERE id = $2`,
          [term.sourceCode, term.projectTermId],
        );
        await client.query(
          `INSERT INTO audit_log
             (user_id, system_flag, action, entity_type, entity_id, project_id, payload)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            null, 'AUTO_MATCH',
            AuditAction.TERM_AUTO_MATCHED,
            'project_term', term.projectTermId, projectId,
            JSON.stringify({ sourceCode: term.sourceCode }),
          ],
        );
        autoMatched++;
      } else {
        toAllocate++;
      }
    }

    // Advance project status → allocating
    await client.query(
      `UPDATE projects
       SET status = 'allocating', current_dag_node = 'NODE_5_ALLOCATE', updated_at = now()
       WHERE id = $1`,
      [projectId],
    );

    await client.query('COMMIT');

    // Emit: auto-matched terms → Node 8; remaining → Node 5
    if (autoMatched > 0) {
      await emit({
        source:     'omnimap',
        detailType: 'AUTOMATCH_BATCH_COMPLETE',
        detail: {
          projectId,
          node:        'NODE_4_AUTOMATCH',
          nextNode:    'NODE_8_CANONICALISE',
          autoMatched,
        },
      });
    }

    await emit({
      source:     'omnimap',
      detailType: 'HOLDOUT_DRAW_COMPLETE',
      detail: {
        projectId,
        node:        'NODE_4_HOLDOUT_DRAW',
        nextNode:    'NODE_5_ALLOCATE',
        holdoutN,
        holdoutDrawn: holdoutIds.size,
        autoMatched,
        toAllocate,
      },
    });

    return { holdoutN, holdoutDrawn: holdoutIds.size, autoMatched, toAllocate };

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// -----------------------------------------------------------------
// Utility
// -----------------------------------------------------------------

function shuffleArr<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}
