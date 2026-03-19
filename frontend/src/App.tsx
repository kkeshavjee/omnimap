// OmniMap — Root application with auth provider + routing

import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth }    from './contexts/AuthContext';
import RequireRole                  from './components/layout/RequireRole';
import AppShell                     from './components/layout/AppShell';
import LoginPage                    from './features/auth/LoginPage';
import ProjectsPage                 from './features/admin/ProjectsPage';
import ProjectDetailPage            from './features/admin/ProjectDetailPage';
import MapWorkspace                 from './features/reviewer/MapWorkspace';

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

// Placeholder pages for future phases
function ComingSoon({ page }: { page: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center gap-2 p-8">
      <p className="text-4xl">🚧</p>
      <p className="text-lg font-semibold text-slate-700">{page}</p>
      <p className="text-sm text-slate-500">Coming in a future phase.</p>
    </div>
  );
}

function AppRoutes() {
  return (
    <Routes>
      {/* Public */}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/"      element={<HomeRedirect />} />

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
          <RequireRole roles={['reviewer']}>
            <AppShell>
              <ComingSoon page="Select a project to open your queue" />
            </AppShell>
          </RequireRole>
        }
      />
      <Route
        path="/reviewer/:projectId/map"
        element={
          <RequireRole roles={['reviewer']}>
            <AppShell><MapWorkspace /></AppShell>
          </RequireRole>
        }
      />

      {/* Adjudicator — Phase D */}
      <Route
        path="/adjudicator/*"
        element={
          <RequireRole roles={['adjudicator']}>
            <AppShell><ComingSoon page="Adjudication workspace — Phase D" /></AppShell>
          </RequireRole>
        }
      />

      {/* Auditor — Phase D */}
      <Route
        path="/audit/*"
        element={
          <RequireRole roles={['administrator', 'auditor']}>
            <AppShell><ComingSoon page="Audit log — Phase D" /></AppShell>
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
