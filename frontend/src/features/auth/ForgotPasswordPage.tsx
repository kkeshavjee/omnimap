// OmniMap — Forgot Password Page
// Step 1: user enters email → Cognito sends a verification code
// Step 2: user enters code + new password → password is reset

import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { resetPassword, confirmResetPassword } from 'aws-amplify/auth';

type Stage = 'email' | 'code';

export default function ForgotPasswordPage() {
  const navigate = useNavigate();

  const [stage,       setStage]       = useState<Stage>('email');
  const [email,       setEmail]       = useState('');
  const [code,        setCode]        = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPw,   setConfirmPw]   = useState('');
  const [error,       setError]       = useState<string | null>(null);
  const [loading,     setLoading]     = useState(false);

  async function handleRequestCode(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await resetPassword({ username: email.toLowerCase() });
      setStage('code');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send reset code');
    } finally {
      setLoading(false);
    }
  }

  async function handleConfirmReset(e: FormEvent) {
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
      await confirmResetPassword({
        username:         email.toLowerCase(),
        confirmationCode: code.trim(),
        newPassword,
      });
      navigate('/login', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset password');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <div className="card w-full max-w-sm p-8">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-slate-900">Reset password</h1>
          <p className="text-sm text-slate-500 mt-1">
            {stage === 'email'
              ? 'Enter your email to receive a reset code'
              : `Code sent to ${email}`}
          </p>
        </div>

        {/* ── Step 1: email ── */}
        {stage === 'email' && (
          <form onSubmit={handleRequestCode} className="space-y-4">
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

            {error && (
              <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
                {error}
              </p>
            )}

            <button type="submit" disabled={loading} className="btn-primary w-full mt-2">
              {loading ? 'Sending…' : 'Send reset code'}
            </button>
          </form>
        )}

        {/* ── Step 2: code + new password ── */}
        {stage === 'code' && (
          <form onSubmit={handleConfirmReset} className="space-y-4">
            <div>
              <label htmlFor="code" className="label">Verification code</label>
              <input
                id="code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                required
                className="input"
                placeholder="6-digit code"
                value={code}
                onChange={e => setCode(e.target.value)}
              />
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
              {loading ? 'Resetting…' : 'Reset password'}
            </button>

            <button
              type="button"
              className="text-sm text-blue-600 hover:underline w-full text-center"
              onClick={() => { setStage('email'); setError(null); }}
            >
              ← Use a different email
            </button>
          </form>
        )}

        <div className="text-center mt-4">
          <Link to="/login" className="text-sm text-slate-500 hover:text-slate-700">
            ← Back to sign in
          </Link>
        </div>
      </div>
    </div>
  );
}
