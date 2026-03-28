// OmniMap — App Shell
// Role-based sidebar + top-bar layout. Renders nothing until auth resolves.

import { useState, useEffect, useRef } from 'react';
import { Link, NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useAuth, type UserRole } from '../../contexts/AuthContext';
import { api } from '../../api/client';

interface NavItem {
  label: string;
  to:    string;
  roles: UserRole[];
  icon:  string;  // unicode icon
}

const NAV: NavItem[] = [
  { label: 'Projects',       to: '/admin/projects',       roles: ['administrator'],                            icon: '📋' },
  { label: 'My Queue',       to: '/reviewer/queue',       roles: ['reviewer', 'administrator'],                icon: '📝' },
  { label: 'Adjudicate',     to: '/adjudicator',          roles: ['adjudicator', 'administrator'],             icon: '⚖️' },
  { label: 'Audit Log',      to: '/audit',                roles: ['administrator', 'auditor'],                 icon: '🔍' },
  { label: 'Regex Library',  to: '/admin/regex-library',  roles: ['administrator'],                            icon: '🔤' },
  { label: 'Users',          to: '/admin/users',          roles: ['administrator'],                            icon: '👥' },
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Simple module-level cache so we don't re-fetch on every render
const projectNameCache = new Map<string, string>();

/**
 * Turns the URL pathname into a human-readable breadcrumb.
 * Replaces UUID segments with the corresponding project name.
 */
function useBreadcrumb(pathname: string): string {
  const [projectLabel, setProjectLabel] = useState<string | null>(null);
  const fetchedId = useRef<string | null>(null);

  const segments = pathname.split('/').filter(Boolean);
  const uuidSegment = segments.find(s => UUID_RE.test(s)) ?? null;

  useEffect(() => {
    if (!uuidSegment || fetchedId.current === uuidSegment) return;
    if (projectNameCache.has(uuidSegment)) {
      setProjectLabel(projectNameCache.get(uuidSegment)!);
      return;
    }
    fetchedId.current = uuidSegment;
    api.projects.get(uuidSegment)
      .then(p => {
        projectNameCache.set(uuidSegment, p.name);
        setProjectLabel(p.name);
      })
      .catch(() => {
        // Leave as UUID if fetch fails
      });
  }, [uuidSegment]);

  const readableSegments = segments.map(seg => {
    if (!UUID_RE.test(seg)) return seg.replace(/-/g, ' ');
    return projectLabel ?? seg.slice(0, 8) + '…';
  });

  return readableSegments.join(' › ').toUpperCase() || 'HOME';
}

function StatusDot({ status }: { status: 'ok' }) {
  return <span className="inline-block w-2 h-2 rounded-full bg-green-400" title={status} />;
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();
  const navigate         = useNavigate();
  const location         = useLocation();
  const breadcrumb       = useBreadcrumb(location.pathname);

  const visibleNav = NAV.filter(n => user && n.roles.includes(user.role));

  async function handleLogout() {
    await logout();
    navigate('/login');
  }

  return (
    <div className="flex h-screen bg-slate-50">
      {/* Sidebar */}
      <aside className="w-56 flex flex-col bg-slate-900 text-slate-100 shrink-0">
        {/* Logo */}
        <div className="px-5 py-4 border-b border-slate-700">
          <Link to="/" className="flex items-center gap-2">
            <span className="text-brand-400 font-bold text-lg">OmniMap</span>
            <StatusDot status="ok" />
          </Link>
          <p className="text-xs text-slate-400 mt-0.5">Clinical Terminology</p>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-2 py-4 space-y-1 overflow-y-auto">
          {visibleNav.map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors ` +
                (isActive
                  ? 'bg-brand-600 text-white'
                  : 'text-slate-300 hover:bg-slate-800 hover:text-white')
              }
            >
              <span>{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>

        {/* User footer */}
        <div className="px-4 py-3 border-t border-slate-700 text-xs text-slate-400">
          <p className="truncate font-medium text-slate-200">{user?.email}</p>
          <p className="capitalize mt-0.5">{user?.role}</p>
          <button
            onClick={handleLogout}
            className="mt-2 text-slate-400 hover:text-white transition-colors"
          >
            Sign out →
          </button>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Top bar */}
        <header className="h-12 flex items-center px-6 bg-white border-b border-slate-200 shrink-0">
          <h1 className="text-sm font-semibold text-slate-600 truncate">
            {breadcrumb}
          </h1>
        </header>

        {/* Page */}
        <main className="flex-1 overflow-y-auto p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
