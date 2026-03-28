// OmniMap — Clinical NLP Annotation Service
//
// Produces lightweight NLP annotations from raw EMR display terms.
// Called at Node 1 (INGEST); results stored in source_terms columns.
// Results are SIGNALS ONLY — the original display_term is never modified.
//
// ── Output fields ────────────────────────────────────────────────────────────
//   displayTermMatch  — normalised form for dedup / automatch comparison only
//                       (abbrev expansion + stop word removal + punct strip + UPPER)
//   isNegated         — negation signal detected
//   laterality        — 'left' | 'right' | 'bilateral' | null
//   qualifierSeverity — 'mild' | 'moderate' | 'severe' | null
//   qualifierAcuity   — 'acute' | 'subacute' | 'chronic' | null
//   qualifierCertainty — 'possible' | 'probable' | 'definite' | null
//
// ── Adding your own patterns ─────────────────────────────────────────────────
//   1. Abbreviation expansions  → ABBREVIATION_EXPANSIONS map below
//   2. Stop words               → CLINICAL_STOP_WORDS set below
//   3. Negation patterns        → NEGATION_PATTERNS array below
//   4. Laterality patterns      → LATERALITY_PATTERNS array below
//   5. Qualifier patterns       → SEVERITY / ACUITY / CERTAINTY arrays below
//
// ── What NOT to put here ─────────────────────────────────────────────────────
//   Full regex pipeline patterns (concept tagging, xml-output generation)
//   belong in the Node 9–11 regex pipeline services, not here.
//   These annotations are intentionally lightweight — O(n) per term at ingest.

// =============================================================================
// 1. ABBREVIATION EXPANSIONS
//    Expands clinical shorthand BEFORE stop word removal.
//    Key: regex that matches the abbreviation (case-insensitive, with boundaries).
//    Value: replacement string (lower-case; will be upper-cased in match form).
//
//    IMPORTANT: # is context-sensitive.
//      #  at end of term, or followed by a body part → "fracture"
//      #  before a digit → drop (it means "number")
//
//    Order matters — patterns are applied top-to-bottom.
// =============================================================================

interface AbbrevRule {
  pattern:     RegExp;
  replacement: string;
}

