// OmniMap — Reviewer: Project Selector
// Shows projects that have active assignments for this reviewer.
// Clicking a project opens the MAP workspace.

import { useNavigate }  from 'react-router-dom';
import { useQuery }     from '@tanstack/react-query';
import { api }          from '../../api/client';

export default function ReviewerProjectSelect() {
  const navigate = useNavigate();

  const { data: projects = [], isLoading } = useQuery({
    queryKey: ['projects'],
    queryFn:  () => api.projects.list(),
  });

  // Filter to projects with status in the mapping phase
  const activeProjects = projects.filter(p =>
    ['mapping', 'adjudicating', 'canonicalising', 'allocating'].includes(p.status),
  );

  if (isLoading) {
    return <p className="text-slate-500 text-sm p-6">Loading projects…</p>;
  }

  if (activeProjects.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-center p-8">
        <p className="text-4xl">📭</p>
        <p className="text-lg font-semibold text-slate-700">No active projects</p>
        <p className="text-sm text-slate-500">
          You have no projects currently in the mapping phase.
          Check back once an administrator has allocated terms.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-xl space-y-4">
      <h2 className="text-lg font-semibold text-slate-800">Select a project to open your queue</h2>
      <ul className="space-y-2">
        {activeProjects.map(p => (
          <li key={p.id}>
            <button
              className="w-full text-left card p-4 hover:border-brand-400 hover:shadow-md transition-all"
              onClick={() => navigate(`/reviewer/${p.id}/map`)}
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="font-medium text-slate-800">{p.name}</p>
                  {p.description && (
                    <p className="text-xs text-slate-500 mt-0.5 line-clamp-2">{p.description}</p>
                  )}
                </div>
                <span className="badge-blue shrink-0">{p.status.replace(/_/g, ' ')}</span>
              </div>
              <p className="text-xs text-slate-400 mt-2">
                {p.projectType.replace(/_/g, ' ')} · DAG: {p.currentDagNode ?? '—'}
              </p>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
