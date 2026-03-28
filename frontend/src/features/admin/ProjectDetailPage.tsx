// OmniMap — Admin: Project Detail
// Shows project status and exposes DAG node controls (Nodes 1–8 + Export).

import { useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';

// -----------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium text-slate-500 uppercase tracking-wide">{label}</dt>
      <dd className="mt-0.5 text-sm text-slate-800">{value ?? '—'}</dd>
    </div>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-sm font-semibold text-slate-700 uppercase tracking-wider mb-3">
      {children}
    </h3>
  );
}

// -----------------------------------------------------------------
// Human-readable node result
// -----------------------------------------------------------------

const RESULT_LABELS: Record<string, Record<string, string>> = {
  ingest: {
    totalRows:        'Terms ingested',
    skippedRows:      'Rows skipped (missing required fields)',
    detectedColumns:  'Columns detected in file',
    mappedColumns:    'Columns mapped',
  },
  deduplicate: {
    alreadyMapped:      'Already mapped in corpus',
    netNewQueued:       'Net-new terms queued',
    forwardedToSample:  'Terms forwarded to sampling',
  },
  sample: {
    sampled:         'Terms selected for mapping',
    longTailQueued:  'Long-tail terms queued',
  },
  holdout: {
    holdoutN:      'Holdout size (power calc)',
    holdoutDrawn:  'Terms drawn for holdout',
    autoMatched:   'Auto-matched (SNOMED CT FSN)',
    toAllocate:    'Terms to allocate to reviewers',
  },
  allocate: {
    termsAllocated:      'Terms allocated',
    longTailAllocated:   'Long-tail terms allocated',
    assignmentsCreated:  'Reviewer assignments created',
  },
  canonicalise: {
    canonicalised: 'Terms canonicalised',
    skipped:       'Already canonicalised / skipped',
  },
};

