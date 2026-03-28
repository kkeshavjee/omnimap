// OmniMap — Nodes 9–11: REGEX_PIPELINE / REGEX_VALIDATE / CORPUS_UPDATE
//
// Node 9  REGEX_PIPELINE  — Runs every canonical_mapping in a project through
//                           the five-layer qualifier pipeline and writes results
//                           to regex_runs + xml_tagged_output.
//
// Node 10 REGEX_VALIDATE  — Aggregate R-01/R-02/greediness report over regex_runs.
//                           Read-only; no DB writes.
//
// Node 11 CORPUS_UPDATE   — Advances project status to 'scoring' so the DAG
//                           can proceed to Node 12. Full flywheel (auto-generate
//                           new concept regex patterns) is Phase 2.
//
// ── Five layers ──────────────────────────────────────────────────────────────
//   L1  Normalise    — UPPER-CASE the source text (never stored directly)
//   L2  Negation     — qualifier_patterns WHERE category = 'negation'
//                      wraps match in <neg>…</neg>
//   L3  Qualifier    — qualifier_patterns WHERE category IN
//                      ('location','timing','family_history','causation','screening')
//                      wraps match in <qual>…</qual>
//   L4  Manufacturer — qualifier_patterns WHERE category = 'stop_word'
//                      strips the matched text
//   L5  Concept      — uses the canonical_mapping's own target_display_lower +
//                      concept_type to wrap any remaining uppercase text in
//                      the appropriate XML concept tag (lower-cased)
//
// ── Concept tags ─────────────────────────────────────────────────────────────
//   diagnosis  → <dx>    medication → <med>    procedure → <proc>
//   lab        → <lab>   symptom    → <sx>     allergy   → <allergy>
//   device     → <device> risk_factor → <risk>  null     → <dx>
//
// ── Report flags (stored in regex_runs) ──────────────────────────────────────
//   has_residual_uppercase  R-01: uppercase chars remain outside tags after L5
//   no_match                R-02: term is UNMAPPABLE — no concept tag applied
//   greediness_ratio        source_len / output_len
//   is_over_greedy          ratio > project.greediness_ratio_threshold

import { v4 as uuidv4 } from 'uuid';
import { db }           from './db';
import { emit }         from './events';
import { AuditAction }  from '../middleware/auditLog';

// -----------------------------------------------------------------
// Internal types
// -----------------------------------------------------------------

interface QualPattern {
  patternText: string;
  flags:       string;
  category:    string;
  action:      string;
}

// Map concept_type → XML tag name
const CONCEPT_TAG: Record<string, string> = {
  diagnosis:   'dx',
  medication:  'med',
  procedure:   'proc',
  lab:         'lab',
  symptom:     'sx',
  allergy:     'allergy',
  device:      'device',
  risk_factor: 'risk',
};

function getConceptTag(conceptType: string | null): string {
  return conceptType ? (CONCEPT_TAG[conceptType] ?? 'dx') : 'dx';
}

// -----------------------------------------------------------------
// Layer helpers
// -----------------------------------------------------------------

/**
 * L1 — Normalise: upper-case the source text.
 */
function applyNormalise(text: string): string {
  return text.toUpperCase();
}

/**
 * L2/L3 — Tag layer: wrap each match in an XML tag.
 * Patterns are applied in sort order; earlier matches take priority.
 * Matches inside existing XML tags are skipped.
 */
function applyTagLayer(
  text:    string,
  patterns: QualPattern[],
  tagName: string,
): string {
  let result = text;
  for (const p of patterns) {
    try {
      const re = new RegExp(p.patternText, p.flags);
      result = result.replace(re, (match, ...args) => {
        // Don't double-tag — skip if we're already inside a tag
        const offset: number = args[args.length - 2];
        const before = result.slice(0, offset);
        // Simple heuristic: if an unclosed '<' precedes our match, we're inside a tag
        const lastOpen  = before.lastIndexOf('<');
        const lastClose = before.lastIndexOf('>');
        if (lastOpen > lastClose) return match;  // inside a tag — skip
        return `<${tagName}>${match.toLowerCase()}</${tagName}>`;
      });
    } catch {
      // Skip malformed patterns
    }
  }
  return result;
}

