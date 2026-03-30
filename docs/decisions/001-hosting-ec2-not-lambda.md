# ADR-001 — Hosting: EC2 over Lambda for the Express backend

**Date:** 2026-03-19
**Status:** Accepted
**Deciders:** Karim Keshavjee

---

## Context

OmniMap's backend is an Express.js application that connects to PostgreSQL, runs
migration and seed scripts, and serves clinical users who notice cold-start latency.
Two hosting options were evaluated: AWS Lambda + API Gateway, and EC2.

## Decision

Host on **EC2 t3.small** behind Nginx (reverse proxy + TLS) managed by PM2.

## Rationale

Express is not a purpose-built Lambda handler. Running it on Lambda requires a
wrapper (e.g. `serverless-http`) that adds complexity without benefit for this workload.

## Alternatives considered

| Option | Why rejected |
|---|---|
| AWS Lambda + API Gateway | Cold-start latency noticeable to clinical users; PostgreSQL connection limits break at Lambda concurrency; seed/migration scripts require persistent filesystem access |
| Fargate / ECS | More operational complexity than warranted for a single-service app at this scale |

## Consequences

- Simpler deployment model (PM2 + Nginx)
- Must manage server patching and uptime
- No auto-scaling beyond vertical resize; acceptable for Phase 1 load
- Production setup: EC2 t3.small, Aurora Serverless v2 (replaces Supabase dev DB), Nginx + Certbot TLS

## References

- Global CLAUDE.md: EC2 vs Lambda Decision Rule
