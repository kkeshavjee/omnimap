// OmniMap — Audit Log Viewer
// Paginated, filterable view of the append-only audit_log table.
// Available to administrators and auditors.

import { useState }  from 'react';
import { useQuery }  from '@tanstack/react-query';
import { api, type AuditLogEntry } from '../../api/client';

const ACTION_COLOURS: Record<string, string> = {
  PROJECT_CREATED:         'bg-blue-100 text-blue-800',
  PROJECT_STATUS_CHANGED:  'bg-slate-100 text-slate-700',
  EXTRACT_PROCESSED:       'bg-green-100 text-green-800',
  MAPPING_SUBMITTED:       'bg-brand-100 text-brand-800',
  MAPPING_AGREED:          'bg-green-100 text-green-800',
  MAPPING_ESCALATED:       'bg-amber-100 text-amber-800',
  ADJUDICATION_RESOLVED:   'bg-purple-100 text-purple-800',
  MAPPING_CANONICALISED:   'bg-teal-100 text-teal-800',
  EXPORT_GENERATED:        'bg-gray-100 text-gray-700',
  TERM_AUTO_MATCHED:       'bg-sky-100 text-sky-700',
  HOLDOUT_DRAWN:           'bg-indigo-100 text-indigo-700',
};

function ActionBadge({ action }: { action: string }) {
  const colour = ACTION_COLOURS[action] ?? 'bg-slate-100 text-slate-600';
  return (
    <span className={`inline-block text-xs font-medium px-2 py-0.5 rounded-full ${colour}`}>
      {action.replace(/_/g, ' ')}
    </span>
  );
}

function PayloadCell({ payload }: { payload: Record<string, unknown> | null }) {
  const [expanded, setExpanded] = useState(false);
  if (!payload) return <span className="text-slate-300">—</span>;
  const preview = Object.entries(payload)
    .slice(0, 3)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join(' · ');
  return (
    <div>
      <span className="text-xs text-slate-500 font-mono">{preview}</span>
      {Object.keys(payload).length > 3 && (
        <button
          className="ml-2 text-xs text-brand-600 hover:underline"
          onClick={() => setExpanded(e => !e)}
        >
          {expanded ? 'less' : 'more'}
        </button>
      )}
      {expanded && (
        <pre className="mt-1 text-xs bg-slate-50 border border-slate-200 rounded p-2 overflow-x-auto">
          {JSON.stringify(payload, null, 2)}
        </pre>
      )}
    </div>
  );
}

export default function AuditLogPage() {
  const [projectFilter, setProjectFilter] = useState('');
  const [actionFilter,  setActionFilter]  = useState('');
  const [before,        setBefore]        = useState<string | undefined>();

  const { data: entries = [], isLoading, isFetching } = useQuery({
    queryKey: ['auditLog', projectFilter, actionFilter, before],
    queryFn:  () => api.audit.list({
      projectId: projectFilter || undefined,
      action:    actionFilter  || undefined,
      limit:     100,
      before,
    }),
    staleTime: 30_000,
  });

  const oldest = entries[entries.length - 1]?.occurredAt;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <h2 className="text-lg font-semibold text-slate-800 mr-auto">Audit Log</h2>

        <input
          className="input w-48"
          placeholder="Filter by project ID"
          value={projectFilter}
          onChange={e => { setProjectFilter(e.target.value); setBefore(undefined); }}
        />
        <input
          className="input w-52"
          placeholder="Filter by action"
          value={actionFilter}
          onChange={e => { setActionFilter(e.target.value); setBefore(undefined); }}
        />
        {(projectFilter || actionFilter) && (
          <button
            className="btn-secondary text-xs"
            onClick={() => { setProjectFilter(''); setActionFilter(''); setBefore(undefined); }}
          >
            Clear
          </button>
        )}
      </div>

      {isLoading ? (
        <p className="text-slate-500 text-sm">Loading audit log…</p>
      ) : entries.length === 0 ? (
        <p className="text-slate-400 text-sm">No entries found.</p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs text-slate-500 text-left">
                  <th className="py-2 pr-4 font-medium">Time</th>
                  <th className="py-2 pr-4 font-medium">Action</th>
                  <th className="py-2 pr-4 font-medium">Project</th>
                  <th className="py-2 pr-4 font-medium">Actor</th>
                  <th className="py-2 pr-4 font-medium">Entity</th>
                  <th className="py-2 font-medium">Payload</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {entries.map((e: AuditLogEntry) => (
                  <tr key={e.eventId} className="hover:bg-slate-50">
                    <td className="py-2 pr-4 text-xs text-slate-400 whitespace-nowrap">
                      {new Date(e.occurredAt).toLocaleString()}
                    </td>
                    <td className="py-2 pr-4">
                      <ActionBadge action={e.action} />
                    </td>
                    <td className="py-2 pr-4 text-xs text-slate-600 max-w-[120px] truncate">
                      {e.projectName ?? e.projectId ?? '—'}
                    </td>
                    <td className="py-2 pr-4 text-xs text-slate-500">
                      {e.systemFlag
                        ? <span className="italic text-slate-400">{e.systemFlag}</span>
                        : (e.userEmail ?? e.userId ?? '—')}
                    </td>
                    <td className="py-2 pr-4 text-xs font-mono text-slate-400">
                      {e.entityType}{e.entityId ? ` · ${e.entityId.slice(0, 8)}…` : ''}
                    </td>
                    <td className="py-2">
                      <PayloadCell payload={e.payload} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {entries.length === 100 && (
            <button
              className="btn-secondary text-xs"
              disabled={isFetching}
              onClick={() => setBefore(oldest)}
            >
              {isFetching ? 'Loading…' : 'Load older entries'}
            </button>
          )}
        </>
      )}
    </div>
  );
}
