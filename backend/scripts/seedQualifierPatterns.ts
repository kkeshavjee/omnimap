#!/usr/bin/env ts-node
// OmniMap — Seed script: Qualifier Pattern Library
//
// Reads all Excel files from backend/regex/ and inserts them into
// the qualifier_patterns table.  Safe to re-run: existing patterns
// for each source file are deactivated first, then the new ones are
// inserted, preserving the version history.
//
// Usage:
//   npx ts-node scripts/seedQualifierPatterns.ts
//   npx ts-node scripts/seedQualifierPatterns.ts --file "Negation Regex"
//
// Or call importQualifierFile() programmatically from the API route.

import * as path  from 'path';
import * as XLSX  from 'xlsx';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

import { db } from '../src/services/db';

// -----------------------------------------------------------------
// File → category mapping
// -----------------------------------------------------------------

type Category =
  | 'negation'
  | 'stop_word'
  | 'location'
  | 'timing'
  | 'family_history'
  | 'causation'
  | 'screening';

type Action = 'tag' | 'ignore' | 'detect' | 'screening';

// -----------------------------------------------------------------
// Derive action from the Prefix cell value
//
//   Prefix starts with '<'  → 'tag'      (apply XML markers + set flag)
//   Prefix === 'ignore'      → 'ignore'  (strip text, do NOT set flag;
//                              used for apparent negations that are
//                              actually disease names: NON-ALCOHOLIC,
//                              NOS, NYD, UNSPECIFIED)
//   Prefix === 'exclude'     → 'screening' (screening programme management
//   Prefix === 'screening'     note — not a diagnosis: Exclude FOBT,
//                              Abnormal Pap, Overdue mammogram, etc.)
//   Prefix empty / missing   → 'detect' (set qualifier flag, no XML output)
// -----------------------------------------------------------------

function deriveAction(prefix: string | null, defaultAction: Action = 'detect'): Action {
  if (!prefix || prefix.trim() === '') return defaultAction;
  const p = prefix.trim().toLowerCase();
  if (p === 'ignore')                        return 'ignore';
  if (p === 'exclude' || p === 'screening')  return 'screening';
  if (prefix.trim().startsWith('<'))         return 'tag';
  return defaultAction;
}

interface FileConfig {
  filename:  string;
  category:  Category;
  sheetName: string;
  // Column mappings (some files have different column names)
  colRegex:        string;
  colReplaceWith:  string;
  colPrefix?:      string;
  colSuffix?:      string;
  colLabel?:       string;    // human-readable label (Location = "Text", Screening = "TERM")
  defaultAction?:  Action;    // fallback when Prefix cell is empty; overrides 'detect'
                              // e.g. screening file has no Prefix column → default 'screening'
}