/**
 * L4 — Strip layer: remove matched text entirely (stop-words / brand prefixes).
 * Collapses any resulting double-spaces.
 */
function applyStripLayer(text: string, patterns: QualPattern[]): string {
  let result = text;
  for (const p of patterns) {
    if (p.action !== 'ignore' && p.action !== 'detect' && p.action !== 'screening') {
      // Only strip if the pattern's action is 'ignore' or category is stop_word
      // For stop_word category, action is typically 'detect' — we strip anyway
    }
    try {
      const re = new RegExp(p.patternText, p.flags);
      result = result.replace(re, ' ');
    } catch {
      // Skip malformed patterns
    }
  }
  return result.replace(/\s{2,}/g, ' ').trim();
}

/**
 * L5 — Concept layer: wrap all remaining uppercase text (outside existing tags)
 * with the appropriate concept tag and the canonical display form.
 *
 * For UNMAPPABLE terms: no wrapping is applied; has_residual_uppercase is set.
 */
function applyConceptLayer(
  text:          string,
  targetCode:    string,
  targetDisplay: string,
  conceptType:   string | null,
): string {
  if (targetCode === 'UNMAPPABLE') {
    return text; // R-02: no match — leave as-is
  }

  const tag = getConceptTag(conceptType);

  // Find all spans of text outside XML tags
  // Replace the "uppercase core" (non-tagged uppercase sequences) with the concept tag
  // Strategy: tokenise by XML tags, uppercase tokens → replace with concept tag
  const xmlTagRe = /(<[^>]+>[^<]*<\/[^>]+>|<[^>]+\/>)/g;
  const parts: string[] = [];
  let lastIndex = 0;
  let hasConceptualContent = false;
  let match: RegExpExecArray | null;

  while ((match = xmlTagRe.exec(text)) !== null) {
    const between = text.slice(lastIndex, match.index);
    if (between.trim().length > 0) {
      // Any non-empty text between tags — this is the "concept core"
      hasConceptualContent = true;
      parts.push(`<${tag}>${targetDisplay}</${tag}>`);
    }
    parts.push(match[0]);  // keep the existing tag
    lastIndex = match.index + match[0].length;
  }

  // Trailing text after the last XML tag
  const trailing = text.slice(lastIndex);
  if (trailing.trim().length > 0) {
    hasConceptualContent = true;
    parts.push(`<${tag}>${targetDisplay}</${tag}>`);
  }

  if (!hasConceptualContent) {
    // Entire input was XML tags already — append concept tag at the end
    return `${text} <${tag}>${targetDisplay}</${tag}>`;
  }

  return parts.join(' ').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Returns true if there are any uppercase letters outside XML tags.
 */
function hasResidualUppercase(text: string): boolean {
  // Strip all content inside tags, check if anything uppercase remains
  const stripped = text.replace(/<[^>]+>[^<]*<\/[^>]+>/g, '').replace(/<[^>]+>/g, '');
  return /[A-Z]/.test(stripped);
}

// -----------------------------------------------------------------
// Public: Node 9 — run pipeline
// -----------------------------------------------------------------

export interface RegexPipelineInput {
  projectId:   string;
  triggeredBy: string;
}

export interface RegexPipelineResult {
  processed:         number;
  r01ResidualUpper:  number;   // R-01
  r02NoMatch:        number;   // R-02
  overGreedy:        number;
}

export async function runRegexPipeline(
  input: RegexPipelineInput,
): Promise<RegexPipelineResult> {
  const { projectId, triggeredBy } = input;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Fetch project greediness threshold
    const { rows: projRows } = await client.query<{
      greedThreshold: number;
    }>(
      `SELECT greediness_ratio_threshold AS "greedThreshold"
       FROM projects WHERE id = $1`,
      [projectId],
    );
    if (projRows.length === 0) throw new Error(`Project ${projectId} not found`);
    const { greedThreshold } = projRows[0];

    // Load all active qualifier patterns, ordered by category and sort_order
    const { rows: rawPatterns } = await client.query<QualPattern>(
      `SELECT pattern_text AS "patternText", flags, category, action
       FROM qualifier_patterns
       WHERE is_active = TRUE
       ORDER BY category, sort_order, id`,
    );

    const negPatterns   = rawPatterns.filter(p => p.category === 'negation');
    const qualPatterns  = rawPatterns.filter(p =>
      ['location', 'timing', 'family_history', 'causation', 'screening'].includes(p.category),
    );
    const stopPatterns  = rawPatterns.filter(p => p.category === 'stop_word');

    // Fetch all current canonical mappings for this project
    const { rows: mappings } = await client.query<{
      mappingId:     string;
      sourceText:    string;
      targetCode:    string;
      targetDisplay: string;
      conceptType:   string | null;
    }>(
      `SELECT
         cm.id                   AS "mappingId",
         cm.source_text_original AS "sourceText",
         cm.target_code          AS "targetCode",
         cm.target_display_lower AS "targetDisplay",
         cm.concept_type         AS "conceptType"
       FROM canonical_mappings cm
       WHERE cm.project_id = $1
         AND cm.is_current = TRUE`,
      [projectId],
    );

    let processed        = 0;
    let r01Count         = 0;
    let r02Count         = 0;
    let overGreedyCount  = 0;

    for (const m of mappings) {
      // L1
      const afterNormalise = applyNormalise(m.sourceText);
      // L2
      const afterNegation  = applyTagLayer(afterNormalise, negPatterns, 'neg');
      // L3
      const afterQualifier = applyTagLayer(afterNegation,  qualPatterns, 'qual');
      // L4
      const afterMfr       = applyStripLayer(afterQualifier, stopPatterns);
      // L5
      const afterConcept   = applyConceptLayer(
        afterMfr, m.targetCode, m.targetDisplay, m.conceptType,
      );

      const finalOutput       = afterConcept;
      const r01               = hasResidualUppercase(finalOutput);
      const r02               = m.targetCode === 'UNMAPPABLE';
      const sourceLen         = m.sourceText.length;
      const outputLen         = finalOutput.length || 1;
      const greedRatio        = parseFloat((sourceLen / outputLen).toFixed(4));
      const isOverGreedy      = greedRatio > greedThreshold;

      if (r01) r01Count++;
      if (r02) r02Count++;
      if (isOverGreedy) overGreedyCount++;

      // Write regex_run row
      await client.query(
        `INSERT INTO regex_runs (
           id, project_id, canonical_mapping_id,
           ran_by,
           output_after_normalise,
           output_after_negation,
           output_after_qualifier,
           output_after_manufacturer,
           output_after_concept,
           final_output,
           has_residual_uppercase,
           no_match,
           greediness_ratio,
           is_over_greedy,
           match_start_offset,
           match_length,
           replacement_length
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [
          uuidv4(), projectId, m.mappingId,
          triggeredBy,
          afterNormalise,
          afterNegation,
          afterQualifier,
          afterMfr,
          afterConcept,
          finalOutput,
          r01, r02,
          greedRatio, isOverGreedy,
          0,                       // match_start_offset — whole-term processing
          sourceLen,
          outputLen,
        ],
      );

      // Write xml_tagged_output back to canonical_mapping
      if (!r02 && finalOutput) {
        await client.query(
          `UPDATE canonical_mappings
           SET xml_tagged_output = $1
           WHERE id = $2`,
          [finalOutput, m.mappingId],
        );
      }

      processed++;
    }

    // Advance project status → regex_validate
    await client.query(
      `UPDATE projects
       SET status = 'regex_validate', current_dag_node = 'NODE_10_REGEX_VALIDATE',
           updated_at = now()
       WHERE id = $1`,
      [projectId],
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
          node: 'NODE_9_REGEX_PIPELINE',
          processed, r01Count, r02Count, overGreedyCount,
        }),
      ],
    );

    await client.query('COMMIT');

    await emit({
      source:     'omnimap',
      detailType: 'REGEX_PIPELINE_COMPLETE',
      detail: {
        projectId,
        node:     'NODE_9_REGEX_PIPELINE',
        nextNode: 'NODE_10_REGEX_VALIDATE',
        processed,
      },
    });

    return { processed, r01ResidualUpper: r01Count, r02NoMatch: r02Count, overGreedy: overGreedyCount };

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// -----------------------------------------------------------------
// Public: Node 10 — validate report (read-only)
// -----------------------------------------------------------------

export interface RegexValidateReport {
  totalRuns:            number;
  r01ResidualUpper:     number;
  r02NoMatch:           number;
  overGreedy:           number;
  overGreedyThreshold:  number;
  r01Rate:              number;
  r02Rate:              number;
  overGreedyRate:       number;
}

export async function getRegexValidateReport(
  projectId: string,
): Promise<RegexValidateReport> {
  const { rows } = await db.query<{
    totalRuns:           number;
    r01:                 number;
    r02:                 number;
    overGreedy:          number;
    greedThreshold:      number;
  }>(
    `SELECT
       COUNT(rr.id)::int                                              AS "totalRuns",
       COUNT(*) FILTER (WHERE rr.has_residual_uppercase = TRUE)::int  AS "r01",
       COUNT(*) FILTER (WHERE rr.no_match = TRUE)::int               AS "r02",
       COUNT(*) FILTER (WHERE rr.is_over_greedy = TRUE)::int         AS "overGreedy",
       p.greediness_ratio_threshold                                   AS "greedThreshold"
     FROM regex_runs rr
     JOIN projects p ON p.id = rr.project_id
     WHERE rr.project_id = $1
     GROUP BY p.greediness_ratio_threshold`,
    [projectId],
  );

  if (rows.length === 0) {
    return {
      totalRuns: 0, r01ResidualUpper: 0, r02NoMatch: 0,
      overGreedy: 0, overGreedyThreshold: 2.0,
      r01Rate: 0, r02Rate: 0, overGreedyRate: 0,
    };
  }

  const r = rows[0];
  const n = r.totalRuns || 1;
  return {
    totalRuns:           r.totalRuns,
    r01ResidualUpper:    r.r01,
    r02NoMatch:          r.r02,
    overGreedy:          r.overGreedy,
    overGreedyThreshold: Number(r.greedThreshold),
    r01Rate:             parseFloat((r.r01 / n).toFixed(4)),
    r02Rate:             parseFloat((r.r02 / n).toFixed(4)),
    overGreedyRate:      parseFloat((r.overGreedy / n).toFixed(4)),
  };
}

// -----------------------------------------------------------------
// Public: Node 11 — corpus update (advance status)
// -----------------------------------------------------------------

export interface CorpusUpdateInput {
  projectId:   string;
  triggeredBy: string;
}

export interface CorpusUpdateResult {
  message: string;
}

export async function runCorpusUpdate(
  input: CorpusUpdateInput,
): Promise<CorpusUpdateResult> {
  const { projectId, triggeredBy } = input;

  await db.query(
    `UPDATE projects
     SET status = 'scoring', current_dag_node = 'NODE_12_SCORE', updated_at = now()
     WHERE id = $1`,
    [projectId],
  );

  await db.query(
    `INSERT INTO audit_log
       (user_id, system_flag, action, entity_type, entity_id, project_id, payload)
     VALUES ($1, NULL, $2, 'project', $3, $4, $5)`,
    [
      triggeredBy,
      AuditAction.PROJECT_STATUS_CHANGED,
      projectId, projectId,
      JSON.stringify({ node: 'NODE_11_CORPUS_UPDATE', nextNode: 'NODE_12_SCORE' }),
    ],
  );

  await emit({
    source:     'omnimap',
    detailType: 'CORPUS_UPDATE_COMPLETE',
    detail: { projectId, node: 'NODE_11_CORPUS_UPDATE', nextNode: 'NODE_12_SCORE' },
  });

  return { message: 'Corpus update complete. Project advanced to scoring.' };
}
