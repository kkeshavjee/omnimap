// OmniMap — Root application with auth provider + routing

import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth }    from './contexts/AuthContext';
import RequireRole                  from './components/layout/RequireRole';
import AppShell                     from './components/layout/AppShell';
import LoginPage                    from './features/auth/LoginPage';
import ForgotPasswordPage           from './features/auth/ForgotPasswordPage';
import ProjectsPage                 from './features/admin/ProjectsPage';
import ProjectDetailPage            from './features/admin/ProjectDetailPage';
import MapWorkspace                 from './features/reviewer/MapWorkspace';
import ReviewerProjectSelect        from './features/reviewer/ReviewerProjectSelect';
import AdjudicatorWorkspace         from './features/adjudicator/AdjudicatorWorkspace';
import AuditLogPage                 from './features/audit/AuditLogPage';
import RegexLibraryPage            from './features/admin/RegexLibraryPage';
import UsersPage                   from './features/admin/UsersPage';

// Smart default redirect after login
function HomeRedirect() {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user)   return <Navigate to="/login" replace />;
  if (user.role === 'administrator') return <Navigate to="/admin/projects" replace />;
  if (user.role === 'reviewer')      return <Navigate to="/reviewer/queue" replace />;
  if (user.role === 'adjudicator')   return <Navigate to="/adjudicator" replace />;
  return <Navigate to="/audit" replace />;
}


function AppRoutes() {
  return (
    <Routes>
      {/* Public */}
      <Route path="/login"           element={<LoginPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/"                element={<HomeRedirect />} />

      {/* Admin */}
      <Route
        path="/admin/projects"
        element={
          <RequireRole roles={['administrator']}>
            <AppShell><ProjectsPage /></AppShell>
          </RequireRole>
        }
      />
      <Route
        path="/admin/projects/:id"
        element={
          <RequireRole roles={['administrator']}>
            <AppShell><ProjectDetailPage /></AppShell>
          </RequireRole>
        }
      />

      {/* Reviewer */}
      <Route
        path="/reviewer/queue"
        element={
          <RequireRole roles={['reviewer', 'administrator']}>
            <AppShell><ReviewerProjectSelect /></AppShell>
          </RequireRole>
        }
      />
      <Route
        path="/reviewer/:projectId/map"
        element={
          <RequireRole roles={['reviewer', 'administrator']}>
            <AppShell><MapWorkspace /></AppShell>
          </RequireRole>
        }
      />

      {/* Adjudicator */}
      <Route
        path="/adjudicator/:projectId"
        element={
          <RequireRole roles={['adjudicator', 'administrator']}>
            <AppShell><AdjudicatorWorkspace /></AppShell>
          </RequireRole>
        }
      />
      <Route
        path="/adjudicator"
        element={
          <RequireRole roles={['adjudicator', 'administrator']}>
            <AppShell><ReviewerProjectSelect /></AppShell>
          </RequireRole>
        }
      />

      {/* Audit log */}
      <Route
        path="/audit"
        element={
          <RequireRole roles={['administrator', 'auditor']}>
            <AppShell><AuditLogPage /></AppShell>
          </RequireRole>
        }
      />

      {/* Regex / Qualifier Pattern Library (admin only) */}
      <Route
        path="/admin/regex-library"
        element={
          <RequireRole roles={['administrator']}>
            <AppShell><RegexLibraryPage /></AppShell>
          </RequireRole>
        }
      />

      {/* User management (admin only) */}
      <Route
        path="/admin/users"
        element={
          <RequireRole roles={['administrator']}>
            <AppShell><UsersPage /></AppShell>
          </RequireRole>
        }
      />

      {/* 404 */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </AuthProvider>
  );
}
