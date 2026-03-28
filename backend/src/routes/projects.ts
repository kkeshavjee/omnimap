// OmniMap — Projects Router
// Handles project lifecycle endpoints: create, ingest, deduplicate, sample,
// holdout draw, and allocation. Each endpoint corresponds to a DAG node.

import { Router, Request, Response, NextFunction } from 'express';
import multer                                        from 'multer';
import { v4 as uuidv4 }                             from 'uuid';
import { db }                                        from '../services/db';
import { initProject }                               from '../services/projectInit';
import { ingestExtract }                             from '../services/ingest';
import { deduplicateTerms }                          from '../services/deduplicate';
import { sampleTerms }                               from '../services/sample';
import { holdoutDrawAndAutomatch }                   from '../services/holdout';
import { allocateTerms_service }                     from '../services/allocate';
import { canonicaliseTerms }                         from '../services/canonicalise';
import { requireRole }                               from '../middleware/rbac';
import { UserRole, ProjectType, SamplingStrategy }  from '../types/enums';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// -----------------------------------------------------------------
// POST /projects  — Node 0: create project
// -----------------------------------------------------------------
router.post(
  '/',
  requireRole(UserRole.Administrator),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await initProject({
        name:                     req.body.name,
        description:              req.body.description,
        projectType:              req.body.projectType as ProjectType,
        sourceTerminologyId:      req.body.sourceTerminologyId,
        targetTerminologyId:      req.body.targetTerminologyId,
        powerF1Threshold:         req.body.powerF1Threshold,
        powerAlpha:               req.body.powerAlpha,
        powerBeta:                req.body.powerBeta,
        greedinesRatioThreshold:  req.body.greedinesRatioThreshold,
        nearDuplicateEditDistance: req.body.nearDuplicateEditDistance,
        externalMappings:         req.body.externalMappings,
        createdBy:                req.user!.id,
      });
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  },
);

// -----------------------------------------------------------------
// GET /projects  — list projects (admin/auditor/reviewer/adjudicator)
// -----------------------------------------------------------------
router.get(
  '/',
  requireRole(UserRole.Administrator, UserRole.Auditor, UserRole.Reviewer, UserRole.Adjudicator),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const { rows } = await db.query(
        `SELECT
           id, name, description,
           project_type              AS "projectType",
           target_terminology_id     AS "targetTerminologyId",
           status,
           current_dag_node          AS "currentDagNode",
           sample_locked_at          AS "sampleLockedAt",
           holdout_locked_at         AS "holdoutLockedAt",
           computed_holdout_n        AS "computedHoldoutN",
           created_by                AS "createdBy",
           created_at                AS "createdAt",
           updated_at                AS "updatedAt"
         FROM projects
         ORDER BY created_at DESC`,
      );
      res.json(rows);
    } catch (err) {
      next(err);
    }
  },
);

// -----------------------------------------------------------------
// GET /projects/:id
// -----------------------------------------------------------------
router.get(
  '/:id',
  requireRole(UserRole.Administrator, UserRole.Auditor, UserRole.Reviewer, UserRole.Adjudicator),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { rows } = await db.query(
        `SELECT
           id, name, description,
           project_type              AS "projectType",
           source_terminology_id     AS "sourceTerminologyId",
           target_terminology_id     AS "targetTerminologyId",
           status, current_dag_node  AS "currentDagNode",
           power_f1_threshold        AS "powerF1Threshold",
           power_alpha               AS "powerAlpha",
           power_beta                AS "powerBeta",
           computed_holdout_n        AS "computedHoldoutN",
           greediness_ratio_threshold  AS "greedinesRatioThreshold",
           near_duplicate_edit_distance AS "nearDuplicateEditDistance",
           sample_locked_at          AS "sampleLockedAt",
           holdout_locked_at         AS "holdoutLockedAt",
           target_terminology_locked_at AS "targetTerminologyLockedAt",
           prior_terminology_version AS "priorTerminologyVersion",
           new_terminology_version   AS "newTerminologyVersion",
           created_by                AS "createdBy",
           created_at                AS "createdAt",
           updated_at                AS "updatedAt"
         FROM projects WHERE id = $1`,
        [req.params.id],
      );
      if (rows.length === 0) return res.status(404).json({ error: 'Project not found' });
      res.json(rows[0]);
    } catch (err) {
      next(err);
    }
  },
);