const FILE_CONFIGS: FileConfig[] = [
  {
    filename:       'Negation Regex.xlsx',
    category:       'negation',
    sheetName:      'Rule -out_Regex',
    colRegex:       'REGEX',
    colReplaceWith: 'REPLACE_WITH',
    colPrefix:      'Prefix',
    colSuffix:      'Suffix',
  },
  {
    filename:       'Stop Word Regex.xlsx',
    category:       'stop_word',
    sheetName:      'SNOMED_Stop_Regex',
    colRegex:       'REGEX',
    colReplaceWith: 'REPLACE_WITH',
  },
  {
    filename:       'Location Regex.xlsx',
    category:       'location',
    sheetName:      'Location_Regex',
    colRegex:       'REGEX',
    colReplaceWith: 'REPLACE_WITH',
    colPrefix:      'Prefix',
    colSuffix:      'Suffix',
    colLabel:       'Text',
  },
  {
    filename:       'Timing Regex.xlsx',
    category:       'timing',
    sheetName:      'Timing Regex',
    colRegex:       'REGEX',
    colReplaceWith: 'REPLACE_WITH',
    colPrefix:      'Prefix',
    colSuffix:      'Suffix',
  },
  {
    filename:       'Family History Regex.xlsx',
    category:       'family_history',
    sheetName:      'Family_History_Regex',
    colRegex:       'REGEX',
    colReplaceWith: 'REPLACE_WITH',
    colPrefix:      'Prefix',
    colSuffix:      'Suffix',
  },
  {
    filename:       'Causation Regex.xlsx',
    category:       'causation',
    sheetName:      'Causal_Regex',
    colRegex:       'REGEX',
    colReplaceWith: 'REPLACE_WITH',
    colPrefix:      'Prefix',
    colSuffix:      'Suffix',
    colLabel:       'TERM',
  },
  {
    // Screening programme management entries on the Problem List:
    // "Exclude FOBT", "Abnormal Pap", "Overdue mammogram", etc.
    // These are NOT diagnoses.  Prefix column is unused (all empty) so
    // defaultAction = 'screening' ensures every pattern gets the right action.
    filename:       'Screening Regex.xlsx',
    category:       'screening',
    sheetName:      'Sheet1',           // actual sheet name in the file
    colRegex:       'REGEX',
    colReplaceWith: 'REPLACE_WITH',
    colPrefix:      'Prefix',
    colSuffix:      'Suffix',
    colLabel:       'TERM',             // human-readable label column in this file
    defaultAction:  'screening',        // all rows are screening-management, not diagnoses
  },
];

// -----------------------------------------------------------------
// Parse one xlsx file into rows
// -----------------------------------------------------------------

interface PatternRow {
  patternText:    string;
  replaceWith:    string | null;
  prefix:         string | null;
  suffix:         string | null;
  canonicalLabel: string | null;
  action:         Action;
  sortOrder:      number;
  sourceFile:     string;
  sourceRow:      number;
}

function parseXlsx(regexDir: string, cfg: FileConfig): PatternRow[] {
  const filePath = path.join(regexDir, cfg.filename);

  // File missing — skip gracefully (not all xlsx files may exist yet)
  try {
    require('fs').accessSync(filePath);
  } catch {
    console.log(`  [SKIP] ${cfg.filename} — file not found in ${regexDir}`);
    return [];
  }

  const wb = XLSX.readFile(filePath);

  // Try the configured sheet name first; fall back to first sheet
  const actualSheet = wb.SheetNames.includes(cfg.sheetName)
    ? cfg.sheetName
    : wb.SheetNames[0];

  if (actualSheet !== cfg.sheetName) {
    console.warn(
      `  [WARN] ${cfg.filename}: sheet "${cfg.sheetName}" not found; ` +
      `using "${actualSheet}". Available: ${wb.SheetNames.join(', ')}`,
    );
  }

  const ws   = wb.Sheets[actualSheet];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: null });

  // Diagnostic: dump column names when the result would be 0 rows
  // (helps track down Family History and similar column-alignment issues)
  if (rows.length > 0) {
    const firstRowKeys = Object.keys(rows[0]);
    const hasRegexCol  = firstRowKeys.includes(cfg.colRegex);
    if (!hasRegexCol) {
      console.warn(
        `  [WARN] ${cfg.filename}: expected column "${cfg.colRegex}" not found.\n` +
        `         Available columns: ${firstRowKeys.join(', ')}\n` +
        `         Update FILE_CONFIGS.colRegex to match one of the above.`,
      );
      return [];
    }
  }

  const result: PatternRow[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row  = rows[i];
    const pat  = String(row[cfg.colRegex] ?? '').trim();
    const repl = row[cfg.colReplaceWith] != null ? String(row[cfg.colReplaceWith]).trim() : null;

    // Skip empty or header-echo rows
    if (!pat || pat === 'REGEX' || pat === cfg.colRegex) continue;

    // Validate the regex compiles
    try {
      new RegExp(pat, 'i');
    } catch {
      console.warn(`  [SKIP] invalid regex in ${cfg.filename} row ${i + 2}: ${pat}`);
      continue;
    }

    const prefix = cfg.colPrefix ? (String(row[cfg.colPrefix] ?? '').trim() || null) : null;

    result.push({
      patternText:    pat,
      replaceWith:    repl === '^' ? '^' : repl,   // preserve '^' sentinel
      prefix,
      suffix:         cfg.colSuffix  ? (String(row[cfg.colSuffix]  ?? '').trim() || null) : null,
      canonicalLabel: cfg.colLabel   ? (String(row[cfg.colLabel]   ?? '').trim() || null) : null,
      action:         deriveAction(prefix, cfg.defaultAction),
      sortOrder:      i,
      sourceFile:     cfg.filename,
      sourceRow:      i + 2,    // +2 = 1-based + header row
    });
  }

  return result;
}

