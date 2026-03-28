// OmniMap — Regex / Qualifier Pattern Library
//
// Administrator-only page for managing the six (+ one) qualifier
// pattern categories.  Supports:
//   • Filter by category
//   • Edit pattern text, action, sort order, label, prefix/suffix in-place
//   • Add a new pattern manually
//   • Soft-delete (deactivate) a pattern
//   • Upload an xlsx file to re-import an entire category
//   • Download current active patterns as xlsx (all or one category)

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  api,
  type QualifierPattern,
  type QualifierCategory,
  type QualifierAction,
  type UpdateQualifierPatternInput,
} from '../../api/client';

// -----------------------------------------------------------------
// Constants
// -----------------------------------------------------------------

const CATEGORIES: { value: QualifierCategory; label: string; description: string }[] = [
  { value: 'negation',           label: 'Negation',           description: 'Rule-out / negation signals  (<exc-ro], <exc-neg])' },
  { value: 'stop_word',          label: 'Stop Word',          description: 'Terms removed from match form (REPLACE_WITH = ^)' },
  { value: 'location',           label: 'Location',           description: 'Anatomical site tags  (<loc] … [loc>)' },
  { value: 'timing',             label: 'Timing',             description: 'Temporal / acuity tags  (<time] … [time>)' },
  { value: 'family_history',     label: 'Family History',     description: 'Family context exclusions  (<exc-fhx])' },
  { value: 'causation',          label: 'Causation',          description: 'Etiology qualifiers  (<cau>)' },
  { value: 'screening', label: 'Screening', description: 'Screening programme management: Exclude FOBT, Abnormal Pap, Overdue mammogram, Positive FIT — not diagnoses' },
];

const ACTION_LABELS: Record<QualifierAction, { label: string; colour: string }> = {
  tag:               { label: 'Tag',              colour: 'bg-blue-100 text-blue-800' },
  ignore:            { label: 'Ignore',           colour: 'bg-amber-100 text-amber-800' },
  detect:            { label: 'Detect',           colour: 'bg-slate-100 text-slate-700' },
  screening: { label: 'Screening', colour: 'bg-purple-100 text-purple-800' },
};

// -----------------------------------------------------------------
// Sub-components
// -----------------------------------------------------------------