function NodeResult({ result }: { result: NodeResult }) {
  const entries = Object.entries(result);
  return (
    <div className="bg-slate-50 border border-slate-200 rounded p-3 space-y-1.5">
      {entries.map(([k, v]) => {
        if (Array.isArray(v)) {
          return (
            <div key={k}>
              <span className="text-xs text-slate-500">
                {RESULT_LABELS['ingest']?.[k] ?? k}:
              </span>
              <span className="text-xs text-slate-700 ml-1">{(v as string[]).join(', ') || '—'}</span>
            </div>
          );
        }
        const label = Object.values(RESULT_LABELS).reduce<string | undefined>(
          (found, map) => found ?? map[k], undefined,
        ) ?? k;
        const isWarning = k === 'skippedRows' && (v as number) > 0;
        return (
          <div key={k} className="flex justify-between items-baseline gap-4">
            <span className="text-xs text-slate-500">{label}</span>
            <span className={`text-sm font-medium tabular-nums ${isWarning ? 'text-amber-600' : 'text-slate-800'}`}>
              {String(v)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// -----------------------------------------------------------------
// Node action panel
// -----------------------------------------------------------------

interface NodeResult {
  [key: string]: unknown;
}

function NodePanel({
  title,
  description,
  actionLabel,
  onRun,
  result,
  loading,
  error,
  children,
}: {
  title:       string;
  description: string;
  actionLabel: string;
  onRun:       () => void;
  result:      NodeResult | null;
  loading:     boolean;
  error:       string | null;
  children?:   React.ReactNode;
}) {
  const done = !!result && !error;
  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h4 className="font-medium text-slate-800">{title}</h4>
          <p className="text-xs text-slate-500 mt-0.5">{description}</p>
        </div>
        <button
          className="btn-primary shrink-0"
          onClick={onRun}
          disabled={loading || done}
          title={done ? 'Already completed — reload page to re-run' : undefined}
        >
          {loading ? 'Running…' : done ? '✓ Done' : actionLabel}
        </button>
      </div>

      {children}

      {error && (
        <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
          {error}
        </p>
      )}

      {result && <NodeResult result={result} />}
    </div>
  );
}

// -----------------------------------------------------------------
// Page
// -----------------------------------------------------------------

export default function ProjectDetailPage() {
  const { id }  = useParams<{ id: string }>();
  const qc      = useQueryClient();

  const [results,  setResults]  = useState<Record<string, NodeResult>>({});
  const [errors,   setErrors]   = useState<Record<string, string>>({});
  const [loadings, setLoadings] = useState<Record<string, boolean>>({});

  // Ingest
  const fileRef = useRef<HTMLInputElement>(null);
  const [ingestLoading,  setIngestLoading]  = useState(false);

  // Sample options
  const [strategy,         setStrategy]         = useState('pareto');
  const [paretoThreshold,  setParetoThreshold]  = useState(80);

  const { data: project, isLoading } = useQuery({
    queryKey: ['project', id],
    queryFn:  () => api.projects.get(id!),
    enabled:  !!id,
    refetchInterval: 5_000,
  });

  function setResult(node: string, r: NodeResult) {
    setResults(prev => ({ ...prev, [node]: r }));
    setErrors(prev => { const next = { ...prev }; delete next[node]; return next; });
    qc.invalidateQueries({ queryKey: ['project', id] });
  }
  function setError(node: string, msg: string) {
    setErrors(prev => ({ ...prev, [node]: msg }));
  }

  async function runMutation<T extends NodeResult>(
    node: string,
    fn: () => Promise<T>,
  ) {
    setLoadings(prev => ({ ...prev, [node]: true }));
    try {
      const r = await fn();
      setResult(node, r as NodeResult);
    } catch (err) {
      setError(node, (err as Error).message);
    } finally {
      setLoadings(prev => ({ ...prev, [node]: false }));
    }
  }

  async function handleIngest() {
    const file = fileRef.current?.files?.[0];
    if (!file || !id) return;
    setIngestLoading(true);
    try {
      const r = await api.projects.ingest(id, file);
      setResult('ingest', r as NodeResult);
    } catch (err) {
      setError('ingest', (err as Error).message);
    } finally {
      setIngestLoading(false);
    }
  }

  if (isLoading || !project) {
    return <p className="text-slate-500 text-sm">Loading project…</p>;
  }

  return (
    <div className="max-w-3xl space-y-8">
      {/* Project metadata */}
      <div className="card p-6">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-xl font-semibold text-slate-800">{project.name}</h2>
            {project.description && (
              <p className="text-sm text-slate-500 mt-1">{project.description}</p>
            )}
          </div>
          <span className="badge-blue">{project.status.replace(/_/g, ' ')}</span>
        </div>
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Field label="Type"       value={project.projectType.replace(/_/g, ' ')} />
          <Field label="DAG node"   value={project.currentDagNode} />
          <Field label="F1 threshold" value={project.powerF1Threshold} />
          <Field label="Alpha"      value={project.powerAlpha} />
          <Field label="Power (1−β)" value={(1 - project.powerBeta).toFixed(2)} />
          <Field label="Holdout n"  value={project.computedHoldoutN} />
          <Field label="Sample locked" value={project.sampleLockedAt
            ? new Date(project.sampleLockedAt).toLocaleDateString() : 'No'} />
          <Field label="Holdout locked" value={project.holdoutLockedAt
            ? new Date(project.holdoutLockedAt).toLocaleDateString() : 'No'} />
        </dl>
      </div>

      {/* Node 1 — Ingest */}
      <section>
        <SectionHeading>Node 1 — Ingest</SectionHeading>
        <div className="card p-4 space-y-3">
          <div>
            <h4 className="font-medium text-slate-800">Upload EMR extract</h4>
            <p className="text-xs text-slate-500 mt-0.5">
              CSV, TSV, or Excel. Required columns: source_code, display_term, frequency.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.tsv,.xlsx,.xls"
              className="text-sm text-slate-600 file:mr-3 file:btn-secondary"
            />
            <button
              className="btn-primary"
              onClick={handleIngest}
              disabled={ingestLoading}
            >
              {ingestLoading ? 'Uploading…' : 'Upload & ingest'}
            </button>
          </div>
          {errors['ingest'] && (
            <p className="text-xs text-red-600">{errors['ingest']}</p>
          )}
          {results['ingest'] && (
            <NodeResult result={results['ingest']} />
          )}
        </div>
      </section>

      {/* Node 2 — Deduplicate */}
      <section>
        <SectionHeading>Node 2 — Deduplicate</SectionHeading>
        <NodePanel
          title="Run deduplication"
          description="Cross-reference against OmniMap corpus and external reference imports."
          actionLabel="Run"
          onRun={() => runMutation('deduplicate', () => api.projects.deduplicate(id!))}
          result={results['deduplicate'] ?? null}
          loading={loadings['deduplicate'] ?? false}
          error={errors['deduplicate'] ?? null}
        />
      </section>

      {/* Node 3 — Sample */}
      <section>
        <SectionHeading>Node 3 — Sample</SectionHeading>
        <NodePanel
          title="Apply sampling strategy"
          description="Select terms for the mapping pool; remainder goes to long-tail queue."
          actionLabel="Sample"
          onRun={() =>
            runMutation('sample', () =>
              api.projects.sample(
                id!,
                strategy,
                strategy === 'pareto' ? paretoThreshold / 100 : undefined,
              )
            )
          }
          result={results['sample'] ?? null}
          loading={loadings['sample'] ?? false}
          error={errors['sample'] ?? null}
        >
          <div className="flex items-center gap-4">
            <div>
              <label className="label">Strategy</label>
              <select
                className="input"
                value={strategy}
                onChange={e => setStrategy(e.target.value)}
              >
                <option value="pareto">Pareto</option>
                <option value="random">Random</option>
                <option value="frequency">Frequency</option>
                <option value="stratified">Stratified</option>
              </select>
            </div>
            {strategy === 'pareto' && (
              <div>
                <label className="label">Threshold %</label>
                <input
                  type="number"
                  className="input w-24"
                  min={50} max={99} step={1}
                  value={paretoThreshold}
                  onChange={e => setParetoThreshold(Number(e.target.value))}
                />
              </div>
            )}
          </div>
        </NodePanel>
      </section>

      {/* Node 4 — Holdout draw + AUTOMATCH */}
      <section>
        <SectionHeading>Node 4 — Holdout draw + AUTOMATCH</SectionHeading>
        <NodePanel
          title="Draw holdout & run AUTOMATCH"
          description={`Power calculation (F1≥${project.powerF1Threshold}, α=${project.powerAlpha}, power=${(1 - project.powerBeta).toFixed(2)}). Locks holdout. Runs SNOMED CT FSN AUTOMATCH.`}
          actionLabel="Draw holdout"
          onRun={() => runMutation('holdout', () => api.projects.holdout(id!))}
          result={results['holdout'] ?? null}
          loading={loadings['holdout'] ?? false}
          error={errors['holdout'] ?? null}
        />
      </section>

      {/* Node 5 — Allocate */}
      <section>
        <SectionHeading>Node 5 — Allocate</SectionHeading>
        <NodePanel
          title="Allocate to reviewers"
          description="Affinity-weighted dual-independent assignment. Every term → exactly 2 reviewers."
          actionLabel="Allocate"
          onRun={() => runMutation('allocate', () => api.projects.allocate(id!))}
          result={results['allocate'] ?? null}
          loading={loadings['allocate'] ?? false}
          error={errors['allocate'] ?? null}
        />
      </section>

      {/* Node 6 — MAP (reviewer workspace) */}
      <section>
        <SectionHeading>Node 6 — MAP (Reviewer Workspace)</SectionHeading>
        <div className="card p-4 space-y-3">
          <div className="flex items-start justify-between">
            <div>
              <h4 className="font-medium text-slate-800">Open reviewer workspace</h4>
              <p className="text-xs text-slate-500 mt-0.5">
                Dual-independent review. Each reviewer works from their own queue.
                Agreed terms advance automatically; discrepancies go to adjudication.
              </p>
            </div>
            <Link
              to={`/reviewer/${id}/map`}
              className="btn-secondary shrink-0 text-sm"
            >
              Open as reviewer →
            </Link>
          </div>
          {project.currentDagNode === 'NODE_6_MAP' && (
            <p className="text-xs text-green-700 bg-green-50 border border-green-200 rounded px-3 py-1.5">
              Project is currently in the mapping phase.
            </p>
          )}
        </div>
      </section>

      {/* Node 7 — Adjudicate */}
      <section>
        <SectionHeading>Node 7 — Adjudicate</SectionHeading>
        <div className="card p-4 space-y-3">
          <div className="flex items-start justify-between">
            <div>
              <h4 className="font-medium text-slate-800">Open adjudication queue</h4>
              <p className="text-xs text-slate-500 mt-0.5">
                Discrepant reviewer decisions are queued here for adjudicator resolution.
              </p>
            </div>
            <Link
              to={`/adjudicator/${id}`}
              className="btn-secondary shrink-0 text-sm"
            >
              Open adjudicator →
            </Link>
          </div>
        </div>
      </section>

      {/* Node 8 — Canonicalise */}
      <section>
        <SectionHeading>Node 8 — Canonicalise</SectionHeading>
        <NodePanel
          title="Write to canonical corpus"
          description="Writes all agreed and adjudicated terms to the canonical_mappings table. Advances project to exporting."
          actionLabel="Canonicalise"
          onRun={() => runMutation('canonicalise', () => api.projects.canonicalise(id!))}
          result={results['canonicalise'] ?? null}
          loading={loadings['canonicalise'] ?? false}
          error={errors['canonicalise'] ?? null}
        />
      </section>

      {/* Node 13 — Export */}
      <section>
        <SectionHeading>Node 13 — Export</SectionHeading>

        {/* Canonical mappings export */}
        <div className="card p-4 space-y-3">
          <div>
            <h4 className="font-medium text-slate-800">Download canonical mappings</h4>
            <p className="text-xs text-slate-500 mt-0.5">
              Export all current canonical mappings for this project.
            </p>
          </div>
          <div className="flex gap-3">
            <a
              href={`/api/projects/${id}/export?format=csv`}
              className="btn-secondary text-sm"
              download
            >
              Download CSV
            </a>
            <button
              className="btn-secondary text-sm"
              onClick={async () => {
                try {
                  const data = await api.projects.exportJson(id!);
                  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                  const url  = URL.createObjectURL(blob);
                  const a    = document.createElement('a');
                  a.href = url; a.download = `omnimap-export-${id}.json`; a.click();
                  URL.revokeObjectURL(url);
                } catch (err) {
                  setError('export', (err as Error).message);
                }
              }}
            >
              Download JSON
            </button>
          </div>
          {errors['export'] && (
            <p className="text-xs text-red-600">{errors['export']}</p>
          )}
        </div>

        {/* SNOMED Gap Report */}
        <div className="card p-4 space-y-3 mt-4">
          <div>
            <h4 className="font-medium text-slate-800">SNOMED Gap Report</h4>
            <p className="text-xs text-slate-500 mt-0.5">
              Terms with no SNOMED CT mapping, categorised by gap reason code.
              Use this report when submitting gaps to the SNOMED International Content Request System (CRS).
            </p>
          </div>
          <div className="flex gap-3">
            <a
              href={`/api/projects/${id}/gap-report?format=csv`}
              className="btn-secondary text-sm"
              download
            >
              Download Gap Report (CSV)
            </a>
            <button
              className="btn-secondary text-sm"
              onClick={async () => {
                try {
                  const data = await api.projects.gapReport(id!);
                  if (data.total === 0) {
                    alert('No SNOMED gap terms found for this project.');
                    return;
                  }
                  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                  const url  = URL.createObjectURL(blob);
                  const a    = document.createElement('a');
                  a.href = url; a.download = `omnimap-gap-report-${id}.json`; a.click();
                  URL.revokeObjectURL(url);
                } catch (err) {
                  setError('gapReport', (err as Error).message);
                }
              }}
            >
              Download Gap Report (JSON)
            </button>
          </div>
          {errors['gapReport'] && (
            <p className="text-xs text-red-600">{errors['gapReport']}</p>
          )}
        </div>
      </section>
    </div>
  );
}