// -----------------------------------------------------------------
// Import one file into the database
// -----------------------------------------------------------------

export async function importQualifierFile(
  regexDir: string,
  cfg: FileConfig,
): Promise<{ inserted: number; deactivated: number }> {
  const rows = parseXlsx(regexDir, cfg);
  if (rows.length === 0) {
    console.log(`  [SKIP] ${cfg.filename} — no parseable rows`);
    return { inserted: 0, deactivated: 0 };
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Deactivate all existing active patterns for this source file
    const { rowCount: deactivated } = await client.query(
      `UPDATE qualifier_patterns
       SET is_active = FALSE, updated_at = now()
       WHERE source_file = $1 AND is_active = TRUE`,
      [cfg.filename],
    );

    // Bulk insert new rows
    let inserted = 0;
    for (const row of rows) {
      await client.query(
        `INSERT INTO qualifier_patterns
           (category, pattern_text, replace_with, prefix, suffix,
            canonical_label, action, sort_order, source_file, source_row, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,TRUE)`,
        [
          cfg.category,
          row.patternText,
          row.replaceWith,
          row.prefix,
          row.suffix,
          row.canonicalLabel,
          row.action,
          row.sortOrder,
          row.sourceFile,
          row.sourceRow,
        ],
      );
      inserted++;
    }

    await client.query('COMMIT');
    console.log(`  ✓  ${cfg.filename}: ${inserted} inserted, ${deactivated ?? 0} deactivated`);
    return { inserted, deactivated: deactivated ?? 0 };

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// -----------------------------------------------------------------
// Seed all files
// -----------------------------------------------------------------

async function seedAll(regexDir: string, filterName?: string) {
  const configs = filterName
    ? FILE_CONFIGS.filter(c => c.filename.replace('.xlsx', '') === filterName)
    : FILE_CONFIGS;

  if (configs.length === 0) {
    console.error(`No matching file config for: ${filterName}`);
    process.exit(1);
  }

  console.log(`\nSeeding qualifier patterns from: ${regexDir}`);
  console.log(`Files to process: ${configs.map(c => c.filename).join(', ')}\n`);

  let totalInserted   = 0;
  let totalDeactivated = 0;

  for (const cfg of configs) {
    try {
      const { inserted, deactivated } = await importQualifierFile(regexDir, cfg);
      totalInserted    += inserted;
      totalDeactivated += deactivated;
    } catch (err) {
      console.error(`  ✗  ${cfg.filename}: ${(err as Error).message}`);
    }
  }

  console.log(`\nDone. Total inserted: ${totalInserted}, deactivated: ${totalDeactivated}`);
}

// -----------------------------------------------------------------
// CLI entry point
// -----------------------------------------------------------------

if (require.main === module) {
  const regexDir  = path.join(__dirname, '..', 'regex');
  const fileArg   = process.argv.find(a => a.startsWith('--file='))?.replace('--file=', '');

  seedAll(regexDir, fileArg)
    .then(() => process.exit(0))
    .catch(err => { console.error(err); process.exit(1); });
}
