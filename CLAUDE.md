# OmniMap — Claude Code Orientation

---

## 🔖 NEXT SESSION — Pick up here (last updated 2026-03-20)

### Immediate actions (in order)
1. **Create a feature branch** — `git checkout -b feature/end-to-end-test` before touching any code
2. **Invite 2 reviewer accounts** via Admin → Users → Invite User (role: Reviewer)
3. **Karim creates his own adjudicator account** via Admin → Users → Invite User (role: Adjudicator)
4. **Run the full pipeline end-to-end** with a real or synthetic dataset:
   - Node 1 Ingest → Node 2 Deduplicate → Node 3 Sample → Node 4 Holdout/Automatch → Node 5 Allocate
   - Both reviewers log in and map their assigned terms (including at least one SNOMED gap)
   - Disagreement terms route to adjudication queue
   - Karim adjudicates as Adjudicator
   - Node 8 Canonicalise → Node 13 Export + Gap Report
5. **Fix the pre-existing TypeScript warning** in `frontend/src/features/admin/UsersPage.tsx` line 174 (`action` declared but never read) — minor cleanup

### Waiting on
- ✅ **Infoway FHIR credentials received 2026-03-28** — added to `backend/.env`. Backend restarted. Live SNOMED CT Canadian Edition search + automatch active.

### Known gaps to address (post-testing)
- Forgot password link on login page (not yet implemented)
- FR-113 deduplication surfacing of known gaps (Phase 2)
- Production deployment to EC2 (replace Supabase with Aurora Serverless v2, Nginx + Certbot, PM2)

### 🤔 Design decision pending — Automatch confidence tiering
**Context:** Stop words `\bdue\b`, `\bcaused\b`, `\bNOS\b` are still in the stop word list and are applied
during automatch. A term like "Anemia due to blood loss" stripped to "Anemia blood loss" could
false-positive match to the generic "Anemia" SNOMED concept.

**Decision needed:** Should automatch be tiered by confidence?
- **Option A (recommended):** Track whether moderate-risk stop words were applied during matching.
  - Zero stop words stripped → auto-accept (Node 8, as now)
  - Moderate-risk words stripped → route to adjudicator "quick confirm" queue instead
- **Option B:** All auto-matches go to adjudicator bulk-confirm screen before canonicalising
- **Option C:** Leave as-is; rely on holdout F1 scoring to expose systematic errors post-testing

**Current state:** Option C (do nothing for now). Revisit after first end-to-end test run with
real data — the holdout score will show whether the moderate-risk strips are causing wrong matches.

Implementation of Option A requires:
1. `holdout.ts` — track `matchRequiredStripOf: string[]` during the match loop
2. If list non-empty → set `status = 'automatch_review'` instead of `'auto_matched'`
3. New adjudicator endpoint + UI for bulk confirm/reject of `automatch_review` terms
4. `project_terms` table may need `automatch_confidence` column (migration 006)

---

## What This Project Is
OmniMap is a clinical terminology mapping platform built by Omni Health Nexus Inc. (OHN).
It maps source EMR terms to target terminologies (SNOMED CT, LOINC, ATC, CCDD, ICD-10/11)
using a dual-independent-review workflow with AI assistance.

Full requirements are in `docs/OmniMap_PRD_v2.3.docx`. When in doubt, the PRD is the source of truth.
The runtime DAG (how OmniMap behaves at runtime) is in PRD Section 5.
This file tells Claude Code what to BUILD and in what order.

---

## Tech Stack
| Layer | Technology |
|---|---|
| Backend API | Node.js + TypeScript (Express) |
| Frontend | React + TypeScript (Vite) |
| AI Agents | Python 3.11+ |
| Database | PostgreSQL (Aurora Serverless v2 on AWS) |
| Auth | AWS Cognito (JWT + MFA) |
| Hosting | AWS Lambda + API Gateway |
| Orchestration | AWS EventBridge + SQS (event-driven, not polling) |
| CI/CD | GitHub Actions |

---

## Repo Structure
```
omnimap/
├── CLAUDE.md
├── docs/
│   └── PRD_v2.2.docx
├── backend/
│   ├── src/
│   │   ├── routes/
│   │   ├── services/      ← One file per DAG node
│   │   ├── middleware/    ← Auth, RBAC, audit logging
│   │   └── types/
│   ├── ai/
│   │   ├── suggestion/    ← NLP concept suggestion (Python)
│   │   ├── regex/
│   │   │   ├── layers/    ← normalise, negation, qualifier, manufacturer, concept
│   │   │   ├── validator/ ← post-run reporting
│   │   │   └── corpus/    ← import, versioning, flywheel update
│   │   └── scoring/       ← F1, power calc (Python)
│   ├── db/
│   │   └── migrations/    ← Numbered SQL files — never edit old ones
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── features/
│   │   ├── components/
│   │   ├── hooks/
│   │   └── api/
│   └── package.json
├── .env.example
└── README.md
```

