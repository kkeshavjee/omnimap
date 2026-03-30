# ADR-005 — Infoway search: activeOnly + deduplication by code

**Date:** 2026-03-30
**Status:** Accepted
**Deciders:** Karim Keshavjee

---

## Context

During the first reviewer test session, duplicate and potentially inactive SNOMED CT
concepts appeared in the terminology search results in the mapping workspace. The
search uses Infoway's `ValueSet/$expand` endpoint against the implicit SNOMED CT
ValueSet (`http://snomed.info/sct?fhir_vs`).

Two root causes were identified:

1. **Duplicates**: Ontoserver returns the same concept multiple times when the search
   filter matches both the FSN and a synonym for the same concept. The `$expand`
   response can include the same `code` with different `display` values.
2. **Inactive concepts**: The implicit `fhir_vs` ValueSet does not explicitly enforce
   `activeOnly=true` on all Ontoserver versions. Retired SNOMED CT concepts may
   appear in results.

## Decision

In `searchSnomedConcepts` (`infowayFhir.ts`):

1. Add `activeOnly=true` to the `$expand` query parameters.
2. Request `count = limit * 2` to absorb duplicates before slicing to the requested
   limit.
3. Deduplicate results by SNOMED code before returning, keeping the first occurrence
   (which Ontoserver orders by relevance score).

## Rationale

Showing duplicate concepts to reviewers degrades UX and can cause confusion about
which entry to select. Showing retired concepts is a patient safety risk — a reviewer
might map a term to a concept that is no longer part of the active release.

## Alternatives considered

| Option | Why rejected |
|---|---|
| Deduplicate on the client (frontend) | Server is the right place; all consumers benefit; client doesn't know which is duplicate |
| Use a different ValueSet URL | Infoway's implicit `fhir_vs` is the standard approach; switching requires Infoway support |

## Consequences

- Active-concepts-only enforced at API call level
- Search result list is deduplicated by SNOMED code before being returned to the client
- Effective result count may be lower than `limit` if many duplicates exist; mitigated
  by fetching `limit * 2` from Infoway before deduplication
- `findExactTerm` (automatch) does **not** yet add `activeOnly=true` — should be
  added in a follow-up (low risk: exact match on an inactive concept is unlikely but
  possible)

## References

- `backend/src/services/infowayFhir.ts` — `searchSnomedConcepts`
- Infoway FHIR Terminology Server documentation
- PRD Section 5.5 — Reviewer search interface
