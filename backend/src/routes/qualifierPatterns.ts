// OmniMap — Qualifier Pattern Library REST API
//
// OmniMap is the AUTHORITATIVE store for all qualifier regex patterns.
// Excel files are import-only; patterns are managed here after initial seed.
//
// Endpoints:
//   GET    /api/qualifier-patterns               list (optionally filtered by category)
//   POST   /api/qualifier-patterns               create one pattern
//   PUT    /api/qualifier-patterns/:id           update one pattern
//   DELETE /api/qualifier-patterns/:id           soft-delete (is_active = false)
//   POST   /api/qualifier-patterns/import        upload xlsx → re-import one category
//   GET    /api/qualifier-patterns/export        download all (or one category) as xlsx

import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import * as path from 'path';
import * as XLSX from 'xlsx';
import { db } from '../services/db';
import { requireRole } from '../middleware/rbac';
import { UserRole } from '../types/enums';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

// Only administrators manage the regex library
const adminOnly = requireRole(UserRole.Administrator);

// multer — memory storage (xlsx files are small)
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 },  // 10 MB
  fileFilter: (_req, file, cb) => {
    const ok = file.originalname.endsWith('.xlsx') ||
               file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    cb(null, ok);
  },
});

// -----------------------------------------------------------------
// Valid categories (must match DB enum)
// -----------------------------------------------------------------

const VALID_CATEGORIES = [
  'negation', 'stop_word', 'location', 'timing',
  'family_history', 'causation', 'screening',
] as const;

type Category = typeof VALID_CATEGORIES[number];

function isValidCategory(v: unknown): v is Category {
  return VALID_CATEGORIES.includes(v as Category);
}

// -----------------------------------------------------------------
// GET /api/qualifier-patterns
// Query: ?category=negation&includeInactive=true
// -----------------------------------------------------------------

router.get('/', adminOnly, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { category, includeInactive } = req.query;

    const conditions: string[] = [];
    const params: unknown[]    = [];

    if (category) {
      if (!isValidCategory(category)) {
        res.status(400).json({ error: `Invalid category: ${category}` });
        return;
      }
      params.push(category);
      conditions.push(`category = $${params.length}`);
    }

    if (includeInactive !== 'true') {
      conditions.push('is_active = TRUE');
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows } = await db.query(
      `SELECT
         id, category, pattern_text AS "patternText", flags,
         replace_with AS "replaceWith", prefix, suffix,
         canonical_label AS "canonicalLabel", action,
         sort_order AS "sortOrder",
         source_file AS "sourceFile", source_row AS "sourceRow",
         is_active AS "isActive", version,
         created_at AS "createdAt", updated_at AS "updatedAt"
       FROM qualifier_patterns
       ${where}
       ORDER BY category, sort_order, id`,
      params,
    );

    res.json(rows);
  } catch (err) { next(err); }
});

// -----------------------------------------------------------------
// POST /api/qualifier-patterns
// Body: { category, patternText, flags?, replaceWith?, prefix?,
//         suffix?, canonicalLabel?, action?, sortOrder? }
// -----------------------------------------------------------------

