// OmniMap — Admin: Projects List + Create

import { useState } from 'react';
import { Link }     from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type Project, type ProjectType } from '../../api/client';

// -----------------------------------------------------------------
// Status badge
// -----------------------------------------------------------------

const STATUS_COLOURS: Record<string, string> = {
  init:          'badge-slate',
  ingesting:     'badge-yellow',
  deduplicating: 'badge-yellow',
  sampling:      'badge-yellow',
  holdout_draw:  'badge-yellow',
  automatch:     'badge-yellow',
  allocating:    'badge-yellow',
  mapping:       'badge-blue',
  adjudicating:  'badge-blue',
  canonicalising:'badge-blue',
  regex_pipeline:'badge-blue',
  regex_validate:'badge-blue',
  corpus_update: 'badge-blue',
  scoring:       'badge-blue',
  exporting:     'badge-blue',
  complete:      'badge-green',
  archived:      'badge-slate',
};

function StatusBadge({ status }: { status: string }) {
  const cls = STATUS_COLOURS[status] ?? 'badge-slate';
  return <span className={cls}>{status.replace(/_/g, ' ')}</span>;
}

// -----------------------------------------------------------------
// Create project modal
// -----------------------------------------------------------------

interface CreateModalProps {
  onClose: () => void;
}

function CreateProjectModal({ onClose }: CreateModalProps) {
  const qc = useQueryClient();

  const { data: terminologies = [] } = useQuery({
    queryKey: ['terminologies'],
    queryFn:  api.terminologies.list,
  });

  const [name,               setName]               = useState('');
  const [description,        setDescription]        = useState('');
  const [projectType,        setProjectType]        = useState<ProjectType>('standard_mapping');
  const [targetTerminologyId, setTargetTerminologyId] = useState('');
  const [error,              setError]              = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.projects.create({
      name: name.trim(),
      description: description.trim() || undefined,
      projectType,
      targetTerminologyId,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['projects'] });
      onClose();
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="card w-full max-w-md p-6">
        <h2 className="text-lg font-semibold mb-4">New Project</h2>

        <form
          onSubmit={e => { e.preventDefault(); mutation.mutate(); }}
          className="space-y-4"
        >
          <div>
            <label className="label">Project name *</label>
            <input
              className="input"
              required
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. CPCSSN SNOMED CT Mapping 2026"
            />
          </div>

          <div>
            <label className="label">Description</label>
            <textarea
              className="input"
              rows={2}
              value={description}
              onChange={e => setDescription(e.target.value)}
            />
          </div>

          <div>
            <label className="label">Project type *</label>
            <select
              className="input"
              value={projectType}
              onChange={e => setProjectType(e.target.value as ProjectType)}
            >
              <option value="standard_mapping">Standard mapping</option>
              <option value="automation_evaluation">Automation evaluation</option>
              <option value="version_validation">Version validation</option>
            </select>
          </div>

          <div>
            <label className="label">Target terminology *</label>
            <select
              className="input"
              required
              value={targetTerminologyId}
              onChange={e => setTargetTerminologyId(e.target.value)}
            >
              <option value="">— select —</option>
              {terminologies.map(t => (
                <option key={t.id} value={t.id}>
                  {t.displayName} {t.version ? `(${t.version})` : ''}
                </option>
              ))}
            </select>
          </div>

          {error && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
            <button
              type="submit"
              className="btn-primary"
              disabled={mutation.isPending}
            >
              {mutation.isPending ? 'Creating…' : 'Create project'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------
// Projects page
// -----------------------------------------------------------------

export default function ProjectsPage() {
  const [showCreate, setShowCreate] = useState(false);

  const { data: projects = [], isLoading, error } = useQuery({
    queryKey: ['projects'],
    queryFn:  api.projects.list,
    refetchInterval: 15_000,
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-slate-800">Projects</h2>
        <button className="btn-primary" onClick={() => setShowCreate(true)}>
          + New project
        </button>
      </div>

      {isLoading && <p className="text-slate-500 text-sm">Loading projects…</p>}
      {error    && <p className="text-red-600 text-sm">{(error as Error).message}</p>}

      {!isLoading && projects.length === 0 && (
        <div className="card p-12 text-center">
          <p className="text-slate-400 text-sm">No projects yet. Create one to get started.</p>
        </div>
      )}

      {projects.length > 0 && (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-slate-600">Name</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600">Type</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600">Status</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600">DAG node</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600">Created</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {projects.map((p: Project) => (
                <tr key={p.id} className="hover:bg-slate-50 transition-colors">
                  <td className="px-4 py-3 font-medium text-slate-800">{p.name}</td>
                  <td className="px-4 py-3 text-slate-500">
                    {p.projectType.replace(/_/g, ' ')}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={p.status} />
                  </td>
                  <td className="px-4 py-3 text-slate-400 font-mono text-xs">
                    {p.currentDagNode ?? '—'}
                  </td>
                  <td className="px-4 py-3 text-slate-400">
                    {new Date(p.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      to={`/admin/projects/${p.id}`}
                      className="text-brand-600 hover:underline text-xs"
                    >
                      Manage →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && <CreateProjectModal onClose={() => setShowCreate(false)} />}
    </div>
  );
}