function ActionBadge({ action }: { action: QualifierAction }) {
  const { label, colour } = ACTION_LABELS[action] ?? { label: action, colour: 'bg-slate-100 text-slate-700' };
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${colour}`}>
      {label}
    </span>
  );
}

interface EditingState {
  patternText:    string;
  flags:          string;
  replaceWith:    string;
  prefix:         string;
  suffix:         string;
  canonicalLabel: string;
  action:         QualifierAction;
  sortOrder:      string;
}

function patternToEditing(p: QualifierPattern): EditingState {
  return {
    patternText:    p.patternText,
    flags:          p.flags,
    replaceWith:    p.replaceWith ?? '',
    prefix:         p.prefix ?? '',
    suffix:         p.suffix ?? '',
    canonicalLabel: p.canonicalLabel ?? '',
    action:         p.action,
    sortOrder:      String(p.sortOrder),
  };
}

// -----------------------------------------------------------------
// New pattern form (shown at the top of the table when adding)
// -----------------------------------------------------------------

interface NewPatternFormProps {
  category: QualifierCategory;
  onSaved:  (p: QualifierPattern) => void;
  onCancel: () => void;
}

function NewPatternForm({ category, onSaved, onCancel }: NewPatternFormProps) {
  const [form, setForm] = useState<EditingState>({
    patternText: '', flags: 'i', replaceWith: '', prefix: '',
    suffix: '', canonicalLabel: '', action: 'detect', sortOrder: '1000',
  });
  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState<string | null>(null);

  async function handleSave() {
    if (!form.patternText.trim()) { setError('Pattern text is required'); return; }
    setSaving(true);
    setError(null);
    try {
      const saved = await api.qualifierPatterns.create({
        category,
        patternText:    form.patternText.trim(),
        flags:          form.flags || 'i',
        replaceWith:    form.replaceWith  || undefined,
        prefix:         form.prefix       || undefined,
        suffix:         form.suffix       || undefined,
        canonicalLabel: form.canonicalLabel || undefined,
        action:         form.action,
        sortOrder:      parseInt(form.sortOrder) || 1000,
      });
      onSaved(saved);
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <tr className="bg-green-50 border-b border-green-200">
      <td className="px-3 py-2 text-xs text-slate-400 italic">new</td>
      <td className="px-3 py-2">
        <input
          autoFocus
          className="w-full border rounded px-2 py-1 text-xs font-mono"
          placeholder="regex pattern…"
          value={form.patternText}
          onChange={e => setForm(f => ({ ...f, patternText: e.target.value }))}
        />
        {error && <p className="text-red-600 text-xs mt-1">{error}</p>}
      </td>
      <td className="px-3 py-2">
        <input
          className="w-12 border rounded px-2 py-1 text-xs font-mono"
          placeholder="i"
          value={form.flags}
          onChange={e => setForm(f => ({ ...f, flags: e.target.value }))}
        />
      </td>
      <td className="px-3 py-2">
        <input
          className="w-full border rounded px-2 py-1 text-xs font-mono"
          placeholder="^ to delete, text to replace, empty = detect"
          value={form.replaceWith}
          onChange={e => setForm(f => ({ ...f, replaceWith: e.target.value }))}
        />
      </td>
      <td className="px-3 py-2">
        <input
          className="w-full border rounded px-2 py-1 text-xs"
          placeholder="e.g. <loc]"
          value={form.prefix}
          onChange={e => setForm(f => ({ ...f, prefix: e.target.value }))}
        />
      </td>
      <td className="px-3 py-2">
        <input
          className="w-full border rounded px-2 py-1 text-xs"
          placeholder="e.g. [loc>"
          value={form.suffix}
          onChange={e => setForm(f => ({ ...f, suffix: e.target.value }))}
        />
      </td>
      <td className="px-3 py-2">
        <input
          className="w-full border rounded px-2 py-1 text-xs"
          placeholder="human label"
          value={form.canonicalLabel}
          onChange={e => setForm(f => ({ ...f, canonicalLabel: e.target.value }))}
        />
      </td>
      <td className="px-3 py-2">
        <select
          className="border rounded px-2 py-1 text-xs"
          value={form.action}
          onChange={e => setForm(f => ({ ...f, action: e.target.value as QualifierAction }))}
        >
          <option value="tag">Tag</option>
          <option value="ignore">Ignore</option>
          <option value="detect">Detect</option>
          <option value="screening">Screening</option>
        </select>
      </td>
      <td className="px-3 py-2">
        <input
          className="w-16 border rounded px-2 py-1 text-xs"
          value={form.sortOrder}
          onChange={e => setForm(f => ({ ...f, sortOrder: e.target.value }))}
        />
      </td>
      <td className="px-3 py-2 space-x-1 whitespace-nowrap">
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-2 py-1 bg-green-600 text-white rounded text-xs hover:bg-green-700 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          onClick={onCancel}
          className="px-2 py-1 bg-slate-200 text-slate-700 rounded text-xs hover:bg-slate-300"
        >
          Cancel
        </button>
      </td>
    </tr>
  );
}

// -----------------------------------------------------------------
// Pattern row (view + inline edit)
// -----------------------------------------------------------------

interface PatternRowProps {
  pattern:   QualifierPattern;
  onUpdated: (p: QualifierPattern) => void;
  onDeleted: (id: string) => void;
}

function PatternRow({ pattern, onUpdated, onDeleted }: PatternRowProps) {
  const [editing, setEditing]   = useState(false);
  const [form,    setForm]      = useState<EditingState>(patternToEditing(pattern));
  const [saving,  setSaving]    = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error,   setError]     = useState<string | null>(null);

  function handleEdit() {
    setForm(patternToEditing(pattern));
    setEditing(true);
    setError(null);
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const payload: UpdateQualifierPatternInput = {
        patternText:    form.patternText.trim(),
        flags:          form.flags || 'i',
        replaceWith:    form.replaceWith  || undefined,
        prefix:         form.prefix       || undefined,
        suffix:         form.suffix       || undefined,
        canonicalLabel: form.canonicalLabel || undefined,
        action:         form.action,
        sortOrder:      parseInt(form.sortOrder) || 1000,
      };
      const updated = await api.qualifierPatterns.update(pattern.id, payload);
      onUpdated(updated);
      setEditing(false);
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!confirm('Deactivate this pattern? It will no longer be applied but history is preserved.')) return;
    setDeleting(true);
    try {
      await api.qualifierPatterns.remove(pattern.id);
      onDeleted(pattern.id);
    } catch (e: unknown) {
      alert((e as Error).message);
    } finally {
      setDeleting(false);
    }
  }

  const rowBg = pattern.isActive ? 'bg-white hover:bg-slate-50' : 'bg-slate-50 opacity-60';

  if (editing) {
    return (
      <tr className="bg-yellow-50 border-b border-yellow-200">
        <td className="px-3 py-2 text-xs text-slate-400">{pattern.sortOrder}</td>
        <td className="px-3 py-2">
          <input
            autoFocus
            className="w-full border rounded px-2 py-1 text-xs font-mono"
            value={form.patternText}
            onChange={e => setForm(f => ({ ...f, patternText: e.target.value }))}
          />
          {error && <p className="text-red-600 text-xs mt-1">{error}</p>}
        </td>
        <td className="px-3 py-2">
          <input
            className="w-12 border rounded px-2 py-1 text-xs font-mono"
            value={form.flags}
            onChange={e => setForm(f => ({ ...f, flags: e.target.value }))}
          />
        </td>
        <td className="px-3 py-2">
          <input
            className="w-full border rounded px-2 py-1 text-xs font-mono"
            value={form.replaceWith}
            onChange={e => setForm(f => ({ ...f, replaceWith: e.target.value }))}
          />
        </td>
        <td className="px-3 py-2">
          <input
            className="w-full border rounded px-2 py-1 text-xs"
            value={form.prefix}
            onChange={e => setForm(f => ({ ...f, prefix: e.target.value }))}
          />
        </td>
        <td className="px-3 py-2">
          <input
            className="w-full border rounded px-2 py-1 text-xs"
            value={form.suffix}
            onChange={e => setForm(f => ({ ...f, suffix: e.target.value }))}
          />
        </td>
        <td className="px-3 py-2">
          <input
            className="w-full border rounded px-2 py-1 text-xs"
            value={form.canonicalLabel}
            onChange={e => setForm(f => ({ ...f, canonicalLabel: e.target.value }))}
          />
        </td>
        <td className="px-3 py-2">
          <select
            className="border rounded px-2 py-1 text-xs"
            value={form.action}
            onChange={e => setForm(f => ({ ...f, action: e.target.value as QualifierAction }))}
          >
            <option value="tag">Tag</option>
            <option value="ignore">Ignore</option>
            <option value="detect">Detect</option>
            <option value="screening">Screening</option>
          </select>
        </td>
        <td className="px-3 py-2">
          <input
            className="w-16 border rounded px-2 py-1 text-xs"
            value={form.sortOrder}
            onChange={e => setForm(f => ({ ...f, sortOrder: e.target.value }))}
          />
        </td>
        <td className="px-3 py-2 space-x-1 whitespace-nowrap">
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-2 py-1 bg-brand-600 text-white rounded text-xs hover:bg-brand-700 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            onClick={() => setEditing(false)}
            className="px-2 py-1 bg-slate-200 text-slate-700 rounded text-xs hover:bg-slate-300"
          >
            Cancel
          </button>
        </td>
      </tr>
    );
  }

  return (
    <tr className={`${rowBg} border-b border-slate-100 text-sm`}>
      <td className="px-3 py-2 text-xs text-slate-400 font-mono">{pattern.sortOrder}</td>
      <td className="px-3 py-2 font-mono text-xs max-w-xs break-all">{pattern.patternText}</td>
      <td className="px-3 py-2 font-mono text-xs text-slate-500">{pattern.flags}</td>
      <td className="px-3 py-2 font-mono text-xs text-slate-500">{pattern.replaceWith ?? ''}</td>
      <td className="px-3 py-2 text-xs text-slate-500">{pattern.prefix ?? ''}</td>
      <td className="px-3 py-2 text-xs text-slate-500">{pattern.suffix ?? ''}</td>
      <td className="px-3 py-2 text-xs text-slate-600">{pattern.canonicalLabel ?? ''}</td>
      <td className="px-3 py-2"><ActionBadge action={pattern.action} /></td>
      <td className="px-3 py-2 text-xs text-slate-400 font-mono">v{pattern.version}</td>
      <td className="px-3 py-2 space-x-1 whitespace-nowrap">
        {pattern.isActive && (
          <>
            <button
              onClick={handleEdit}
              className="px-2 py-1 border border-slate-300 rounded text-xs hover:bg-slate-100"
            >
              Edit
            </button>
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="px-2 py-1 border border-red-200 text-red-600 rounded text-xs hover:bg-red-50 disabled:opacity-50"
            >
              {deleting ? '…' : 'Deactivate'}
            </button>
          </>
        )}
        {!pattern.isActive && (
          <span className="text-xs text-slate-400 italic">inactive</span>
        )}
      </td>
    </tr>
  );
}

// -----------------------------------------------------------------
// Main page
// -----------------------------------------------------------------

export default function RegexLibraryPage() {
  const [selectedCategory, setSelectedCategory] = useState<QualifierCategory | ''>('');
  const [showInactive,     setShowInactive]      = useState(false);
  const [patterns,         setPatterns]          = useState<QualifierPattern[]>([]);
  const [loading,          setLoading]           = useState(false);
  const [error,            setError]             = useState<string | null>(null);
  const [addingNew,        setAddingNew]         = useState(false);

  // Import state
  const [importing,        setImporting]         = useState(false);
  const [importCat,        setImportCat]         = useState<QualifierCategory | ''>('');
  const [importResult,     setImportResult]      = useState<string | null>(null);
  const [importError,      setImportError]       = useState<string | null>(null);
  const fileInputRef                             = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.qualifierPatterns.list({
        category:        selectedCategory || undefined,
        includeInactive: showInactive,
      });
      setPatterns(data);
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [selectedCategory, showInactive]);

  useEffect(() => { void load(); }, [load]);

  function handlePatternUpdated(updated: QualifierPattern) {
    setPatterns(ps => ps.map(p => p.id === updated.id ? updated : p));
  }

  function handlePatternDeleted(id: string) {
    setPatterns(ps => showInactive
      ? ps.map(p => p.id === id ? { ...p, isActive: false } : p)
      : ps.filter(p => p.id !== id),
    );
  }

  function handleNewSaved(p: QualifierPattern) {
    setPatterns(ps => [p, ...ps]);
    setAddingNew(false);
  }

  async function handleImport() {
    const file = fileInputRef.current?.files?.[0];
    if (!file)     { setImportError('Choose an xlsx file'); return; }
    if (!importCat){ setImportError('Choose a category');   return; }

    setImporting(true);
    setImportError(null);
    setImportResult(null);
    try {
      const result = await api.qualifierPatterns.import(importCat, file);
      setImportResult(
        `Done: ${result.inserted} patterns inserted, ${result.deactivated} deactivated (${result.sourceFile})`,
      );
      if (fileInputRef.current) fileInputRef.current.value = '';
      void load();   // refresh the table
    } catch (e: unknown) {
      setImportError((e as Error).message);
    } finally {
      setImporting(false);
    }
  }

  // Group counts for header pills
  const counts = patterns.reduce<Record<string, number>>((acc, p) => {
    acc[p.category] = (acc[p.category] ?? 0) + 1;
    return acc;
  }, {});

  const displayCategory = selectedCategory || null;
  const catInfo = CATEGORIES.find(c => c.value === displayCategory);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-xl font-semibold text-slate-800">Regex / Qualifier Pattern Library</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            OmniMap is the authoritative store. Edit patterns here; export to xlsx for external use.
          </p>
        </div>
        <a
          href={api.qualifierPatterns.exportUrl(selectedCategory || undefined)}
          download
          className="px-4 py-2 bg-brand-600 text-white rounded text-sm hover:bg-brand-700"
        >
          Export xlsx {selectedCategory ? `(${selectedCategory})` : '(all)'}
        </a>
      </div>

      {/* Category pills */}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => { setSelectedCategory(''); setAddingNew(false); }}
          className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${
            selectedCategory === ''
              ? 'bg-brand-600 text-white border-brand-600'
              : 'bg-white text-slate-600 border-slate-300 hover:border-brand-400'
          }`}
        >
          All ({patterns.length})
        </button>
        {CATEGORIES.map(cat => (
          <button
            key={cat.value}
            onClick={() => { setSelectedCategory(cat.value); setAddingNew(false); }}
            title={cat.description}
            className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${
              selectedCategory === cat.value
                ? 'bg-brand-600 text-white border-brand-600'
                : 'bg-white text-slate-600 border-slate-300 hover:border-brand-400'
            }`}
          >
            {cat.label} {counts[cat.value] !== undefined ? `(${counts[cat.value]})` : ''}
          </button>
        ))}
      </div>

      {/* Category description */}
      {catInfo && (
        <div className="bg-blue-50 border border-blue-200 rounded px-4 py-2 text-sm text-blue-700">
          {catInfo.description}
        </div>
      )}

      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={e => setShowInactive(e.target.checked)}
          />
          Show inactive patterns
        </label>
        {selectedCategory && (
          <button
            onClick={() => setAddingNew(true)}
            disabled={addingNew}
            className="px-3 py-1.5 bg-green-600 text-white rounded text-sm hover:bg-green-700 disabled:opacity-50"
          >
            + Add pattern
          </button>
        )}
      </div>

      {/* Import panel */}
      <details className="border border-slate-200 rounded">
        <summary className="px-4 py-3 cursor-pointer text-sm font-medium text-slate-700 hover:bg-slate-50">
          Import from xlsx (re-imports one category, deactivates existing patterns for that file)
        </summary>
        <div className="px-4 pb-4 pt-2 space-y-3">
          <div className="flex items-end gap-3 flex-wrap">
            <div>
              <label className="block text-xs text-slate-500 mb-1">Category</label>
              <select
                className="border rounded px-3 py-1.5 text-sm"
                value={importCat}
                onChange={e => setImportCat(e.target.value as QualifierCategory)}
              >
                <option value="">— select —</option>
                {CATEGORIES.map(c => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">xlsx file</label>
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx"
                className="border rounded px-2 py-1 text-sm"
              />
            </div>
            <button
              onClick={handleImport}
              disabled={importing}
              className="px-4 py-1.5 bg-brand-600 text-white rounded text-sm hover:bg-brand-700 disabled:opacity-50"
            >
              {importing ? 'Importing…' : 'Import'}
            </button>
          </div>
          {importResult && (
            <p className="text-sm text-green-700 bg-green-50 rounded px-3 py-2">{importResult}</p>
          )}
          {importError && (
            <p className="text-sm text-red-600 bg-red-50 rounded px-3 py-2">{importError}</p>
          )}
          <p className="text-xs text-slate-400">
            Expected columns: REGEX, REPLACE_WITH, Prefix, Suffix, Text (or TERM).
            The first detected sheet will be used.
            Action is derived from the Prefix cell: starts with &lt; → tag, "ignore" → ignore,
            "exclude" or "screening" → screening, empty → detect.
          </p>
        </div>
      </details>

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded px-4 py-3 text-sm text-red-700">
          {error}
          <button onClick={load} className="ml-3 underline">Retry</button>
        </div>
      )}

      {/* Pattern table */}
      {loading ? (
        <p className="text-sm text-slate-400 py-8 text-center">Loading patterns…</p>
      ) : (
        <div className="overflow-x-auto rounded border border-slate-200">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200 text-xs text-slate-500 uppercase tracking-wide">
              <tr>
                <th className="px-3 py-2 text-left w-16">Order</th>
                <th className="px-3 py-2 text-left">Regex Pattern</th>
                <th className="px-3 py-2 text-left w-14">Flags</th>
                <th className="px-3 py-2 text-left">Replace With</th>
                <th className="px-3 py-2 text-left">Prefix</th>
                <th className="px-3 py-2 text-left">Suffix</th>
                <th className="px-3 py-2 text-left">Label</th>
                <th className="px-3 py-2 text-left">Action</th>
                <th className="px-3 py-2 text-left w-12">Ver.</th>
                <th className="px-3 py-2 text-left w-32">Controls</th>
              </tr>
            </thead>
            <tbody>
              {addingNew && selectedCategory && (
                <NewPatternForm
                  category={selectedCategory}
                  onSaved={handleNewSaved}
                  onCancel={() => setAddingNew(false)}
                />
              )}
              {patterns.length === 0 && !addingNew && (
                <tr>
                  <td colSpan={10} className="px-4 py-8 text-center text-slate-400 text-sm">
                    No patterns found.
                    {selectedCategory
                      ? ' Import an xlsx file or add a pattern manually above.'
                      : ' Select a category to begin.'}
                  </td>
                </tr>
              )}
              {patterns.map(p => (
                <PatternRow
                  key={p.id}
                  pattern={p}
                  onUpdated={handlePatternUpdated}
                  onDeleted={handlePatternDeleted}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Footer hint */}
      <p className="text-xs text-slate-400">
        {patterns.filter(p => p.isActive).length} active pattern{patterns.filter(p => p.isActive).length !== 1 ? 's' : ''} shown.
        Deactivated patterns are preserved in version history and never permanently deleted.
      </p>
    </div>
  );
}
