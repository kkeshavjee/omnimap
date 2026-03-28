// OmniMap — Login Page

import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';

type Stage = 'credentials' | 'new-password';

export default function LoginPage() {
  const { login, completeNewPassword, user } = useAuth();
  const navigate = useNavigate();

  const [stage,       setStage]       = useState<Stage>('credentials');
  const [email,       setEmail]       = useState('');
  const [password,    setPassword]    = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPw,   setConfirmPw]   = useState('');
  const [error,       setError]       = useState<string | null>(null);
  const [loading,     setLoading]     = useState(false);

  // If already signed in, redirect to the appropriate landing page
  if (user) {
    const dest =
      user.role === 'administrator' ? '/admin/projects' :
      user.role === 'reviewer'      ? '/reviewer/queue' :
      user.role === 'adjudicator'   ? '/adjudicator'    :
                                      '/audit';
    navigate(dest, { replace: true });
    return null;
  }

  async function handleCredentials(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const nextStep = await login(email, password);
      if (nextStep === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED') {
        setStage('new-password');
        setPassword('');
      }
      // If DONE, AuthContext sets user and the redirect above fires on re-render
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
    } finally {
      setLoading(false);
    }
  }

  async function handleNewPassword(e: FormEvent) {
    e.preventDefault();
    if (newPassword !== confirmPw) {
      setError('Passwords do not match');
      return;
    }
    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    setError(null);
    setLoading(true);
    try {
      await completeNewPassword(newPassword);
      // AuthContext sets user after completeNewPassword; redirect fires on re-render
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to set new password');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <div className="card w-full max-w-sm p-8">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-slate-900">OmniMap</h1>
          <p className="text-sm text-slate-500 mt-1">Clinical Terminology Mapping Platform</p>
        </div>

        {/* ── Credentials form ── */}
        {stage === 'credentials' && (
          <form onSubmit={handleCredentials} className="space-y-4">
            <div>
              <label htmlFor="email" className="label">Email</label>
              <input
                id="email"
                type="email"
                autoComplete="username"
                required
                className="input"
                value={email}
                onChange={e => setEmail(e.target.value)}
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label htmlFor="password" className="label mb-0">Password</label>
                <Link
                  to="/forgot-password"
                  className="text-xs text-blue-600 hover:text-blue-700"
                >
                  Forgot password?
                </Link>
              </div>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                className="input"
                value={password}
                onChange={e => setPassword(e.target.value)}
              />
            </div>

            {error && (
              <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
                {error}
              </p>
            )}

            <button type="submit" disabled={loading} className="btn-primary w-full mt-2">
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        )}

        {/* ── New password required (first login with temp password) ── */}
        {stage === 'new-password' && (
          <form onSubmit={handleNewPassword} className="space-y-4">
            <div className="text-sm text-slate-600 bg-blue-50 border border-blue-200 rounded px-3 py-2">
              Welcome! Please set a permanent password to continue.
            </div>

            <div>
              <label htmlFor="new-password" className="label">New password</label>
              <input
                id="new-password"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                className="input"
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
              />
            </div>

            <div>
              <label htmlFor="confirm-password" className="label">Confirm new password</label>
              <input
                id="confirm-password"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                className="input"
                value={confirmPw}
                onChange={e => setConfirmPw(e.target.value)}
              />
            </div>

            {error && (
              <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
                {error}
              </p>
            )}

            <button type="submit" disabled={loading} className="btn-primary w-full mt-2">
              {loading ? 'Setting password…' : 'Set password & sign in'}
            </button>
          </form>
        )}

        <p className="text-xs text-center text-slate-400 mt-6">
          OHN Confidential — Authorised users only
        </p>
      </div>
    </div>
  );
}