---

## Build Order (DAG-Derived)
Build in this sequence. Each step must be working before starting the next.
This order mirrors the runtime DAG in PRD Section 5.

### Phase A — Foundation
1. `backend/db/migrations/` — schema first, everything depends on it
2. `backend/src/types/` — TypeScript domain types
3. `backend/src/middleware/` — auth (Cognito JWT), RBAC, audit log writer

### Phase B — Core Orchestration (DAG Nodes 0–5)
4. **Node 0 PROJECT_INIT** — project creation, corpus snapshot, external mapping import (read-only)
5. **Node 1 INGEST** — CSV/Excel parsing, frequency validation
6. **Node 2 DEDUPLICATE** — cross-reference OmniMap corpus + external reference; net-new → queue
7. **Node 3 SAMPLE** — random / stratified / frequency / Pareto; long tail queue prioritisation
8. **Node 4 HOLDOUT_DRAW + AUTOMATCH** — power calc (F1≥0.90, alpha=0.05, power=0.80); lock holdout; then run AUTOMATCH pre-check on every term in the mapping pool:
   - Source term canonical form (upper-case + punctuation strip) = SNOMED CT FSN canonical form?
   - YES → auto-accept; bypass reviewer queues entirely; route directly to Node 8 CANONICALISE with auto-accept flag
   - NO → Node 5 ALLOCATE → normal reviewer workflow
   - Phase 1: SNOMED CT FSN only. Auto-accepted terms reported separately — never mixed into adjudication rate.
9. **Node 5 ALLOCATE** — affinity-weighted pool assignment; only non-auto-matched terms enter reviewer queues; every term → exactly 2 reviewers; silent load balancer

### Phase C — Reviewer Interface (DAG Node 6)
10. Frontend shell — auth, routing, role-based layout
11. Admin dashboard — project management, pool assembly, cross-project status, regex dashboard reports
12. **Node 6 MAP** — reviewer mapping workspace:
    - Split-screen, keyboard navigation, AI suggestions (advisory), keyword search
    - Layer-by-layer regex pipeline output view (R-03)
    - Batch accept: manual clusters ONLY — AI batch accept PROHIBITED at API level
    - Personal metrics dashboard (own data only)

### Phase D — Quality Control (DAG Nodes 7–8)
13. **Node 7 ADJUDICATE** — anonymised A+B, rationale, hierarchy context; R-01/R-02 escalation routing
14. **Node 8 CANONICALISE** — apply output convention; write audit log; route by project type

### Phase E — Regex Pipeline (DAG Nodes 9–11)
15. **Node 9 REGEX_PIPELINE** — five sequential layers (see Regex Pipeline below)
16. **Node 10 REGEX_VALIDATE** — post-run reporting: reviewer R-01/R-02/R-03 + admin dashboard reports
17. **Node 11 CORPUS_UPDATE** — write validated pattern to corpus with version + author + timestamp

### Phase F — Scoring + Export (DAG Nodes 12–13)
18. **Node 12 SCORE** — four-point scoring; P/R/F1; 95% CIs; pass/fail vs threshold
19. **Node 13 EXPORT** — FHIR ConceptMap R4/R5, Regex JSON, CSV/Excel, PDF reports

### Phase G — AI Suggestion Agent (last — external dependencies)
20. `backend/ai/suggestion/` — do not start until embedding model is decided (see Open Questions)

---

## Regex Pipeline (PRD Section 5.10)
Five layers, executed sequentially. Build as five modules in `backend/ai/regex/layers/`.

| Layer | Module | What it does |
|---|---|---|
| 1 | `normalise.py` | Upper-case at match time. Never stored. |
| 2 | `negation.py` | Tags negation: `<neg>no history of</neg>`. Additive only. |
| 3 | `qualifier.py` | Tags qualifiers: `<qual>severe</qual>`. Separate preceding tag. |
| 4 | `manufacturer.py` | Strips brand prefixes: APO-METFORMIN → METFORMIN. |
| 5 | `concept.py` | Maps to typed lower-case tagged replacement. |

Layers 2–4 use manually maintained corpora imported by the administrator.
Layer 5 (concept) corpus grows via the OmniMap review workflow.

---

## Regex Output Convention (applied at Node 8 CANONICALISE)
- Source text: stored as original. Upper-case at match time only — never persisted.
- Replacement: lower-case, wrapped in XML closing tags:

