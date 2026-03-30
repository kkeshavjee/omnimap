# ADR-004 — DAG node idempotency: guards on Nodes 3 and 4

**Date:** 2026-03-30
**Status:** Accepted
**Deciders:** Karim Keshavjee

---

## Context

During the first end-to-end test run, Nodes 3 (Sample) and 4 (Holdout Draw +
Automatch) were intentionally re-run to observe system behaviour. This revealed three
bugs:

1. **Node 4 had no idempotency guard** — running it twice drew 734 holdout terms
   (367 × 2), corrupting the holdout set.
2. **Node 3 had no post-holdout guard** — it could be re-run after the holdout was
   locked, creating new sampled terms that diluted the pool.
3. **Sample config created before `sampleTerms` ran** — if the service returned
   early or threw, an unlocked orphan `sample_config` record was left in the database.

The project status was also left as `sampling` (the Node 3 completion state) after
Node 4 ran successfully, because a subsequent re-ingest reset it.

## Decision

Add explicit idempotency guards to both services and the route layer:

- **`holdout.ts`**: Check `holdout_locked_at IS NOT NULL` at the start; throw if set.
- **`sample.ts`**: Check `holdout_locked_at IS NOT NULL` at the start; throw if set.
- **`projects.ts` (sample route)**: Check `holdout_locked_at` before creating the
  sample config record, so no orphan config is created on a blocked request.
- **UI (`ProjectDetailPage`)**: All DAG node buttons derive their disabled state from
  server-side locked timestamps (`holdoutLockedAt`, `sampleLockedAt`), not local
  React state. Local state resets on page reload; server state does not.

## Rationale

The pipeline is irreversible by design after Node 4 (holdout lock is a statistical
integrity requirement). Allowing re-runs corrupts the holdout set and invalidates
the power calculation. Guards must live at the service layer (not just UI) to be
enforceable.

## Consequences

- Node 4 is a one-way door: once `holdout_locked_at` is set, it cannot be re-run
  without a DBA-level manual reset
- Node 3 is similarly locked after Node 4 completes
- Orphan sample configs no longer created on blocked requests
- UI buttons reflect server state on every page load (no stale client state)
- Data repair performed on 2026-03-30: 367 duplicate holdout terms reset to
  `sampled`, orphan configs deleted, project status corrected to `allocating`

## References

- `backend/src/services/holdout.ts`
- `backend/src/services/sample.ts`
- `backend/src/routes/projects.ts`
- `frontend/src/features/admin/ProjectDetailPage.tsx`