router.post('/', adminOnly, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      category, patternText, flags = 'i',
      replaceWith, prefix, suffix,
      canonicalLabel, action = 'tag', sortOrder = 1000,
    } = req.body as Record<string, unknown>;

    if (!isValidCategory(category)) {
      res.status(400).json({ error: 'Missing or invalid category' });
      return;
    }
    if (typeof patternText !== 'string' || !patternText.trim()) {
      res.status(400).json({ error: 'patternText is required' });
      return;
    }

    // Validate the regex
    try { new RegExp(patternText as string, flags as string); }
    catch { res.status(400).json({ error: 'patternText is not a valid regular expression' }); return; }

    const id = uuidv4();
    await db.query(
      `INSERT INTO qualifier_patterns
         (id, category, pattern_text, flags, replace_with, prefix, suffix,
          canonical_label, action, sort_order, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,TRUE)`,
      [id, category, patternText, flags, replaceWith ?? null, prefix ?? null,
       suffix ?? null, canonicalLabel ?? null, action, sortOrder],
    );

    const { rows } = await db.query(
      `SELECT id, category, pattern_text AS "patternText", flags,
              replace_with AS "replaceWith", prefix, suffix,
              canonical_label AS "canonicalLabel", action,
              sort_order AS "sortOrder", is_active AS "isActive",
              version, created_at AS "createdAt", updated_at AS "updatedAt"
       FROM qualifier_patterns WHERE id = $1`,
      [id],
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// -----------------------------------------------------------------
// PUT /api/qualifier-patterns/:id
// Partial update — only supplied fields are changed
// -----------------------------------------------------------------

router.put('/:id', adminOnly, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const allowed = ['patternText', 'flags', 'replaceWith', 'prefix', 'suffix',
                     'canonicalLabel', 'action', 'sortOrder', 'isActive'] as const;

    const colMap: Record<string, string> = {
      patternText:    'pattern_text',
      flags:          'flags',
      replaceWith:    'replace_with',
      prefix:         'prefix',
      suffix:         'suffix',
      canonicalLabel: 'canonical_label',
      action:         'action',
      sortOrder:      'sort_order',
      isActive:       'is_active',
    };

    const setClauses: string[] = [];
    const params: unknown[]    = [];

    for (const key of allowed) {
      if (key in req.body) {
        if (key === 'patternText') {
          const f = req.body.flags ?? 'i';
          try { new RegExp(req.body[key] as string, f); }
          catch { res.status(400).json({ error: 'patternText is not a valid regular expression' }); return; }
        }
        params.push(req.body[key]);
        setClauses.push(`${colMap[key]} = $${params.length}`);
      }
    }

    if (setClauses.length === 0) {
      res.status(400).json({ error: 'No updatable fields supplied' });
      return;
    }

    params.push(id);
    const { rowCount } = await db.query(
      `UPDATE qualifier_patterns SET ${setClauses.join(', ')} WHERE id = $${params.length}`,
      params,
    );
    if (!rowCount) { res.status(404).json({ error: 'Pattern not found' }); return; }

    const { rows } = await db.query(
      `SELECT id, category, pattern_text AS "patternText", flags,
              replace_with AS "replaceWith", prefix, suffix,
              canonical_label AS "canonicalLabel", action,
              sort_order AS "sortOrder", is_active AS "isActive",
              version, created_at AS "createdAt", updated_at AS "updatedAt"
       FROM qualifier_patterns WHERE id = $1`,
      [id],
    );
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// -----------------------------------------------------------------
// DELETE /api/qualifier-patterns/:id  — soft-delete
// -----------------------------------------------------------------

router.delete('/:id', adminOnly, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { rowCount } = await db.query(
      `UPDATE qualifier_patterns
       SET is_active = FALSE
       WHERE id = $1 AND is_active = TRUE`,
      [id],
    );
    if (!rowCount) {
      res.status(404).json({ error: 'Pattern not found or already inactive' });
      return;
    }
    res.json({ id, isActive: false });
  } catch (err) { next(err); }
});

// -----------------------------------------------------------------
// POST /api/qualifier-patterns/import
// Multipart: file (xlsx) + body.category
//
// Re-imports one category file: deactivates existing patterns for
// that source filename, then bulk-inserts the new rows.
// -----------------------------------------------------------------

