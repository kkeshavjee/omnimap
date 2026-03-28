// OmniMap — Node 7: ADJUDICATOR Workspace
//
// Split view: source term on top, then two reviewer decisions side by side.
// Adjudicator can:
//   • Accept Decision A or B (including their gap reason codes)
//   • Build their own mapping (search + targets) then confirm
//   • Declare "No SNOMED match" with a structured gap reason code
//
// Reviewer identities are hidden (decisions shown as "Reviewer A" / "Reviewer B").

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams }   from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  api,
  type AdjudicationDecision,
  type GapReasonCode,
  type MappingRelationship,
  GAP_REASON_LABELS,
} from '../../api/client';

// -----------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------

function GapBadge({ code }: { code: GapReasonCode }) {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-orange-100 border border-orange-300 text-orange-800 rounded text-xs font-medium">
      {code} — {GAP_REASON_LABELS[code]}
    </span>
  );
}

function DecisionCard({
  label,
  decision,
  onAccept,
}: {
  label:    string;
  decision: AdjudicationDecision | null;
  onAccept: () => void;
}) {
  if (!decision) return <div className="card p-4 text-sm text-slate-400">No decision</div>;

  const acceptLabel = decision.isUnmappable
    ? `Accept: No match${decision.gapReasonCode ? ` (${decision.gapReasonCode})` : ''}`
    : 'Accept mapping';

  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">{label}</p>
        <button className="btn-secondary text-xs py-1 px-3" onClick={onAccept}>
          {acceptLabel}
        </button>
      </div>

      {decision.isUnmappable ? (
        <div className="space-y-1.5">
          <p className="text-sm text-orange-700 font-medium">● No SNOMED match</p>
          {decision.gapReasonCode && <GapBadge code={decision.gapReasonCode} />}
        </div>
      ) : (
        <ul className="space-y-1">
          {decision.targets.map(t => (
            <li key={t.targetCode} className="text-sm text-slate-800">
              <span className="font-mono text-xs text-slate-400 mr-2">{t.targetCode}</span>
              {t.targetDisplay}
              <span className="ml-2 text-xs text-slate-400">({t.relationshipType.replace(/_/g, ' ')})</span>
            </li>
          ))}
          {decision.targets.length === 0 && (
            <li className="text-xs text-slate-400">No targets recorded</li>
          )}
        </ul>
      )}

      {decision.rationale && (
        <p className="text-xs text-slate-500 italic border-t border-slate-100 pt-2">
          "{decision.rationale}"
        </p>
      )}
    </div>
  );
}

