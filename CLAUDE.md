# OmniMap — Claude Code Orientation

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