router.post(
  '/import',
  adminOnly,
  upload.single('file'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file) { res.status(400).json({ error: 'No xlsx file uploaded' }); return; }

      const { category } = req.body as { category?: string };
      if (!isValidCategory(category)) {
        res.status(400).json({ error: 'Missing or invalid category' });
        return;
      }

      const sourceFile = req.file.originalname;

      // Parse the xlsx from memory buffer
      const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: null });

      // Detect column names
      const firstRowKeys = rawRows.length ? Object.keys(rawRows[0]) : [];
      const colRegex = firstRowKeys.find(k => k.toUpperCase() === 'REGEX') ?? 'REGEX';

      const parsed: Array<{
        patternText: string; replaceWith: string | null;
        prefix: string | null; suffix: string | null;
        canonicalLabel: string | null; action: string;
        sortOrder: number;
      }> = [];

      for (let i = 0; i < rawRows.length; i++) {
        const row = rawRows[i];
        const pat = String(row[colRegex] ?? '').trim();
        if (!pat || pat.toUpperCase() === 'REGEX') continue;
        try { new RegExp(pat, 'i'); } catch { continue; }

        const colReplaceWith = firstRowKeys.find(k => k.toUpperCase() === 'REPLACE_WITH') ?? 'REPLACE_WITH';
        const colPrefix      = firstRowKeys.find(k => k.toLowerCase() === 'prefix');
        const colSuffix      = firstRowKeys.find(k => k.toLowerCase() === 'suffix');
        const colLabel       = firstRowKeys.find(k => ['text', 'term'].includes(k.toLowerCase()));

        const repl   = row[colReplaceWith] != null ? String(row[colReplaceWith]).trim() : null;
        const prefix = colPrefix ? (String(row[colPrefix] ?? '').trim() || null) : null;

        // Derive action from prefix.
        // When Prefix is empty, fall back to the category default:
        //   'screening' category → every pattern is 'screening' action
        //   all others           → 'detect'
        const categoryDefault: string = category === 'screening' ? 'screening' : 'detect';
        let action: string = categoryDefault;
        if (prefix) {
          const p = prefix.toLowerCase();
          if (p === 'ignore')                            action = 'ignore';
          else if (p === 'exclude' || p === 'screening') action = 'screening';
          else if (prefix.startsWith('<'))               action = 'tag';
        }

        parsed.push({
          patternText:    pat,
          replaceWith:    repl,
          prefix,
          suffix:         colSuffix ? (String(row[colSuffix] ?? '').trim() || null) : null,
          canonicalLabel: colLabel  ? (String(row[colLabel]  ?? '').trim() || null) : null,
          action,
          sortOrder:      i,
        });
      }

      if (parsed.length === 0) {
        res.status(422).json({
          error: 'No valid patterns found in uploaded file',
          hint:  `Detected columns: ${firstRowKeys.join(', ')}`,
        });
        return;
      }

      const client = await db.connect();
      try {
        await client.query('BEGIN');

        const { rowCount: deactivated } = await client.query(
          `UPDATE qualifier_patterns
           SET is_active = FALSE, updated_at = now()
           WHERE source_file = $1 AND is_active = TRUE`,
          [sourceFile],
        );

        let inserted = 0;
        for (const row of parsed) {
          await client.query(
            `INSERT INTO qualifier_patterns
               (category, pattern_text, replace_with, prefix, suffix,
                canonical_label, action, sort_order, source_file, is_active)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE)`,
            [category, row.patternText, row.replaceWith, row.prefix, row.suffix,
             row.canonicalLabel, row.action, row.sortOrder, sourceFile],
          );
          inserted++;
        }

        await client.query('COMMIT');
        res.json({ inserted, deactivated: deactivated ?? 0, sourceFile });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) { next(err); }
  },
);

// -----------------------------------------------------------------
// GET /api/qualifier-patterns/export
// Query: ?category=negation  (omit for all)
// Returns: xlsx file download
// -----------------------------------------------------------------

router.get('/export', adminOnly, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { category } = req.query;

    const conditions = ['is_active = TRUE'];
    const params: unknown[] = [];
    if (category) {
      if (!isValidCategory(category)) {
        res.status(400).json({ error: `Invalid category: ${category}` });
        return;
      }
      params.push(category);
      conditions.push(`category = $${params.length}`);
    }

    const { rows } = await db.query(
      `SELECT
         category, pattern_text, flags, replace_with,
         prefix, suffix, canonical_label, action,
         sort_order, source_file, source_row,
         version, created_at
       FROM qualifier_patterns
       WHERE ${conditions.join(' AND ')}
       ORDER BY category, sort_order, id`,
      params,
    );

    // Build xlsx workbook — one sheet per category
    const wb = XLSX.utils.book_new();

    // Group rows by category
    const grouped = new Map<string, typeof rows>();
    for (const row of rows) {
      if (!grouped.has(row.category)) grouped.set(row.category, []);
      grouped.get(row.category)!.push(row);
    }

    for (const [cat, catRows] of grouped) {
      const sheetData = catRows.map(r => ({
        REGEX:           r.pattern_text,
        FLAGS:           r.flags,
        REPLACE_WITH:    r.replace_with ?? '',
        Prefix:          r.prefix ?? '',
        Suffix:          r.suffix ?? '',
        Text:            r.canonical_label ?? '',
        Action:          r.action,
        sort_order:      r.sort_order,
        source_file:     r.source_file ?? '',
        source_row:      r.source_row ?? '',
        version:         r.version,
        created_at:      r.created_at,
      }));
      const ws = XLSX.utils.json_to_sheet(sheetData);
      XLSX.utils.book_append_sheet(wb, ws, cat.substring(0, 31)); // xlsx sheet names max 31 chars
    }

    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const filename = category ? `${category}_patterns.xlsx` : 'all_qualifier_patterns.xlsx';

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err) { next(err); }
});

export default router;
