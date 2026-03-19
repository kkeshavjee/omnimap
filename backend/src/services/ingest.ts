// OmniMap — Node 1: INGEST
// Parses an uploaded EMR extract (CSV or Excel), validates required columns,
// bulk-inserts source_terms (status = 'raw'), updates the emr_extract record,
// advances project status → deduplicating, and emits INGEST_COMPLETE → Node 2.
//
// Required columns (case-insensitive, whitespace-tolerant):
//   source_code   | Source Code   | SourceCode
//   display_term  | Display Term  | DisplayTerm  | Term
//   frequency     | Frequency     | freq
//
// Optional columns:
//   clinical_domain | Clinical Domain
//   source_terminology_id

import { parse as parseCsv }   from 'csv-parse/sync';
import * as XLSX               from 'xlsx';
import { v4 as uuidv4 }        from 'uuid';
import { db }                  from './db';
import { emit }                from './events';
import { AuditAction }         from '../middleware/auditLog';
import { ProjectStatus }       from '../types/enums';

// -----------------------------------------------------------------
// Column name aliases (all lower-case for normalisation)
// -----------------------------------------------------------------

const ALIAS: Record<string, string> = {
  // source_code
  source_code:  'source_code',
  'source code': 'source_code',
  sourcecode:   'source_code',
  code:         'source_code',
  // display_term
  display_term: 'display_term',
  'display term': 'display_term',
  displayterm:  'display_term',
  term:         'display_term',
  description:  'display_term',
  // frequency
  frequency:    'frequency',
  freq:         'frequency',
  count:        'frequency',
  cnt:          'frequency',
  // optional
  clinical_domain:        'clinical_domain',
  'clinical domain':      'clinical_domain',
  clinicaldomain:         'clinical_domain',
  domain:                 'clinical_domain',
  source_terminology_id:  'source_terminology_id',
  'source terminology':   'source_terminology_id',
};

// -----------------------------------------------------------------
// Public types
// -----------------------------------------------------------------

export interface IngestInput {
  projectId:    string;
  extractId:    string;   // pre-created emr_extract record (status = 'processing')
  filename:     string;
  fileBuffer:   Buffer;
  uploadedBy:   string;   // users.id
}

export interface IngestResult {
  extractId:    string;
  totalRows:    number;
  skippedRows:  number;   // rows with missing required fields
}

// -----------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------

type RawRow = Record<string, string | number | null | undefined>;

function normaliseHeader(h: string): string {
  return h.trim().toLowerCase().replace(/\s+/g, ' ');
}

function parseBuffer(filename: string, buffer: Buffer): RawRow[] {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'csv' || ext === 'tsv') {
    const delimiter = ext === 'tsv' ? '\t' : ',';
    return parseCsv(buffer, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      delimiter,
    }) as RawRow[];
  }
  if (ext === 'xlsx' || ext === 'xls') {
    const wb  = XLSX.read(buffer, { type: 'buffer' });
    const ws  = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json<RawRow>(ws, { defval: null });
  }
  throw new Error(`Unsupported file format: .${ext} — expected .csv, .tsv, .xlsx, or .xls`);
}

function mapColumns(rows: RawRow[]): Array<{
  sourceCode:          string;
  displayTerm:         string;
  frequency:           number | null;
  clinicalDomain:      string | null;
  sourceTerminologyId: string | null;
}> {
  return rows.map(row => {
    const normalised: Record<string, string | number | null | undefined> = {};
    for (const [key, val] of Object.entries(row)) {
      const canonical = ALIAS[normaliseHeader(key)];
      if (canonical) normalised[canonical] = val;
    }

    const sourceCode  = String(normalised['source_code']  ?? '').trim();
    const displayTerm = String(normalised['display_term'] ?? '').trim();
    const freqRaw     = normalised['frequency'];
    const frequency   = freqRaw !== null && freqRaw !== undefined && freqRaw !== ''
      ? Math.round(Number(freqRaw))
      : null;

    return {
      sourceCode,
      displayTerm,
      frequency:           isNaN(frequency as number) ? null : frequency,
      clinicalDomain:      String(normalised['clinical_domain'] ?? '').trim() || null,
      sourceTerminologyId: String(normalised['source_terminology_id'] ?? '').trim() || null,
    };
  });
}

// -----------------------------------------------------------------
// Service
// -----------------------------------------------------------------

export async function ingestExtract(input: IngestInput): Promise<IngestResult> {
  const { projectId, extractId, filename, fileBuffer, uploadedBy } = input;

  // Parse file outside transaction — fail fast on bad format
  let rawRows: RawRow[];
  try {
    rawRows = parseBuffer(filename, fileBuffer);
  } catch (parseErr) {
    const client = await db.connect();
    try {
      await client.query(
        `UPDATE emr_extracts SET status = 'error', error_message = $1 WHERE id = $2`,
        [(parseErr as Error).message, extractId],
      );
    } finally {
      client.release();
    }
    throw parseErr;
  }

  const mappedRows = mapColumns(rawRows);
  let skippedRows  = 0;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Insert source terms — skip rows missing required fields
    let inserted = 0;
    for (const row of mappedRows) {
      if (!row.sourceCode || !row.displayTerm) {
        skippedRows++;
        continue;
      }
      await client.query(
        `INSERT INTO source_terms (
          id, extract_id, project_id,
          source_code, display_term, frequency,
          clinical_domain, source_terminology_id,
          is_out_of_place
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, FALSE)
        ON CONFLICT DO NOTHING`,
        [
          uuidv4(),
          extractId,
          projectId,
          row.sourceCode,
          row.displayTerm,
          row.frequency,
          row.clinicalDomain,
          row.sourceTerminologyId,
        ],
      );
      inserted++;
    }

    const totalRows = inserted;

    // Update emr_extract → ready
    await client.query(
      `UPDATE emr_extracts
       SET status = 'ready', total_rows = $1
       WHERE id = $2`,
      [totalRows, extractId],
    );

    // Advance project status: ingesting → deduplicating
    await client.query(
      `UPDATE projects
       SET status = 'deduplicating', current_dag_node = 'NODE_2_DEDUPLICATE', updated_at = now()
       WHERE id = $1`,
      [projectId],
    );

    // Audit log
    await client.query(
      `INSERT INTO audit_log
         (user_id, system_flag, action, entity_type, entity_id, project_id, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        uploadedBy,
        null,
        AuditAction.EXTRACT_PROCESSED,
        'emr_extract',
        extractId,
        projectId,
        JSON.stringify({ filename, totalRows, skippedRows }),
      ],
    );

    await client.query('COMMIT');

    // Emit event → Node 2 DEDUPLICATE
    await emit({
      source:     'omnimap',
      detailType: 'INGEST_COMPLETE',
      detail: {
        projectId,
        node:       'NODE_1_INGEST',
        nextNode:   'NODE_2_DEDUPLICATE',
        extractId,
        totalRows,
        skippedRows,
      },
    });

    return { extractId, totalRows, skippedRows };

  } catch (err) {
    await client.query('ROLLBACK');
    await client.query(
      `UPDATE emr_extracts SET status = 'error', error_message = $1 WHERE id = $2`,
      [(err as Error).message, extractId],
    );
    throw err;
  } finally {
    client.release();
  }
}