| Concept | Tag |
|---|---|
| Diagnosis | `<dx>term</dx>` |
| Medication | `<med>term</med>` |
| Procedure | `<proc>term</proc>` |
| Lab | `<lab>term</lab>` |
| Symptom | `<sx>term</sx>` |
| Allergy | `<allergy>term</allergy>` |
| Device | `<device>term</device>` |
| Risk factor | `<risk>term</risk>` |

Qualifiers: separate preceding tag — `<qual>severe</qual><dx>diabetes</dx>`
Example final string: `<neg>no history of</neg> <qual>severe</qual> <med>metformin</med>`

---

## Post-Run Reporting (PRD Section 5.11)

**Reviewer interface:**
- R-01: Any remaining upper-case after all layers → incomplete match → Adjudicator
- R-02: No match → Administrator (system checks redundancy first)
- R-03: Layer-by-layer output shown so reviewer sees exactly where pipeline failed

**Administrator dashboard:**
- Greediness: match/replacement length ratio > 2.0x (configurable parameter, not hard-coded)
- Redundant regex: same upper-cased string matched by 2+ patterns
- No-match + competing pattern: broken vs redundant determination
- Match position (start/middle/end), context window, match rate trend
- Unmatched term frequency, concept type distribution, pattern age, pattern hit rate
- Substitution consistency across runs

---

## Key Rules — Read These Before Writing Any Code

**Reviewer independence**: enforced at the DATABASE QUERY LEVEL, not just UI or API.
No reviewer query may return another reviewer's responses for the same term.

**Auto-accept**: identical SNOMED CT FSN matches bypass reviewer queues entirely at Node 4.
Implement as a pre-allocation check. Auto-accepted terms are audited with a system flag,
visible to administrator as a distinct category, and never mixed into the adjudication rate.

**Batch accept**: allowed for manually mapped clusters. PROHIBITED for AI suggestions.
Enforce at the API layer — reject batch-accept requests where source = AI suggestion.

**Adjudication rate**: the primary quality diagnostic. Replaces all references to
discrepancy rate or inter-reviewer agreement/concordance. High adjudication rate signals
training gap or terminology difficulty — it is diagnostic, not a pass/fail measure.

**Audit log**: append-only. No UPDATE or DELETE on audit_log table ever.

**Holdout set**: locked after Node 4. Must not appear in reviewer assignment queries
until administrator triggers validation scoring.

**Corpus**: OmniMap is the system of record. External imports at Node 0 are read-only reference.
Never expose corpus data without authentication.

**Timestamps**: UTC always. No exceptions.

---

## Event-Driven Architecture
Each Lambda function is stateless. State lives in the database.
Node N completes → emits EventBridge event → SQS triggers Node N+1 Lambda.
Each Lambda reads inputs from DB, executes, emits completion event.

---

## Roles
| Role | Access |
|---|---|
| Administrator | Full management, dashboard, corpus admin |
| Reviewer | Own queue only. Cannot see other reviewers' data. |
| Adjudicator | Discrepancy queue. Not a reviewer on same project. |
| Auditor | Read-only. No writes. |

MFA required for Administrator and Adjudicator.

---

## Open Questions — Flag and Move On
1. Snowstorm hosting: internal OHN instance vs external API?
2. Embedding model for suggestion agent?
3. Certification expiry interval?

---

## Do Not Build Yet
- Direct EMR DB/FHIR connections (Phase 2)
- External pipeline REST API (Phase 2)
- Terminology version validation project type (Phase 2)
- Pareto frequency curve visualization (Phase 3)
- Multi-tenancy (Phase 4)

---

## Infrastructure Decisions Made

| Concern | Decision | Reason |
|---|---|---|
| Hosting | **EC2 `t3.small`** (not Lambda) | Express isn't Lambda-native; PostgreSQL connection limits break at Lambda concurrency; cold starts noticeable for clinical users; seed/migration scripts need persistent env |
| Dev database | **Supabase** | Fast setup; connection string `aws-1-us-east-1.pooler.supabase.com` |
| Prod database | Aurora Serverless v2 | As specified in PRD |
| Auth | AWS Cognito User Pool `ca-central-1_Mk1k0NG0s` | Configured March 2026 |
| Cognito App Client | `3tkq5r2i0p4rl8ac89a4nlrfc6` (public, no secret) | Browser-based Amplify requires public client |

---

## Implementation Status (March 2026)

