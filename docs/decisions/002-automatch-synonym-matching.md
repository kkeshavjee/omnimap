# ADR-002 — Automatch: match on PT + synonyms, not FSN only

**Date:** 2026-03-30
**Status:** Accepted
**Deciders:** Karim Keshavjee

---

## Context

Node 4 AUTOMATCH originally compared source terms against SNOMED CT Fully Specified
Names (FSNs) only, using the Infoway FHIR `ValueSet/$expand` endpoint. During the
first end-to-end test run it was observed that valid matches were being missed because
EMR source terms frequently use Preferred Terms or synonyms rather than FSNs.

Example: a source term matching a SNOMED synonym would return no match under the
FSN-only approach, routing the term unnecessarily to the reviewer queue.

## Decision

Extend `findExactTerm` (previously `findExactFsn`) to match against the Preferred
Term (`display` field) **and** all synonyms via `includeDesignations=true` on the
Infoway `ValueSet/$expand` call.

The old `findExactFsn` export is preserved as a deprecated alias for backward
compatibility.

## Rationale

SNOMED CT FSNs are often verbose and unambiguous (e.g. "Urinary tract infection
(disorder)") whereas EMR systems record Preferred Terms or clinical synonyms. Matching
only on FSN systematically under-identifies valid auto-matches, inflating the reviewer
workload without improving quality.

## Alternatives considered

| Option | Why rejected |
|---|---|
| FSN-only matching | Misses legitimate matches; EMR terms rarely use FSN form |
| Fuzzy / edit-distance matching | Risk of false positives; not appropriate for a high-stakes clinical mapping tool |
| Manual corpus pre-load | Time-intensive; Infoway live search is more maintainable |

## Consequences

- Automatch recall improves (fewer terms unnecessarily routed to reviewers)
- Slight increase in Infoway API payload per request (`includeDesignations=true`)
- `findExactTerm` now checks: Preferred Term → FSN → all synonyms (in that order)
- The deprecated `findExactFsn` alias will be removed in a future ADR once all call
  sites are confirmed updated

## References

- `backend/src/services/infowayFhir.ts` — `findExactTerm`
- `backend/src/services/holdout.ts` — call site
- PRD Section 5.4 — Node 4 AUTOMATCH specification
