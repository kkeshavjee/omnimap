// Renders children only when the signed-in user holds one of the allowed roles.
// Redirects to /login if unauthenticated; shows 403 if wrong role.

import { Navigate } from 'react-router-dom';
import { useAuth, type UserRole } from '../../contexts/AuthContext';

interface Props {
  roles:    UserRole[];
  children: React.ReactNode;
}

export default function RequireRole({ roles, children }: Props) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen text-slate-500 text-sm">
        Loading…
      </div>
    );
  }

  if (!user) return <Navigate to="/login" replace />;

  if (!roles.includes(user.role)) {
    return (
      <div className="flex flex-col items-center justify-center h-screen gap-2 text-center">
        <p className="text-4xl">🚫</p>
        <p className="text-lg font-semibold text-slate-700">Access denied</p>
        <p className="text-sm text-slate-500">
          Your role <strong>{user.role}</strong> is not authorised for this page.
        </p>
      </div>
    );
  }

  return <>{children}</>;
}
