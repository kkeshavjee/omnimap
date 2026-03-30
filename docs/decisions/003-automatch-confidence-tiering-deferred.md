# ADR-003 — Automatch confidence tiering: deferred pending holdout evidence

**Date:** 2026-03-30
**Status:** Accepted (decision to defer)
**Deciders:** Karim Keshavjee

---

## Context

The canonical form preprocessor (`clinicalNlp.canonicalMatchForm`) applies stop word
stripping before automatch. Several stop words are moderate-risk: `\bdue\b`,
`\bcaused\b`, `\bNOS\b`. Stripping these could cause a specific term to collapse to a
broader concept — e.g. "Anemia due to blood loss" → "Anemia blood loss" → matching
the generic "Anemia" SNOMED concept rather than the correct more specific concept.

Three options were evaluated before the first end-to-end test run.

## Decision

**Option C — do nothing; rely on holdout F1 scoring to detect systematic errors.**

Revisit after the first holdout validation run with real data.

## Rationale

An empirical investigation on 2026-03-30 against the first real dataset (202
auto-matched terms) found:

1. The moderate-risk words (`NOS`, `unspecified`, `due`, `caused`) were **not being
   stripped** in any auto-matched term in this dataset.
2. `HYPOTHYROIDISM NOS` matched with NOS intact (to a legacy SNOMED NOS concept
   267377003). `ANEMIA UNSPECIFIED` matched with "unspecified" intact (to 154812000).
3. Actual stripping was confined to safe stop words: `OF`, `AND`, `THE`,
   punctuation, apostrophes — all resulting matches were verified correct.
4. A side finding: French accented terms (`DÉPRESSION MAJEURE`, `HYPOTHYROÏDIE`)
   are matched via Infoway's French synonym lookup on the raw display term, bypassing
   the canonical form entirely. The canonical form mangling of accented characters
   is a latent risk only for corpus fallback — documented separately below.

Given the evidence, tiering adds implementation cost without demonstrated benefit in
this dataset.

## Alternatives considered

| Option | Description | Why deferred |
|---|---|---|
| Option A (recommended if needed) | Track whether moderate-risk stop words were applied; route those terms to an adjudicator "quick confirm" queue instead of auto-accepting | No evidence of false positives in dataset; adds UI and DB complexity |
| Option B | All auto-matches go to adjudicator bulk-confirm before canonicalising | Defeats the purpose of automatch; rejected |
| Option C (chosen) | Do nothing; let holdout F1 reveal systematic errors | Justified by empirical data |

## Implementation plan if Option A is needed post-holdout

1. `holdout.ts` — track `matchRequiredStripOf: string[]` during the match loop
2. If list non-empty → set `status = 'automatch_review'` instead of `'auto_matched'`
3. New adjudicator endpoint + UI for bulk confirm/reject of `automatch_review` terms
4. Migration 006: add `automatch_confidence` column to `project_terms`

## Consequences

- Holdout F1 score is the primary quality signal; if it falls below 0.90, revisit
- French accented character handling in `canonicalMatchForm` should be fixed before
  production if French EMR data is expected in corpus fallback path (low priority now)

## References

- `backend/src/services/clinicalNlp.ts` — `canonicalMatchForm`
- `backend/db/migrations/003_qualifier_patterns.sql` — stop word patterns
- SQL investigation query (2026-03-30): see CLAUDE.md design decision note
- PRD Section 5.4 — Node 4 AUTOMATCH specification
