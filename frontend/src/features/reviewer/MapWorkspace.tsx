// OmniMap — Node 6: MAP Reviewer Workspace
//
// Split-screen layout:
//   Left  — source term + context (frequency, domain, prior mappings)
//   Right — terminology search + AI suggestions (advisory) + selected targets
//
// Keyboard shortcuts:
//   ↓/↑         move between queue items
//   Enter       confirm current mapping
//   U           toggle No SNOMED match mode
//   /           focus search
//   Escape      clear search
//
// Rules enforced here:
//   • Batch accept of AI suggestions PROHIBITED (no "accept all AI" button)
//   • AI suggestions are labelled advisory-only
//   • Reviewer never sees another reviewer's queue or decisions

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams }   from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  api,
  type AssignedTerm,
  type MappingRelationship,
  type ConceptSearchResult,
  type GapReasonCode,
  GAP_REASON_LABELS,
} from '../../api/client';

// -----------------------------------------------------------------
// Types
// -----------------------------------------------------------------

interface TargetCandidate {
  targetCode:       string;
  targetDisplay:    string;
  relationshipType: MappingRelationship;
  isAiSuggestion:  boolean;
}

function toCandidate(r: ConceptSearchResult): TargetCandidate {
  return {
    targetCode:       r.targetCode,
    targetDisplay:    r.targetDisplay,
    relationshipType: r.relationshipType,
    isAiSuggestion:  false,
  };
}

// -----------------------------------------------------------------
// Sub-components
// -----------------------------------------------------------------

function TermCard({ term, isActive }: { term: AssignedTerm; isActive: boolean }) {
  return (
    <div
      className={`px-4 py-3 border-b border-slate-100 cursor-pointer transition-colors ${
        isActive ? 'bg-brand-50 border-l-2 border-l-brand-500' : 'hover:bg-slate-50'
      }`}
    >
      <p className="text-sm font-medium text-slate-800 truncate">{term.displayTerm}</p>
      <p className="text-xs text-slate-400 font-mono">{term.sourceCode}</p>
      {term.frequency && (
        <p className="text-xs text-slate-400">freq: {term.frequency.toLocaleString()}</p>
      )}
    </div>
  );
}

