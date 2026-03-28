// OmniMap — User Management Page (Administrator only)
//
// Invite new users, change roles, deactivate / reactivate accounts.
// Every action touches BOTH Cognito (credentials) and the DB (foreign keys).

import { useState, useEffect, useCallback } from 'react';
import { api, type OmniMapUser, type UserRole, type InviteUserInput } from '../../api/client';

// -----------------------------------------------------------------
// Constants
// -----------------------------------------------------------------

const ROLES: { value: UserRole; label: string; description: string }[] = [
  { value: 'administrator', label: 'Administrator', description: 'Full access — projects, users, audit, regex library' },
  { value: 'reviewer',      label: 'Reviewer',      description: 'Maps terms in assigned projects' },
  { value: 'adjudicator',   label: 'Adjudicator',   description: 'Resolves reviewer disagreements (requires MFA)' },
  { value: 'auditor',       label: 'Auditor',        description: 'Read-only access to audit log' },
];

const ROLE_COLOURS: Record<UserRole, string> = {
  administrator: 'bg-red-100 text-red-800',
  adjudicator:   'bg-amber-100 text-amber-800',
  reviewer:      'bg-blue-100 text-blue-800',
  auditor:       'bg-slate-100 text-slate-600',
};

function RoleBadge({ role }: { role: UserRole }) {
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium capitalize ${ROLE_COLOURS[role]}`}>
      {role}
    </span>
  );
}

// -----------------------------------------------------------------
// Invite form
// -----------------------------------------------------------------

interface InviteFormProps {
  onInvited: (u: OmniMapUser) => void;
}

function InviteForm({ onInvited }: InviteFormProps) {
  const [form,    setForm]    = useState<InviteUserInput>({ email: '', displayName: '', role: 'reviewer' });
  const [saving,  setSaving]  = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.email.trim() || !form.displayName.trim()) {
      setError('Email and display name are required');
      return;
    }
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const user = await api.users.invite(form);
      onInvited(user);
      setSuccess(`Invitation sent to ${user.email}. They will receive a temporary password by email.`);
      setForm({ email: '', displayName: '', role: 'reviewer' });
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
      <h3 className="font-semibold text-slate-700">Invite a new user</h3>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Email address</label>
          <input
            type="email"
            required
            className="w-full border rounded px-3 py-2 text-sm"
            placeholder="user@hospital.ca"
            value={form.email}
            onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Display name</label>
          <input
            type="text"
            required
            className="w-full border rounded px-3 py-2 text-sm"
            placeholder="Dr. Jane Smith"
            value={form.displayName}
            onChange={e => setForm(f => ({ ...f, displayName: e.target.value }))}
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Role</label>
          <select
            className="w-full border rounded px-3 py-2 text-sm"
            value={form.role}
            onChange={e => setForm(f => ({ ...f, role: e.target.value as UserRole }))}
          >
            {ROLES.map(r => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Role description hint */}
      <p className="text-xs text-slate-400">
        {ROLES.find(r => r.value === form.role)?.description}
      </p>

      {error   && <p className="text-sm text-red-600 bg-red-50 rounded px-3 py-2">{error}</p>}
      {success && <p className="text-sm text-green-700 bg-green-50 rounded px-3 py-2">{success}</p>}

      <button
        type="submit"
        disabled={saving}
        className="px-5 py-2 bg-brand-600 text-white rounded text-sm hover:bg-brand-700 disabled:opacity-50"
      >
        {saving ? 'Sending invite…' : 'Send invitation'}
      </button>

      <p className="text-xs text-slate-400">
        Cognito will email a temporary password. The user must change it on first login.
        Administrators and adjudicators are required to enable MFA before they can access those features.
      </p>
    </form>
  );
}

// -----------------------------------------------------------------
// Inline edit row
// -----------------------------------------------------------------

interface UserRowProps {
  user:        OmniMapUser;
  currentUserId: string | null;
  onUpdated:   (u: OmniMapUser) => void;
  onToggled:   (id: string, isActive: boolean) => void;
}

function UserRow({ user, currentUserId, onUpdated, onToggled }: UserRowProps) {
  const [editing,    setEditing]    = useState(false);
  const [editName,   setEditName]   = useState(user.displayName);
  const [editRole,   setEditRole]   = useState<UserRole>(user.role);
  const [saving,     setSaving]     = useState(false);
  const [toggling,   setToggling]   = useState(false);
  const [error,      setError]      = useState<string | null>(null);

  const isSelf = currentUserId === user.id;

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const updated = await api.users.update(user.id, {
        displayName: editName.trim() || undefined,
        role:        editRole !== user.role ? editRole : undefined,
      });
      onUpdated(updated);
      setEditing(false);
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleToggle() {
    const action = user.isActive ? 'deactivate' : 'reactivate';
    const confirm_msg = user.isActive
      ? `Deactivate ${user.email}? They will be locked out immediately.`
      : `Reactivate ${user.email}? They will be able to log in again.`;
    if (!confirm(confirm_msg)) return;

    setToggling(true);
    try {
      if (user.isActive) {
        await api.users.deactivate(user.id);
        onToggled(user.id, false);
      } else {
        await api.users.reactivate(user.id);
        onToggled(user.id, true);
      }
    } catch (e: unknown) {
      alert((e as Error).message);
    } finally {
      setToggling(false);
    }
  }

  const rowBg = user.isActive ? 'bg-white' : 'bg-slate-50 opacity-60';

  if (editing) {
    return (
      <tr className="bg-yellow-50 border-b border-yellow-200">
        <td className="px-4 py-3">
          <input
            autoFocus
            className="w-full border rounded px-2 py-1 text-sm"
            value={editName}
            onChange={e => setEditName(e.target.value)}
          />
          {error && <p className="text-red-600 text-xs mt-1">{error}</p>}
        </td>
        <td className="px-4 py-3 text-sm text-slate-500">{user.email}</td>
        <td className="px-4 py-3">
          <select
            className="border rounded px-2 py-1 text-sm"
            value={editRole}
            onChange={e => setEditRole(e.target.value as UserRole)}
          >
            {ROLES.map(r => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
        </td>
        <td className="px-4 py-3 text-sm text-slate-400">{user.mfaEnabled ? '✓ MFA' : '—'}</td>
        <td className="px-4 py-3 space-x-2 whitespace-nowrap">
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-3 py-1 bg-brand-600 text-white rounded text-xs hover:bg-brand-700 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            onClick={() => { setEditing(false); setEditName(user.displayName); setEditRole(user.role); }}
            className="px-3 py-1 bg-slate-200 text-slate-700 rounded text-xs hover:bg-slate-300"
          >
            Cancel
          </button>
        </td>
      </tr>
    );
  }

  return (
    <tr className={`${rowBg} border-b border-slate-100`}>
      <td className="px-4 py-3 text-sm font-medium text-slate-800">
        {user.displayName}
        {isSelf && <span className="ml-2 text-xs text-slate-400">(you)</span>}
      </td>
      <td className="px-4 py-3 text-sm text-slate-500">{user.email}</td>
      <td className="px-4 py-3"><RoleBadge role={user.role} /></td>
      <td className="px-4 py-3 text-sm text-slate-400">
        {user.mfaEnabled
          ? <span className="text-green-600 text-xs font-medium">✓ MFA</span>
          : <span className="text-slate-400 text-xs">—</span>
        }
      </td>
      <td className="px-4 py-3 space-x-2 whitespace-nowrap">
        <button
          onClick={() => setEditing(true)}
          className="px-3 py-1 border border-slate-300 rounded text-xs hover:bg-slate-100"
        >
          Edit
        </button>
        {!isSelf && (
          <button
            onClick={handleToggle}
            disabled={toggling}
            className={`px-3 py-1 rounded text-xs disabled:opacity-50 ${
              user.isActive
                ? 'border border-red-200 text-red-600 hover:bg-red-50'
                : 'border border-green-200 text-green-700 hover:bg-green-50'
            }`}
          >
            {toggling ? '…' : user.isActive ? 'Deactivate' : 'Reactivate'}
          </button>
        )}
      </td>
    </tr>
  );
}

// -----------------------------------------------------------------
// Main page
// -----------------------------------------------------------------

export default function UsersPage() {
  const [users,   setUsers]   = useState<OmniMapUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);

  // Get current user ID from local storage / context is tricky here;
  // we'll pass null and just skip the self-lock when we don't know
  const currentUserId: string | null = null;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.users.list();
      setUsers(data);
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function handleInvited(u: OmniMapUser) {
    setUsers(prev => [...prev, u].sort((a, b) => a.email.localeCompare(b.email)));
  }

  function handleUpdated(updated: OmniMapUser) {
    setUsers(prev => prev.map(u => u.id === updated.id ? updated : u));
  }

  function handleToggled(id: string, isActive: boolean) {
    setUsers(prev => prev.map(u => u.id === id ? { ...u, isActive } : u));
  }

  const visible = users.filter(u => showInactive || u.isActive);

  const counts = {
    total:    users.length,
    active:   users.filter(u => u.isActive).length,
    byRole:   ROLES.map(r => ({ ...r, count: users.filter(u => u.role === r.value && u.isActive).length })),
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-xl font-semibold text-slate-800">User Management</h2>
        <p className="text-sm text-slate-500 mt-0.5">
          Invite users, change roles, and manage access.
          All changes sync to both Cognito (authentication) and the OmniMap database.
        </p>
      </div>

      {/* Summary pills */}
      <div className="flex flex-wrap gap-3">
        <div className="bg-slate-100 rounded-lg px-4 py-2 text-center">
          <p className="text-lg font-bold text-slate-800">{counts.active}</p>
          <p className="text-xs text-slate-500">Active users</p>
        </div>
        {counts.byRole.map(r => (
          <div key={r.value} className="bg-white border border-slate-200 rounded-lg px-4 py-2 text-center">
            <p className="text-lg font-bold text-slate-700">{r.count}</p>
            <p className="text-xs text-slate-500">{r.label}s</p>
          </div>
        ))}
      </div>

      {/* Invite form */}
      <InviteForm onInvited={handleInvited} />

      {/* Role reference */}
      <details className="border border-slate-200 rounded">
        <summary className="px-4 py-3 cursor-pointer text-sm font-medium text-slate-700 hover:bg-slate-50">
          Role permissions reference
        </summary>
        <div className="px-4 pb-4 pt-2">
          <table className="min-w-full text-sm">
            <thead className="text-xs text-slate-500 uppercase">
              <tr>
                <th className="text-left py-1 pr-4">Role</th>
                <th className="text-left py-1 pr-4">MFA required</th>
                <th className="text-left py-1">Access</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {[
                { role: 'administrator', mfa: 'Yes', access: 'All pages, user management, regex library, audit log' },
                { role: 'adjudicator',   mfa: 'Yes', access: 'Adjudication workspace, reviewer queue' },
                { role: 'reviewer',      mfa: 'No',  access: 'Reviewer queue and mapping workspace' },
                { role: 'auditor',       mfa: 'No',  access: 'Audit log (read-only)' },
              ].map(r => (
                <tr key={r.role}>
                  <td className="py-2 pr-4"><RoleBadge role={r.role as UserRole} /></td>
                  <td className="py-2 pr-4 text-slate-500">{r.mfa}</td>
                  <td className="py-2 text-slate-600">{r.access}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      {/* User table */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-medium text-slate-700">
            {counts.active} active user{counts.active !== 1 ? 's' : ''}
            {users.length > counts.active ? ` (${users.length - counts.active} inactive)` : ''}
          </h3>
          <label className="flex items-center gap-2 text-sm text-slate-500">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={e => setShowInactive(e.target.checked)}
            />
            Show inactive
          </label>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded px-4 py-3 text-sm text-red-700 mb-4">
            {error}
            <button onClick={load} className="ml-3 underline">Retry</button>
          </div>
        )}

        {loading ? (
          <p className="text-sm text-slate-400 py-8 text-center">Loading users…</p>
        ) : (
          <div className="overflow-x-auto rounded border border-slate-200">
            <table className="min-w-full">
              <thead className="bg-slate-50 border-b border-slate-200 text-xs text-slate-500 uppercase tracking-wide">
                <tr>
                  <th className="px-4 py-2 text-left">Name</th>
                  <th className="px-4 py-2 text-left">Email</th>
                  <th className="px-4 py-2 text-left">Role</th>
                  <th className="px-4 py-2 text-left">MFA</th>
                  <th className="px-4 py-2 text-left">Actions</th>
                </tr>
              </thead>
              <tbody>
                {visible.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-slate-400 text-sm">
                      No users found. Use the invite form above to add your first reviewer.
                    </td>
                  </tr>
                ) : (
                  visible.map(u => (
                    <UserRow
                      key={u.id}
                      user={u}
                      currentUserId={currentUserId}
                      onUpdated={handleUpdated}
                      onToggled={handleToggled}
                    />
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="text-xs text-slate-400">
        Deactivated accounts are never deleted — all mapping history is preserved.
        To permanently remove a user, contact your AWS administrator to delete them from Cognito.
      </p>
    </div>
  );
}
