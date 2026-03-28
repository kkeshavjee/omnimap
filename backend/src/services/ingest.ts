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
import { annotate }            from './clinicalNlp';

// -----------------------------------------------------------------
// Column name aliases (all lower-case for normalisation)
// -----------------------------------------------------------------

const ALIAS: Record<string, string> = {
  // source_code
  source_code:        'source_code',
  'source code':      'source_code',
  sourcecode:         'source_code',
  code:               'source_code',
  'local code':       'source_code',
  local_code:         'source_code',
  'concept code':     'source_code',
  concept_code:       'source_code',
  'concept id':       'source_code',
  concept_id:         'source_code',
  id:                 'source_code',
  no:                 'source_code',
  'no.':              'source_code',
  num:                'source_code',
  number:             'source_code',
  '#':                'source_code',
  row:                'source_code',
  'original text':    'display_term',
  original_text:      'display_term',
  'original term':    'display_term',
  original_term:      'display_term',
  text:               'display_term',
  'raw text':         'display_term',
  raw_text:           'display_term',
  'snomed code':      'source_code',
  'snomed id':        'source_code',
  'loinc code':       'source_code',
  // display_term
  display_term:       'display_term',
  'display term':     'display_term',
  displayterm:        'display_term',
  term:               'display_term',
  description:        'display_term',
  diagnosis:          'display_term',
  'diagnosis text':   'display_term',
  procedure:          'display_term',
  'procedure text':   'display_term',
  finding:            'display_term',
  label:              'display_term',
  name:               'display_term',
  'preferred term':   'display_term',
  preferred_term:     'display_term',
  'fully specified name': 'display_term',
  fsn:                'display_term',
  'concept name':     'display_term',
  concept_name:       'display_term',
  'display name':     'display_term',
  display_name:       'display_term',
  // frequency
  frequency:          'frequency',
  freq:               'frequency',
  count:              'frequency',
  cnt:                'frequency',
  usage:              'frequency',
  occurrences:        'frequency',
  encounters:         'frequency',
  patients:           'frequency',
  'patient count':    'frequency',
  patient_count:      'frequency',
  'record count':     'frequency',
  record_count:       'frequency',
  total:              'frequency',
  n:                  'frequency',
  // optional
  clinical_domain:        'clinical_domain',
  'clinical domain':      'clinical_domain',
  clinicaldomain:         'clinical_domain',
  domain:                 'clinical_domain',
  specialty:              'clinical_domain',
  department:             'clinical_domain',
  category:               'clinical_domain',
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
  extractId:       string;
  totalRows:       number;
  skippedRows:     number;    // rows with missing required fields
  detectedColumns: string[];  // actual column headers found in the file
  mappedColumns:   string[];  // which headers were successfully mapped
}

// -----------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------

type RawRow = Record<string, string | number | null | undefined>;

function normaliseHeader(h: string): string {
  return h.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Normalise a raw cell value from an EMR extract before storage.
 * Applied to source_code and display_term.
 * Preserves original case; strips non-printable characters and
 * normalises whitespace. NFC unicode normalisation ensures that
 * composed and decomposed forms (e.g. é vs é) are treated consistently.
 */
function normaliseCell(raw: string): string {
  return raw
    .normalize('NFC')
    .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\uFEFF]/g, ' ')  // Unicode spaces → ASCII
    .replace(/[\u00AD\u200B-\u200D\u2060]/g, '')                             // zero-width / soft-hyphen
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')                            // control characters
    .replace(/\s+/g, ' ')
    .trim();
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

    const sourceCode  = normaliseCell(String(normalised['source_code']  ?? ''));
    const displayTerm = normaliseCell(String(normalised['display_term'] ?? ''));
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

  // Detect actual headers for diagnostics
  const detectedColumns = rawRows.length > 0 ? Object.keys(rawRows[0]) : [];
  const mappedColumns   = detectedColumns
    .map(h => normaliseHeader(h))
    .filter(h => !!ALIAS[h])
    .map(h => ALIAS[h]);

  const mappedRows = mapColumns(rawRows);
  let skippedRows  = 0;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Build arrays for bulk unnest insert
    const ids:                  string[]        = [];
    const sourceCodes:          string[]        = [];
    const displayTerms:         string[]        = [];
    const displayTermMatches:   string[]        = [];   // NLP match form
    const frequencies:          (number|null)[] = [];
    const clinicalDomains:      (string|null)[] = [];
    const sourceTerminologyIds: (string|null)[] = [];
    const isNegatedArr:         boolean[]       = [];
    const lateralityArr:        (string|null)[] = [];
    const severityArr:          (string|null)[] = [];
    const acuityArr:            (string|null)[] = [];
    const certaintyArr:         (string|null)[] = [];

    for (const row of mappedRows) {
      if (!row.sourceCode || !row.displayTerm) {
        skippedRows++;
        continue;
      }

      // Run clinical NLP annotation (O(1) per term — pure regex, no DB)
      const nlp = annotate(row.displayTerm);

      ids.push(uuidv4());
      sourceCodes.push(row.sourceCode);
      displayTerms.push(row.displayTerm);
      displayTermMatches.push(nlp.displayTermMatch);
      frequencies.push(row.frequency);
      clinicalDomains.push(row.clinicalDomain);
      sourceTerminologyIds.push(row.sourceTerminologyId);
      isNegatedArr.push(nlp.isNegated);
      lateralityArr.push(nlp.laterality);
      severityArr.push(nlp.qualifierSeverity);
      acuityArr.push(nlp.qualifierAcuity);
      certaintyArr.push(nlp.qualifierCertainty);
    }

    if (ids.length > 0) {
      await client.query(
        `INSERT INTO source_terms (
           id, extract_id, project_id,
           source_code, display_term, display_term_match, frequency,
           clinical_domain, source_terminology_id,
           is_out_of_place,
           is_negated, laterality,
           qualifier_severity, qualifier_acuity, qualifier_certainty
         )
         SELECT
           unnest($1::uuid[]),
           $2::uuid,
           $3::uuid,
           unnest($4::text[]),
           unnest($5::text[]),
           unnest($6::text[]),
           unnest($7::int[]),
           unnest($8::text[]),
           unnest($9::uuid[]),
           FALSE,
           unnest($10::boolean[]),
           unnest($11::text[]),
           unnest($12::text[]),
           unnest($13::text[]),
           unnest($14::text[])
         ON CONFLICT DO NOTHING`,
        [
          ids, extractId, projectId,
          sourceCodes, displayTerms, displayTermMatches, frequencies,
          clinicalDomains, sourceTerminologyIds,
          isNegatedArr, lateralityArr,
          severityArr, acuityArr, certaintyArr,
        ],
      );
    }

    const totalRows = ids.length;

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

    return { extractId, totalRows, skippedRows, detectedColumns, mappedColumns };

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
