// OmniMap — Admin: Project Detail
// Shows project status and exposes DAG node controls (Nodes 1–5).

import { useRef, useState } from 'react';
import { useParams }        from 'react-router-dom';
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
          disabled={loading}
        >
          {loading ? 'Running…' : actionLabel}
        </button>
      </div>

      {children}

      {error && (
        <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
          {error}
        </p>
      )}

      {result && (
        <pre className="text-xs bg-slate-50 border border-slate-200 rounded p-3 overflow-x-auto text-slate-700">
          {JSON.stringify(result, null, 2)}
        </pre>
      )}
    </div>
  );
}

// -----------------------------------------------------------------
// Page
// -----------------------------------------------------------------

export default function ProjectDetailPage() {
  const { id }  = useParams<{ id: string }>();
  const qc      = useQueryClient();

  const [results, setResults] = useState<Record<string, NodeResult>>({});
  const [errors,  setErrors]  = useState<Record<string, string>>({});

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
    try {
      const r = await fn();
      setResult(node, r as NodeResult);
    } catch (err) {
      setError(node, (err as Error).message);
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
            <pre className="text-xs bg-slate-50 border rounded p-3">
              {JSON.stringify(results['ingest'], null, 2)}
            </pre>
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
          loading={false}
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
          loading={false}
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
          loading={false}
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
          loading={false}
          error={errors['allocate'] ?? null}
        />
      </section>
    </div>
  );
}