### Completed
- **Phase A** — Migrations 001–004, TypeScript types, auth + RBAC middleware
- **Auth flow** — Login, forgot-password (2-step Cognito reset), new-password-required challenge on first login
- **Admin UI** — Projects page, Project detail, Users management (invite/list/edit/deactivate), Regex Library page
- **Favicon** — `frontend/public/icon.png` (Omni Health Nexus logo)
- **Seed data** — 399 qualifier patterns loaded (negation×77, stop_word×44, location×225, timing×14, family_history×18, causation×7, screening×14)
- **DAG Nodes 1–3** — Ingest, Deduplicate, Sample all working end-to-end

### Pending (next up)
- EC2 deployment (Nginx + PM2 + Certbot)
- Phase B: Nodes 0–5 (ingest through allocation) — Nodes 1–3 working; Node 4 holdout+automatch next
- Phase C: Reviewer workspace (Node 6 MAP)

---

## Migrations Status

| File | Applied to Supabase? |
|---|---|
| `001_initial_schema.sql` | ✅ Yes |
| `002_source_term_nlp.sql` | ✅ Yes |
| `003_qualifier_patterns.sql` | ✅ Yes |
| `004_screening.sql` | ✅ Yes |
| `004_screening_exclusion.sql` | No-op (superseded by 004_screening.sql) |
| `005_snomed_gap.sql` | ✅ Yes |

---

## Key Gotchas & Learnings

### AWS Cognito
- **App Client must have no secret** for browser-based Amplify. You cannot remove a secret from an existing client — create a new one. Public client = no secret.
- **Custom attribute casing is permanent.** Creating `custom:Role` (capital R) makes that the JWT claim name forever. You cannot rename or delete Cognito custom attributes.
- **Both `.env` files must use the same App Client ID.** The backend's `CognitoJwtVerifier` checks the `client_id` claim in every JWT against `COGNITO_CLIENT_ID`.
- **First login after `AdminCreateUser`** returns `CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED` from Amplify's `signIn`. Handle with `confirmSignIn({ challengeResponse: newPassword })` before calling `resolveUser`.
- **Amplify v6 `signIn` always returns `{ isSignedIn, nextStep }`** — never assume sign-in completes in one step. Check `nextStep.signInStep`.
- **`requireRole` is in `../middleware/rbac`**, not `../middleware/auth`.

### Environment Variables — Restart Rules
- **`ts-node-dev` does NOT re-read `.env`** on file save. Any `.env` change requires full backend process kill + restart.
- **Vite only reads `.env` at dev server start.** Restart Vite after any `.env` change.
- **Auth bypass security model:** `AUTH_BYPASS=true` in `backend/.env` is the real security gate. `VITE_AUTH_BYPASS=true` in `frontend/.env` only controls the UI redirect — the backend still enforces real JWTs regardless.

### Database
- **Filter dev sentinel from production queries:** `WHERE cognito_sub != 'dev-bypass-sub'`
- **Never edit existing migration files.** Add new numbered SQL files only.
- **`display_term_match`** and other NLP columns come from migration 002, not 001. If the column is missing, migration 002 hasn't been run yet.

### IAM vs App Client
- **`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`** are IAM credentials for admin Cognito API calls (`AdminCreateUser`, `AdminDisableUser`, etc.). Required in `backend/.env`. Not related to the App Client.
- On EC2 production: replace IAM key pair with an **IAM Instance Role** — no credentials needed in the environment at all.

---

## Git Branching Workflow

**All development happens on feature branches — never directly on `main`.**

### Branch naming
```
feature/<short-description>    # new features
fix/<short-description>        # bug fixes
chore/<short-description>      # tooling, deps, docs
```

### Workflow per task
1. `git checkout -b feature/<name>` from latest `main`
2. Implement and commit on the branch
3. Open a PR → review → merge to `main`
4. Delete the branch after merge

### Rules
- `main` is always deployable. Never push broken code to `main`.
- Claude Code works on the **current branch** — confirm branch before starting work if unclear.
- Migration files must be merged to `main` before applying them to Supabase/prod DB.
- `.env` files are never committed on any branch.

---

## Infoway FHIR Terminology Server

- **Base URL:** `https://terminologystandardsservice.ca/fhir`
- **Auth:** OAuth 2.0 client credentials (`INFOWAY_CLIENT_ID` + `INFOWAY_CLIENT_SECRET`)
- **Token URL:** `https://terminologystandardsservice.ca/authorisation/auth/realms/terminology/protocol/openid-connect/token`
- **Register:** https://infocentral.infoway-inforoute.ca/en/system-access-request-form
- **Client:** `backend/src/services/infowayFhir.ts` — token cached until near-expiry
- **Fallback:** If `INFOWAY_CLIENT_ID` is blank, search falls back to corpus (`canonical_mappings`). No errors thrown.
- Separate Dev/Prod credentials. Set in `backend/.env` per environment.