function GapReasonSelector({
  value,
  onChange,
}: {
  value:    GapReasonCode | '';
  onChange: (v: GapReasonCode) => void;
}) {
  const codes = Object.keys(GAP_REASON_LABELS) as GapReasonCode[];
  return (
    <div className="mt-3 space-y-2">
      <label className="label">
        Gap reason <span className="text-red-500">*</span>
      </label>
      <div className="grid gap-1.5">
        {codes.map(code => (
          <label
            key={code}
            className={`flex items-start gap-3 px-3 py-2 rounded-md border cursor-pointer transition-colors ${
              value === code
                ? 'bg-orange-50 border-orange-400 text-orange-900'
                : 'bg-white border-slate-200 hover:bg-slate-50 text-slate-700'
            }`}
          >
            <input
              type="radio"
              name="adjGapReasonCode"
              value={code}
              checked={value === code}
              onChange={() => onChange(code)}
              className="mt-0.5 accent-orange-500"
            />
            <span className="text-sm">
              <span className="font-mono font-semibold mr-1.5">{code}</span>
              {GAP_REASON_LABELS[code]}
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------
// Workspace
// -----------------------------------------------------------------

export default function AdjudicatorWorkspace() {
  const { projectId } = useParams<{ projectId: string }>();
  const qc = useQueryClient();

  const [activeIdx,     setActiveIdx]     = useState(0);
  const [isUnmappable,  setIsUnmappable]  = useState(false);
  const [gapReasonCode, setGapReasonCode] = useState<GapReasonCode | ''>('');
  const [searchQuery,   setSearchQuery]   = useState('');
  const [selected,      setSelected]      = useState<Array<{
    targetCode: string; targetDisplay: string; relationshipType: MappingRelationship;
  }>>([]);
  const [rationale,    setRationale]    = useState('');
  const [submitError,  setSubmitError]  = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const { data: queue = [], isLoading } = useQuery({
    queryKey: ['adjQueue', projectId],
    queryFn:  () => api.adjudicator.queue(projectId!),
    enabled:  !!projectId,
    staleTime: 0,
  });

  const { data: stats } = useQuery({
    queryKey: ['adjStats', projectId],
    queryFn:  () => api.adjudicator.stats(projectId!),
    enabled:  !!projectId,
    refetchInterval: 15_000,
  });

  const { data: searchResults = [] } = useQuery({
    queryKey: ['conceptSearch', searchQuery],
    queryFn:  () => api.search.concepts(searchQuery),
    enabled:  searchQuery.trim().length >= 2,
    staleTime: 30_000,
  });

  const activeItem = queue[activeIdx] ?? null;

  useEffect(() => {
    setIsUnmappable(false);
    setGapReasonCode('');
    setSelected([]);
    setRationale('');
    setSearchQuery('');
    setSubmitError(null);
  }, [activeIdx, activeItem?.queueItemId]);

  const submitMutation = useMutation({
    mutationFn: (data: {
      isUnmappable:      boolean;
      gapReasonCode?:    GapReasonCode;
      targets?:          typeof selected;
      rationale?:        string;
      acceptDecisionId?: string;
    }) => {
      if (!activeItem) throw new Error('No active item');
      return api.adjudicator.resolve(projectId!, activeItem.queueItemId, data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['adjQueue',  projectId] });
      qc.invalidateQueries({ queryKey: ['adjStats',  projectId] });
      setActiveIdx(prev => Math.min(prev, queue.length - 2));
    },
    onError: (err: Error) => setSubmitError(err.message),
  });

  // Accept a reviewer decision (passes acceptDecisionId + gap reason if applicable)
  function acceptDecision(decision: AdjudicationDecision) {
    submitMutation.mutate({
      isUnmappable:     decision.isUnmappable,
      gapReasonCode:    decision.gapReasonCode ?? undefined,
      acceptDecisionId: decision.decisionId,
      rationale:        rationale || undefined,
    });
  }

  // Whether own-decision form is valid to submit
  const canSubmitOwn =
    !submitMutation.isPending &&
    (isUnmappable
      ? !!gapReasonCode && (gapReasonCode !== 'GAP-06' || rationale.trim().length > 0)
      : selected.length > 0);

  // Keyboard navigation
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, queue.length - 1)); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, 0)); }
    if (e.key === '/')         { e.preventDefault(); searchRef.current?.focus(); }
    if (e.key === 'u' || e.key === 'U') {
      setIsUnmappable(v => {
        const next = !v;
        if (next) setSelected([]);
        else setGapReasonCode('');
        return next;
      });
    }
  }, [queue.length]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  function addTarget(t: { targetCode: string; targetDisplay: string; relationshipType: MappingRelationship }) {
    if (selected.some(s => s.targetCode === t.targetCode)) return;
    setSelected(prev => [...prev, t]);
    setSearchQuery('');
  }

  if (isLoading) return <p className="text-slate-500 text-sm p-6">Loading queue…</p>;

  if (queue.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-center p-8">
        <p className="text-4xl">✅</p>
        <p className="text-lg font-semibold text-slate-700">Adjudication queue empty</p>
        <p className="text-sm text-slate-500">All discrepancies for this project have been resolved.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 -m-6">
      {/* ── Left: queue list ─────────────────────────────────── */}
      <aside className="w-64 shrink-0 border-r border-slate-200 bg-white overflow-y-auto flex flex-col">
        {stats && (
          <div className="px-4 py-2 bg-slate-50 border-b border-slate-200 text-xs text-slate-500">
            <span className="font-medium text-slate-700">{Number(stats.resolved)}</span> resolved /
            <span className="font-medium text-slate-700 ml-1">{Number(stats.pending)}</span> pending
          </div>
        )}
        <div className="flex-1 overflow-y-auto">
          {queue.map((item, i) => (
            <div
              key={item.queueItemId}
              onClick={() => setActiveIdx(i)}
              className={`px-4 py-3 border-b border-slate-100 cursor-pointer transition-colors ${
                i === activeIdx ? 'bg-brand-50 border-l-2 border-l-brand-500' : 'hover:bg-slate-50'
              }`}
            >
              <p className="text-sm font-medium text-slate-800 truncate">{item.displayTerm}</p>
              <p className="text-xs text-slate-400 font-mono">{item.sourceCode}</p>
              {/* Show gap indicator if either reviewer declared no match */}
              {(item.decisionA?.isUnmappable || item.decisionB?.isUnmappable) && (
                <p className="text-xs text-orange-600 mt-0.5">⚠ gap declared</p>
              )}
            </div>
          ))}
        </div>
        <div className="px-4 py-2 text-xs text-slate-400 border-t border-slate-100">
          ↑↓ navigate · / search · U no match
        </div>
      </aside>

      {/* ── Right: adjudication workspace ────────────────────── */}
      <div className="flex-1 min-w-0 flex flex-col bg-white overflow-hidden">
        {activeItem && (
          <>
            {/* Source term header */}
            <div className="px-6 py-4 border-b border-slate-200 bg-slate-50">
              <div className="flex items-start justify-between">
                <div>
                  <h2 className="text-xl font-semibold text-slate-900">{activeItem.displayTerm}</h2>
                  <p className="text-sm text-slate-500 font-mono mt-0.5">{activeItem.sourceCode}</p>
                </div>
                <div className="text-right text-xs text-slate-400 space-y-0.5">
                  {activeItem.frequency && <p>freq: <strong>{activeItem.frequency.toLocaleString()}</strong></p>}
                  {activeItem.clinicalDomain && <p>domain: <strong>{activeItem.clinicalDomain}</strong></p>}
                  <p>{activeIdx + 1} / {queue.length}</p>
                </div>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              {/* Reviewer decisions side by side */}
              <div className="grid grid-cols-2 gap-4">
                {activeItem.decisionA && (
                  <DecisionCard
                    label="Reviewer A"
                    decision={activeItem.decisionA}
                    onAccept={() => acceptDecision(activeItem.decisionA!)}
                  />
                )}
                {activeItem.decisionB && (
                  <DecisionCard
                    label="Reviewer B"
                    decision={activeItem.decisionB}
                    onAccept={() => acceptDecision(activeItem.decisionB!)}
                  />
                )}
              </div>

              {/* Conflict indicator */}
              {activeItem.decisionA && activeItem.decisionB && (
                (() => {
                  const aGap = activeItem.decisionA.isUnmappable;
                  const bGap = activeItem.decisionB.isUnmappable;
                  if (aGap !== bGap) {
                    return (
                      <div className="flex items-center gap-2 px-3 py-2 bg-amber-50 border border-amber-300 rounded-md text-sm text-amber-800">
                        <span>⚠</span>
                        <span>
                          <strong>Conflict:</strong> {aGap ? 'Reviewer A declared no SNOMED match' : 'Reviewer B declared no SNOMED match'};
                          the other reviewer provided a mapping. Your decision overrides both.
                        </span>
                      </div>
                    );
                  }
                  return null;
                })()
              )}

              {/* Divider */}
              <div className="relative">
                <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-slate-200" /></div>
                <div className="relative flex justify-center">
                  <span className="bg-white px-3 text-xs text-slate-400">— or build your own decision —</span>
                </div>
              </div>

              {/* No SNOMED match toggle */}
              <div>
                <button
                  type="button"
                  onClick={() => {
                    setIsUnmappable(v => {
                      const next = !v;
                      if (next) setSelected([]);
                      else setGapReasonCode('');
                      return next;
                    });
                  }}
                  className={`inline-flex items-center gap-2 px-4 py-2 rounded-md border text-sm font-medium transition-colors ${
                    isUnmappable
                      ? 'bg-orange-100 border-orange-400 text-orange-800 hover:bg-orange-200'
                      : 'bg-white border-slate-300 text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  <span className={`w-4 h-4 rounded border-2 flex items-center justify-center ${
                    isUnmappable ? 'border-orange-500 bg-orange-500' : 'border-slate-400'
                  }`}>
                    {isUnmappable && <span className="text-white text-xs leading-none">✓</span>}
                  </span>
                  No SNOMED match
                  <kbd className="ml-1 px-1 py-0.5 text-xs bg-white border border-slate-200 rounded font-mono">U</kbd>
                </button>

                {isUnmappable && (
                  <GapReasonSelector value={gapReasonCode} onChange={setGapReasonCode} />
                )}
              </div>

              {/* Concept search (hidden in gap mode) */}
              {!isUnmappable && (
                <div>
                  <label className="label">Search target terminology</label>
                  <div className="relative">
                    <input
                      ref={searchRef}
                      className="input pr-10"
                      placeholder="Type to search (/) — corpus-driven"
                      value={searchQuery}
                      onChange={e => setSearchQuery(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Escape') { setSearchQuery(''); searchRef.current?.blur(); } }}
                    />
                    {searchQuery && (
                      <button onClick={() => setSearchQuery('')}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">✕</button>
                    )}
                  </div>
                  {searchResults.length > 0 && (
                    <ul className="mt-1 border border-slate-200 rounded-md divide-y divide-slate-100 shadow-sm">
                      {searchResults.map(r => (
                        <li key={r.targetCode}
                          className="px-3 py-2 hover:bg-brand-50 cursor-pointer flex items-start justify-between gap-4"
                          onClick={() => addTarget({ ...r, relationshipType: r.relationshipType as MappingRelationship })}>
                          <div>
                            <p className="text-sm font-medium text-slate-800">{r.targetDisplay}</p>
                            <p className="text-xs text-slate-400 font-mono">{r.targetCode}</p>
                          </div>
                          <span className="text-xs text-brand-600 shrink-0">+ add</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {selected.length > 0 && (
                    <ul className="mt-3 space-y-2">
                      {selected.map(t => (
                        <li key={t.targetCode}
                          className="flex items-start gap-3 px-3 py-2 bg-green-50 border border-green-200 rounded-md">
                          <div className="flex-1">
                            <p className="text-sm font-medium text-slate-800">{t.targetDisplay}</p>
                            <p className="text-xs text-slate-400 font-mono">{t.targetCode}</p>
                          </div>
                          <button onClick={() => setSelected(prev => prev.filter(s => s.targetCode !== t.targetCode))}
                            className="text-slate-400 hover:text-red-600 text-lg leading-none">×</button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {/* Rationale */}
              <div>
                <label className="label">
                  Rationale
                  {gapReasonCode === 'GAP-06' && (
                    <span className="text-red-500 ml-1">* required for GAP-06</span>
                  )}
                </label>
                <textarea
                  className="input"
                  rows={3}
                  placeholder={
                    gapReasonCode === 'GAP-06'
                      ? 'Required: describe the gap reason in detail'
                      : isUnmappable
                        ? 'Optional: add context about the gap'
                        : 'Optional: adjudication rationale'
                  }
                  value={rationale}
                  onChange={e => setRationale(e.target.value)}
                />
              </div>

              {submitError && (
                <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
                  {submitError}
                </p>
              )}
            </div>

            {/* Footer — own decision */}
            <div className="px-6 py-4 border-t border-slate-200 bg-white flex items-center justify-between">
              <button
                className="btn-secondary"
                onClick={() => setActiveIdx(i => Math.max(i - 1, 0))}
                disabled={activeIdx === 0}
              >
                ← Previous
              </button>

              <button
                className="btn-primary px-8"
                disabled={!canSubmitOwn}
                onClick={() => submitMutation.mutate({
                  isUnmappable,
                  gapReasonCode:  isUnmappable && gapReasonCode ? gapReasonCode : undefined,
                  targets:        isUnmappable ? undefined : selected,
                  rationale:      rationale || undefined,
                })}
              >
                {submitMutation.isPending
                  ? 'Submitting…'
                  : isUnmappable
                    ? 'Confirm: No SNOMED match'
                    : 'Confirm own decision (↵)'}
              </button>

              <button
                className="btn-secondary"
                onClick={() => setActiveIdx(i => Math.min(i + 1, queue.length - 1))}
                disabled={activeIdx >= queue.length - 1}
              >
                Next →
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