function RelationshipSelect({
  value,
  onChange,
}: {
  value:    MappingRelationship;
  onChange: (v: MappingRelationship) => void;
}) {
  const options: { value: MappingRelationship; label: string }[] = [
    { value: 'equivalent_to', label: '= Equivalent to' },
    { value: 'broader_than',  label: '> Broader than'  },
    { value: 'narrower_than', label: '< Narrower than'  },
    { value: 'related_to',    label: '~ Related to'     },
  ];
  return (
    <select
      className="input text-xs py-1"
      value={value}
      onChange={e => onChange(e.target.value as MappingRelationship)}
    >
      {options.map(o => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

// Gap reason code selector shown when "No SNOMED match" is active
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
              name="gapReasonCode"
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

// Simulated AI suggestions (placeholder until Python AI agent is wired in Phase E)
function useAiSuggestions(term: AssignedTerm | null): TargetCandidate[] {
  if (!term) return [];
  // Stub — returns empty; real AI suggestions come from the Python suggestion agent
  return [];
}

function useTerminologySearch(query: string): TargetCandidate[] {
  const { data = [] } = useQuery({
    queryKey: ['conceptSearch', query],
    queryFn:  () => api.search.concepts(query),
    enabled:  query.trim().length >= 2,
    staleTime: 30_000,
  });
  return data.map(toCandidate);
}

// -----------------------------------------------------------------
// Main workspace
// -----------------------------------------------------------------

export default function MapWorkspace() {
  const { projectId } = useParams<{ projectId: string }>();
  const qc            = useQueryClient();

  const [activeIdx,     setActiveIdx]     = useState(0);
  const [searchQuery,   setSearchQuery]   = useState('');
  const [selected,      setSelected]      = useState<TargetCandidate[]>([]);
  const [rationale,     setRationale]     = useState('');
  const [isUnmappable,  setIsUnmappable]  = useState(false);
  const [gapReasonCode, setGapReasonCode] = useState<GapReasonCode | ''>('');
  const [submitError,   setSubmitError]   = useState<string | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);

  // Fetch queue
  const { data: queue = [], isLoading } = useQuery({
    queryKey: ['reviewerQueue', projectId],
    queryFn:  () => api.reviewer.myQueue(projectId!),
    enabled:  !!projectId,
    staleTime: 0,
  });

  const { data: stats } = useQuery({
    queryKey: ['reviewerStats', projectId],
    queryFn:  () => api.reviewer.myStats(projectId!),
    enabled:  !!projectId,
    refetchInterval: 30_000,
  });

  const activeTerm    = queue[activeIdx] ?? null;
  const aiSuggestions = useAiSuggestions(activeTerm);
  const searchResults = useTerminologySearch(searchQuery);

  // Reset selection when term changes
  useEffect(() => {
    setSelected([]);
    setRationale('');
    setIsUnmappable(false);
    setGapReasonCode('');
    setSearchQuery('');
    setSubmitError(null);
  }, [activeIdx, activeTerm?.projectTermId]);

  // Submit mapping mutation
  const submitMutation = useMutation({
    mutationFn: () => {
      if (!activeTerm) throw new Error('No active term');
      return api.reviewer.submitMapping(projectId!, {
        assignmentId:  activeTerm.assignmentId,
        projectTermId: activeTerm.projectTermId,
        isUnmappable,
        gapReasonCode: isUnmappable && gapReasonCode ? gapReasonCode : undefined,
        targets: selected.map(t => ({
          targetCode:       t.targetCode,
          targetDisplay:    t.targetDisplay,
          relationshipType: t.relationshipType,
        })),
        rationale: rationale || undefined,
        isAiAssisted: selected.some(t => t.isAiSuggestion),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['reviewerQueue', projectId] });
      qc.invalidateQueries({ queryKey: ['reviewerStats', projectId] });
      // Advance to next term (or stay if last)
      setActiveIdx(prev => Math.min(prev, queue.length - 2));
    },
    onError: (err: Error) => setSubmitError(err.message),
  });

  // Whether form is valid enough to submit
  const canSubmit =
    !submitMutation.isPending &&
    (isUnmappable
      ? !!gapReasonCode && (gapReasonCode !== 'GAP-06' || rationale.trim().length > 0)
      : selected.length > 0);

  // ── Keyboard shortcuts ────────────────────────────────────────
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx(i => Math.min(i + 1, queue.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx(i => Math.max(i - 1, 0));
    } else if (e.key === '/') {
      e.preventDefault();
      searchRef.current?.focus();
    } else if (e.key === 'u' || e.key === 'U') {
      setIsUnmappable(v => {
        const next = !v;
        if (next) setSelected([]);
        else setGapReasonCode('');
        return next;
      });
    } else if (e.key === 'Enter' && !e.shiftKey) {
      if (canSubmit) submitMutation.mutate();
    }
  }, [queue.length, canSubmit, submitMutation]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // ── Add a target to selected list ────────────────────────────
  function addTarget(candidate: TargetCandidate) {
    if (selected.some(s => s.targetCode === candidate.targetCode)) return;
    setSelected(prev => [...prev, candidate]);
    setSearchQuery('');
  }

  function removeTarget(code: string) {
    setSelected(prev => prev.filter(s => s.targetCode !== code));
  }

  function updateRelationship(code: string, rel: MappingRelationship) {
    setSelected(prev =>
      prev.map(s => s.targetCode === code ? { ...s, relationshipType: rel } : s)
    );
  }

  // ── Render ────────────────────────────────────────────────────

  if (isLoading) {
    return <p className="text-slate-500 text-sm p-6">Loading your queue…</p>;
  }

  if (queue.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center gap-3 p-8">
        <p className="text-4xl">✅</p>
        <p className="text-lg font-semibold text-slate-700">Queue complete</p>
        <p className="text-sm text-slate-500">No more terms assigned to you for this project.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 gap-0 -m-6">
      {/* ── Left: queue list ───────────────────────────────────── */}
      <aside className="w-64 shrink-0 border-r border-slate-200 bg-white overflow-y-auto flex flex-col">
        {/* Stats bar */}
        {stats && (
          <div className="px-4 py-2 bg-slate-50 border-b border-slate-200 text-xs text-slate-500">
            <span className="font-medium text-slate-700">{Number(stats.completed)}</span> done
            {' / '}
            <span className="font-medium text-slate-700">{Number(stats.assigned)}</span> assigned
            {stats.averageMinutesPerTerm && (
              <> · avg {stats.averageMinutesPerTerm}m/term</>
            )}
          </div>
        )}

        {/* Term list */}
        <div className="flex-1 overflow-y-auto">
          {queue.map((term, i) => (
            <div key={term.assignmentId} onClick={() => setActiveIdx(i)}>
              <TermCard term={term} isActive={i === activeIdx} />
            </div>
          ))}
        </div>

        {/* Keyboard hint */}
        <div className="px-4 py-2 text-xs text-slate-400 border-t border-slate-100">
          ↑↓ navigate · / search · U no match · ↵ confirm
        </div>
      </aside>

      {/* ── Right: mapping workspace ───────────────────────────── */}
      <div className="flex-1 min-w-0 flex flex-col bg-white overflow-hidden">
        {activeTerm && (
          <>
            {/* Source term header */}
            <div className="px-6 py-4 border-b border-slate-200 bg-slate-50">
              <div className="flex items-start justify-between">
                <div>
                  <h2 className="text-xl font-semibold text-slate-900">
                    {activeTerm.displayTerm}
                  </h2>
                  <p className="text-sm text-slate-500 font-mono mt-0.5">
                    {activeTerm.sourceCode}
                  </p>
                </div>
                <div className="text-right text-xs text-slate-400 space-y-0.5">
                  {activeTerm.frequency && (
                    <p>freq: <strong>{activeTerm.frequency.toLocaleString()}</strong></p>
                  )}
                  {activeTerm.clinicalDomain && (
                    <p>domain: <strong>{activeTerm.clinicalDomain}</strong></p>
                  )}
                  <p>
                    {activeIdx + 1} / {queue.length}
                  </p>
                </div>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              {/* ── No SNOMED match toggle ────────────────────── */}
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

                {/* Gap reason selector — shown when toggle is active */}
                {isUnmappable && (
                  <GapReasonSelector
                    value={gapReasonCode}
                    onChange={setGapReasonCode}
                  />
                )}
              </div>

              {/* ── Target search (hidden in gap mode) ───────── */}
              {!isUnmappable && (
                <>
                  {/* Terminology search */}
                  <div>
                    <label className="label">Search target terminology</label>
                    <div className="relative">
                      <input
                        ref={searchRef}
                        className="input pr-10"
                        placeholder="Type to search (/) — free text or code"
                        value={searchQuery}
                        onChange={e => setSearchQuery(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Escape') {
                            setSearchQuery('');
                            searchRef.current?.blur();
                          }
                        }}
                      />
                      {searchQuery && (
                        <button
                          onClick={() => setSearchQuery('')}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                        >
                          ✕
                        </button>
                      )}
                    </div>

                    {/* Search results */}
                    {searchResults.length > 0 && (
                      <ul className="mt-1 border border-slate-200 rounded-md divide-y divide-slate-100 shadow-sm">
                        {searchResults.map(r => (
                          <li
                            key={r.targetCode}
                            className="px-3 py-2 hover:bg-brand-50 cursor-pointer flex items-start justify-between gap-4"
                            onClick={() => addTarget(r)}
                          >
                            <div>
                              <p className="text-sm font-medium text-slate-800">
                                {r.targetDisplay}
                              </p>
                              <p className="text-xs text-slate-400 font-mono">{r.targetCode}</p>
                            </div>
                            <span className="text-xs text-brand-600 shrink-0">+ add</span>
                          </li>
                        ))}
                      </ul>
                    )}

                    {searchQuery.trim().length >= 2 && searchResults.length === 0 && (
                      <p className="text-xs text-slate-400 mt-1 pl-1">
                        No matches in corpus. Try a different term or code.
                      </p>
                    )}
                  </div>

                  {/* AI suggestions (advisory only — NO batch accept) */}
                  {aiSuggestions.length > 0 && (
                    <div>
                      <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">
                        AI suggestions (advisory — review before selecting)
                      </p>
                      <ul className="space-y-1">
                        {aiSuggestions.map(s => (
                          <li
                            key={s.targetCode}
                            className="flex items-center justify-between px-3 py-2 bg-amber-50 border border-amber-200 rounded-md cursor-pointer hover:bg-amber-100"
                            onClick={() => addTarget(s)}
                          >
                            <div>
                              <p className="text-sm text-slate-800">{s.targetDisplay}</p>
                              <p className="text-xs text-slate-400 font-mono">{s.targetCode}</p>
                            </div>
                            <span className="text-xs text-amber-700 shrink-0">+ use</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Selected targets */}
                  {selected.length > 0 && (
                    <div>
                      <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">
                        Selected mappings
                      </p>
                      <ul className="space-y-2">
                        {selected.map(t => (
                          <li
                            key={t.targetCode}
                            className="flex items-start gap-3 px-3 py-2 bg-green-50 border border-green-200 rounded-md"
                          >
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-slate-800 truncate">
                                {t.targetDisplay}
                                {t.isAiSuggestion && (
                                  <span className="ml-2 text-xs text-amber-600">(AI)</span>
                                )}
                              </p>
                              <p className="text-xs text-slate-400 font-mono">{t.targetCode}</p>
                            </div>
                            <RelationshipSelect
                              value={t.relationshipType}
                              onChange={rel => updateRelationship(t.targetCode, rel)}
                            />
                            <button
                              onClick={() => removeTarget(t.targetCode)}
                              className="text-slate-400 hover:text-red-600 text-lg leading-none"
                              title="Remove"
                            >
                              ×
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              )}

              {/* Rationale — required for GAP-06, optional otherwise */}
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
                        : 'Optional: add a mapping rationale or note'
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

            {/* Action footer */}
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
                onClick={() => submitMutation.mutate()}
                disabled={!canSubmit}
              >
                {submitMutation.isPending
                  ? 'Submitting…'
                  : isUnmappable
                    ? `Confirm: No SNOMED match (↵)`
                    : `Confirm mapping (↵)`}
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