// -----------------------------------------------------------------
// POST /projects/:id/ingest  — Node 1: upload + parse extract
// -----------------------------------------------------------------
router.post(
  '/:id/ingest',
  requireRole(UserRole.Administrator),
  upload.single('file'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

      const projectId = req.params.id;

      // Create emr_extract record (status = 'processing')
      const extractId = uuidv4();
      await db.query(
        `INSERT INTO emr_extracts (id, project_id, filename, status, uploaded_by)
         VALUES ($1, $2, $3, 'processing', $4)`,
        [extractId, projectId, req.file.originalname, req.user!.id],
      );

      const result = await ingestExtract({
        projectId,
        extractId,
        filename:   req.file.originalname,
        fileBuffer: req.file.buffer,
        uploadedBy: req.user!.id,
      });

      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  },
);

// -----------------------------------------------------------------
// POST /projects/:id/deduplicate  — Node 2
// -----------------------------------------------------------------
router.post(
  '/:id/deduplicate',
  requireRole(UserRole.Administrator),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Resolve current extract for this project
      const { rows } = await db.query(
        `SELECT id FROM emr_extracts WHERE project_id = $1 AND status = 'ready'
         ORDER BY uploaded_at DESC LIMIT 1`,
        [req.params.id],
      );
      if (rows.length === 0) {
        return res.status(400).json({ error: 'No ready extract found for this project' });
      }
      const result = await deduplicateTerms({
        projectId:   req.params.id,
        extractId:   rows[0].id,
        triggeredBy: req.user!.id,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// -----------------------------------------------------------------
// POST /projects/:id/sample  — Node 3
// Body: { configId, strategy, paretoThreshold?, randomN? }
// Creates sample_config if not provided, then runs sampling.
// -----------------------------------------------------------------
router.post(
  '/:id/sample',
  requireRole(UserRole.Administrator),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = req.params.id;
      let { configId } = req.body;

      // Create config if not supplied
      if (!configId) {
        const { strategy, paretoThreshold, randomN } = req.body;
        const { rows } = await db.query(
          `INSERT INTO sample_configs
             (id, project_id, strategy, pareto_threshold, random_n, is_locked, created_by)
           VALUES ($1, $2, $3, $4, $5, FALSE, $6)
           RETURNING id`,
          [
            uuidv4(), projectId,
            strategy ?? SamplingStrategy.Pareto,
            paretoThreshold ?? null,
            randomN ?? null,
            req.user!.id,
          ],
        );
        configId = rows[0].id;
      }

      const result = await sampleTerms({ projectId, configId, triggeredBy: req.user!.id });
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// -----------------------------------------------------------------
// POST /projects/:id/holdout  — Node 4: holdout draw + automatch
// -----------------------------------------------------------------
router.post(
  '/:id/holdout',
  requireRole(UserRole.Administrator),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await holdoutDrawAndAutomatch({
        projectId:   req.params.id,
        triggeredBy: req.user!.id,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// -----------------------------------------------------------------
// POST /projects/:id/allocate  — Node 5
// -----------------------------------------------------------------
router.post(
  '/:id/allocate',
  requireRole(UserRole.Administrator),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await allocateTerms_service({
        projectId:   req.params.id,
        triggeredBy: req.user!.id,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// -----------------------------------------------------------------
// POST /projects/:id/canonicalise  — Node 8
// -----------------------------------------------------------------
router.post(
  '/:id/canonicalise',
  requireRole(UserRole.Administrator),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await canonicaliseTerms({
        projectId:   req.params.id,
        triggeredBy: req.user!.id,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// -----------------------------------------------------------------
// GET /projects/:id/export  — Node 13
// Returns all canonical_mappings as JSON (inline) and records the export.
// Query param: format=json (default) | csv
// -----------------------------------------------------------------
router.get(
  '/:id/export',
  requireRole(UserRole.Administrator, UserRole.Auditor),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = req.params.id;
      const format    = (req.query.format as string) ?? 'json';

      const { rows } = await db.query(
        `SELECT
           st.source_code           AS "sourceCode",
           st.display_term          AS "displayTerm",
           st.frequency,
           cm.target_code           AS "targetCode",
           cm.target_display_lower  AS "targetDisplay",
           cm.relationship_type     AS "relationshipType",
           cm.is_auto_matched       AS "isAutoMatched",
           cm.auto_match_basis      AS "autoMatchBasis",
           cm.created_at            AS "canonicalisedAt"
         FROM canonical_mappings cm
         JOIN project_terms  pt ON pt.id = cm.project_term_id
         JOIN source_terms   st ON st.id = cm.source_term_id
         WHERE cm.project_id  = $1
           AND cm.is_current  = TRUE
         ORDER BY st.frequency DESC NULLS LAST, st.display_term`,
        [projectId],
      );

      // Record the export (no S3 — inline response)
      await db.query(
        `INSERT INTO exports (id, project_id, format, exported_by, includes_superseded)
         VALUES ($1, $2, $3::export_format, $4, FALSE)`,
        [uuidv4(), projectId, format === 'csv' ? 'csv' : 'json', req.user!.id],
      );

      if (format === 'csv') {
        const headers = ['sourceCode','displayTerm','frequency','targetCode','targetDisplay','relationshipType','isAutoMatched','canonicalisedAt'];
        const lines   = [headers.join(',')];
        for (const r of rows) {
          lines.push(headers.map(h => {
            const v = r[h as keyof typeof r];
            return v == null ? '' : `"${String(v).replace(/"/g, '""')}"`;
          }).join(','));
        }
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="omnimap-export-${projectId}.csv"`);
        return res.send(lines.join('\n'));
      }

      res.json({ projectId, exportedAt: new Date().toISOString(), rows });
    } catch (err) {
      next(err);
    }
  },
);

// -----------------------------------------------------------------
// GET /projects/:id/gap-report  — SNOMED Gap Report (FR-114)
// Returns all canonical_mappings flagged as SNOMED gaps.
// Query param: format=json (default) | csv
// -----------------------------------------------------------------
router.get(
  '/:id/gap-report',
  requireRole(UserRole.Administrator, UserRole.Auditor),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = req.params.id;
      const format    = (req.query.format as string) ?? 'json';

      const { rows } = await db.query(
        `SELECT
           st.source_code           AS "sourceCode",
           st.display_term          AS "displayTerm",
           st.frequency,
           st.clinical_domain       AS "clinicalDomain",
           cm.gap_reason_code       AS "gapReasonCode",
           cm.created_at            AS "confirmedDate"
         FROM canonical_mappings cm
         JOIN project_terms  pt ON pt.id = cm.project_term_id
         JOIN source_terms   st ON st.id = cm.source_term_id
         WHERE cm.project_id   = $1
           AND cm.is_snomed_gap = TRUE
           AND cm.is_current    = TRUE
         ORDER BY st.frequency DESC NULLS LAST, st.display_term`,
        [projectId],
      );

      if (format === 'csv') {
        const headers = ['sourceCode','displayTerm','frequency','clinicalDomain','gapReasonCode','confirmedDate'];
        const lines   = [headers.join(',')];
        for (const r of rows) {
          lines.push(headers.map(h => {
            const v = r[h as keyof typeof r];
            return v == null ? '' : `"${String(v).replace(/"/g, '""')}"`;
          }).join(','));
        }
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="omnimap-gap-report-${projectId}.csv"`);
        return res.send(lines.join('\n'));
      }

      res.json({ projectId, exportedAt: new Date().toISOString(), total: rows.length, rows });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