const ABBREVIATION_RULES: AbbrevRule[] = [
  // # (fracture) — must come before the digit-number rule
  { pattern: /\bfx\b/gi,                          replacement: 'fracture' },
  { pattern: /#\s*(?=[a-z])/gi,                   replacement: 'fracture ' },   // "# knee" → "fracture knee"
  { pattern: /(?<=[a-z])\s*#\s*$/gi,              replacement: ' fracture' },   // "knee #" → "knee fracture"
  { pattern: /#(?=\d)/g,                           replacement: '' },            // "#3" → "3" (list numbering)
  { pattern: /\b#\b/g,                             replacement: 'fracture' },   // standalone #

  // Common surgical / diagnostic abbreviations
  { pattern: /\bhx\b/gi,                           replacement: 'history' },
  { pattern: /\bdx\b/gi,                           replacement: 'diagnosis' },
  { pattern: /\brx\b/gi,                           replacement: 'treatment' },
  { pattern: /\bsx\b/gi,                           replacement: 'symptoms' },
  { pattern: /\bax\b/gi,                           replacement: 'assessment' },
  { pattern: /\btx\b/gi,                           replacement: 'treatment' },
  { pattern: /\bca\b/gi,                           replacement: 'cancer' },
  { pattern: /\bmi\b/gi,                           replacement: 'myocardial infarction' },
  { pattern: /\bcva\b/gi,                          replacement: 'cerebrovascular accident' },
  { pattern: /\btia\b/gi,                          replacement: 'transient ischemic attack' },
  { pattern: /\buti\b/gi,                          replacement: 'urinary tract infection' },
  { pattern: /\burti\b/gi,                         replacement: 'upper respiratory tract infection' },
  { pattern: /\blrti\b/gi,                         replacement: 'lower respiratory tract infection' },
  { pattern: /\bdm\b/gi,                           replacement: 'diabetes mellitus' },
  { pattern: /\bht\b/gi,                           replacement: 'hypertension' },
  { pattern: /\bhtn\b/gi,                          replacement: 'hypertension' },
  { pattern: /\bchf\b/gi,                          replacement: 'congestive heart failure' },
  { pattern: /\bcad\b/gi,                          replacement: 'coronary artery disease' },
  { pattern: /\bcopd\b/gi,                         replacement: 'chronic obstructive pulmonary disease' },
  { pattern: /\bgerd\b/gi,                         replacement: 'gastroesophageal reflux disease' },
  { pattern: /\bibd\b/gi,                          replacement: 'inflammatory bowel disease' },
  { pattern: /\bra\b/gi,                           replacement: 'rheumatoid arthritis' },
  { pattern: /\boa\b/gi,                           replacement: 'osteoarthritis' },
  { pattern: /\bpe\b/gi,                           replacement: 'pulmonary embolism' },
  { pattern: /\bdvt\b/gi,                          replacement: 'deep vein thrombosis' },
  { pattern: /\bafib\b/gi,                         replacement: 'atrial fibrillation' },
  { pattern: /\ba\.?fib\.?\b/gi,                   replacement: 'atrial fibrillation' },
  { pattern: /\bsob\b/gi,                          replacement: 'shortness of breath' },
  { pattern: /\bcp\b/gi,                           replacement: 'chest pain' },
  { pattern: /\bha\b/gi,                           replacement: 'headache' },
  { pattern: /\bnad\b/gi,                          replacement: 'no acute distress' },
  { pattern: /\bn\.?a\.?d\.?\b/gi,                 replacement: 'no acute distress' },
  { pattern: /\bwob\b/gi,                          replacement: 'work of breathing' },
  { pattern: /\bk\+\b/gi,                          replacement: 'potassium' },
  { pattern: /\bna\+\b/gi,                         replacement: 'sodium' },

  // Punctuation-carried shorthand
  { pattern: /\+ve\b/gi,                           replacement: 'positive' },
  { pattern: /-ve\b/gi,                            replacement: 'negative' },
  { pattern: /\(\+\)/g,                            replacement: 'positive' },
  { pattern: /\(-\)/g,                             replacement: 'negative' },

  // Commas used as "with" in comorbidity lists — expand before stop word pass
  { pattern: /,\s+/g,                              replacement: ' ' },
];

// =============================================================================
// 2. CLINICAL STOP WORDS
//    Removed from display_term_match ONLY.  Original text is untouched.
//
//    Rule: a word is a stop word here if removing it cannot change which
//    SNOMED concept the term refers to.
//
//    DO NOT include:
//      no, not, without, absent   — negation markers
//      left, right, bilateral     — laterality (change the concept)
//      mild, moderate, severe     — severity (change the concept)
//      acute, chronic, subacute   — acuity (change the concept)
//      type (as in "type 2")      — numeric qualifier
//      primary, secondary         — ordering (can change the concept)
// =============================================================================

const CLINICAL_STOP_WORDS = new Set([
  // Articles
  'a', 'an', 'the',
  // Prepositions safe to remove in anatomical context
  'of', 'in', 'at', 'on', 'to', 'by', 'for', 'with', 'due', 'via',
  'into', 'onto', 'from', 'into', 'about',
  // Linking words
  'and', 'or',
  // Clinical prose fillers
  'history', 'presenting', 'complaint', 'diagnosis', 'confirmed',
  'known', 'reported', 'documented',
]);

// =============================================================================
// 3. NEGATION PATTERNS
//    Detect negation signals in the display term.
//    The term still flows through review — reviewers map it to the
//    correct SNOMED "absence" or "no history of" concept.
//
//    Add your own negation regex patterns to NEGATION_PATTERNS.
//    Pattern should match the full negation signal; is tested against
//    the lower-cased display term.
// =============================================================================

const NEGATION_PATTERNS: RegExp[] = [
  /\bno\b/i,
  /\bnot\b/i,
  /\bnon[-\s]?/i,
  /\bwithout\b/i,
  /\babsent\b/i,
  /\babsence\s+of\b/i,
  /\bdenies\b/i,
  /\bdenied\b/i,
  /\bnegative\s+for\b/i,
  /\brule[ds]?\s+out\b/i,
  /\br\/o\b/i,
  /\bexclude[ds]?\b/i,
  /\bunlikely\b/i,
  /\bno\s+evidence\s+of\b/i,
  /\bno\s+history\s+of\b/i,
  /\bnever\b/i,
];

// =============================================================================
// 4. LATERALITY PATTERNS
//    Extracted and stored as a signal; NOT removed from display_term_match
//    because laterality changes the SNOMED concept.
//
//    Add your own laterality patterns here.
// =============================================================================

interface LateralityRule {
  pattern:   RegExp;
  laterality: 'left' | 'right' | 'bilateral';
}

const LATERALITY_PATTERNS: LateralityRule[] = [
  { pattern: /\bleft\b/i,          laterality: 'left' },
  { pattern: /\blt\.?\b/i,         laterality: 'left' },
  { pattern: /\bl\.?\s*knee\b/i,   laterality: 'left' },
  { pattern: /\bright\b/i,         laterality: 'right' },
  { pattern: /\brt\.?\b/i,         laterality: 'right' },
  { pattern: /\br\.?\s*knee\b/i,   laterality: 'right' },
  { pattern: /\bbilateral\b/i,     laterality: 'bilateral' },
  { pattern: /\bbilatéral\b/i,     laterality: 'bilateral' },  // French
  { pattern: /\bb\/l\b/i,          laterality: 'bilateral' },
  { pattern: /\bgauche\b/i,        laterality: 'left' },       // French
  { pattern: /\bdroit[e]?\b/i,     laterality: 'right' },      // French
];

// =============================================================================
// 5. QUALIFIER PATTERNS
//    Stored as signals; NOT removed from display_term_match.
//    Add your own patterns in each section.
// =============================================================================

// ── Severity ──────────────────────────────────────────────────────────────────
interface QualifierRule {
  pattern: RegExp;
  value:   string;
}

const SEVERITY_PATTERNS: Array<QualifierRule & { value: 'mild' | 'moderate' | 'severe' }> = [
  { pattern: /\bmild\b/i,                                  value: 'mild' },
  { pattern: /\bléger[e]?\b/i,                             value: 'mild' },    // French
  { pattern: /\bmoderate\b/i,                              value: 'moderate' },
  { pattern: /\bmodéré[e]?\b/i,                            value: 'moderate' }, // French
  { pattern: /\bsevere\b/i,                                value: 'severe' },
  { pattern: /\bsévère\b/i,                                value: 'severe' },   // French
  { pattern: /\bsignificant\b/i,                           value: 'severe' },
  { pattern: /\bgrave\b/i,                                 value: 'severe' },
];

// ── Acuity ────────────────────────────────────────────────────────────────────
const ACUITY_PATTERNS: Array<QualifierRule & { value: 'acute' | 'subacute' | 'chronic' }> = [
  { pattern: /\bacute\b/i,                                 value: 'acute' },
  { pattern: /\baigu[ë]?\b/i,                              value: 'acute' },   // French
  { pattern: /\bsubacute\b/i,                              value: 'subacute' },
  { pattern: /\bsub[-\s]?acute\b/i,                        value: 'subacute' },
  { pattern: /\bchronic\b/i,                               value: 'chronic' },
  { pattern: /\bchronique\b/i,                             value: 'chronic' },  // French
  { pattern: /\blong[- ]?standing\b/i,                     value: 'chronic' },
  { pattern: /\bpersistent\b/i,                            value: 'chronic' },
  { pattern: /\brecurrent\b/i,                             value: 'chronic' },
  { pattern: /\brecurrent\b/i,                             value: 'chronic' },
];

// ── Certainty ─────────────────────────────────────────────────────────────────
const CERTAINTY_PATTERNS: Array<QualifierRule & { value: 'possible' | 'probable' | 'definite' }> = [
  { pattern: /\bpossible\b/i,                              value: 'possible' },
  { pattern: /\bpossible\b/i,                              value: 'possible' },
  { pattern: /\bpossiblement\b/i,                          value: 'possible' }, // French
  { pattern: /\bsuspected\b/i,                             value: 'possible' },
  { pattern: /\bsuspect[eé][e]?\b/i,                       value: 'possible' }, // French
  { pattern: /\br\/o\b/i,                                  value: 'possible' }, // rule-out
  { pattern: /\bquestion(?:able)?\b/i,                     value: 'possible' },
  { pattern: /\bprobable\b/i,                              value: 'probable' },
  { pattern: /\bprobably\b/i,                              value: 'probable' },
  { pattern: /\bprobablement\b/i,                          value: 'probable' }, // French
  { pattern: /\blikely\b/i,                                value: 'probable' },
  { pattern: /\bpresumptive\b/i,                           value: 'probable' },
  { pattern: /\bconfirmed\b/i,                             value: 'definite' },
  { pattern: /\bdefinite\b/i,                              value: 'definite' },
  { pattern: /\bdiagnosed\b/i,                             value: 'definite' },
  { pattern: /\bestablished\b/i,                           value: 'definite' },
  { pattern: /\bknown\b/i,                                 value: 'definite' },
];

// =============================================================================
// Public types and annotate() function
// =============================================================================

export type Laterality       = 'left' | 'right' | 'bilateral';
export type Severity         = 'mild' | 'moderate' | 'severe';
export type Acuity           = 'acute' | 'subacute' | 'chronic';
export type Certainty        = 'possible' | 'probable' | 'definite';

export interface NlpAnnotation {
  /** Normalised match form: abbrev-expanded, stop-word-stripped, punct-stripped, UPPER */
  displayTermMatch:    string;
  isNegated:           boolean;
  laterality:          Laterality | null;
  qualifierSeverity:   Severity   | null;
  qualifierAcuity:     Acuity     | null;
  qualifierCertainty:  Certainty  | null;
}

const PUNCT_RE = /[^\w\s]/g;

/**
 * Annotate a single display_term from an EMR extract.
 * This is the main entry point; all other functions are internal helpers.
 *
 * @param displayTerm  The raw cell value (already unicode-normalised by normaliseCell).
 * @returns            NlpAnnotation — all fields are safe to INSERT directly.
 */
export function annotate(displayTerm: string): NlpAnnotation {
  // Work on lower-cased copy for detection; original case preserved in displayTerm
  const lower = displayTerm.toLowerCase();

  // ── Negation ──────────────────────────────────────────────────────────────
  const isNegated = NEGATION_PATTERNS.some(p => p.test(lower));

  // ── Laterality ────────────────────────────────────────────────────────────
  let laterality: Laterality | null = null;
  for (const rule of LATERALITY_PATTERNS) {
    if (rule.pattern.test(displayTerm)) {
      laterality = rule.laterality;
      break;
    }
  }

  // ── Severity ──────────────────────────────────────────────────────────────
  let qualifierSeverity: Severity | null = null;
  for (const rule of SEVERITY_PATTERNS) {
    if (rule.pattern.test(displayTerm)) {
      qualifierSeverity = rule.value;
      break;
    }
  }

  // ── Acuity ────────────────────────────────────────────────────────────────
  let qualifierAcuity: Acuity | null = null;
  for (const rule of ACUITY_PATTERNS) {
    if (rule.pattern.test(displayTerm)) {
      qualifierAcuity = rule.value;
      break;
    }
  }

  // ── Certainty ─────────────────────────────────────────────────────────────
  let qualifierCertainty: Certainty | null = null;
  for (const rule of CERTAINTY_PATTERNS) {
    if (rule.pattern.test(displayTerm)) {
      qualifierCertainty = rule.value;
      break;
    }
  }

  // ── Match form ────────────────────────────────────────────────────────────
  // 1. Apply abbreviation expansions
  let matchForm = displayTerm;
  for (const rule of ABBREVIATION_RULES) {
    matchForm = matchForm.replace(rule.pattern, rule.replacement);
  }

  // 2. Strip punctuation (AFTER expansion so expanded text keeps spaces)
  matchForm = matchForm.replace(PUNCT_RE, ' ');

  // 3. Remove stop words (whole-word match only)
  const tokens = matchForm
    .split(/\s+/)
    .filter(tok => tok.length > 0 && !CLINICAL_STOP_WORDS.has(tok.toLowerCase()));

  // 4. Collapse and upper-case
  matchForm = tokens.join(' ').replace(/\s+/g, ' ').trim().toUpperCase();

  return {
    displayTermMatch: matchForm,
    isNegated,
    laterality,
    qualifierSeverity,
    qualifierAcuity,
    qualifierCertainty,
  };
}

/**
 * Canonical form for automatch comparison — same as displayTermMatch.
 * Provided as a named export so holdout.ts can import it directly
 * instead of duplicating the canonicalForm() function it currently has.
 */
export function canonicalMatchForm(s: string): string {
  return annotate(s).displayTermMatch;
}
