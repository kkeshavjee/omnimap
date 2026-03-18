# OmniMap

Clinical terminology mapping platform by Omni Health Nexus Inc. (OHN).

Maps source EMR terms to target terminologies (SNOMED CT, LOINC, ATC, CCDD, ICD-10/11) using a dual-independent-review workflow with AI assistance.

## Quick Start

See `CLAUDE.md` for full build order and architecture.

## Tech Stack

- **Backend API**: Node.js + TypeScript (Express)
- **Frontend**: React + TypeScript (Vite)
- **AI Agents**: Python 3.11+
- **Database**: PostgreSQL (Aurora Serverless v2 on AWS)
- **Auth**: AWS Cognito (JWT + MFA)
- **Hosting**: AWS Lambda + API Gateway
- **Orchestration**: AWS EventBridge + SQS
- **CI/CD**: GitHub Actions

## Setup

```bash
cp .env.example .env
# Fill in .env values
```
