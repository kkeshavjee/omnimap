// OmniMap — App Shell
// Role-based sidebar + top-bar layout. Renders nothing until auth resolves.

import { Link, NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useAuth, type UserRole } from '../../contexts/AuthContext';

interface NavItem {
  label: string;
  to:    string;
  roles: UserRole[];
  icon:  string;  // unicode icon
}

const NAV: NavItem[] = [
  { label: 'Projects',   to: '/admin/projects',  roles: ['administrator'],                                  icon: '📋' },
  { label: 'My Queue',   to: '/reviewer/queue',  roles: ['reviewer'],                                       icon: '📝' },
  { label: 'Adjudicate', to: '/adjudicator',     roles: ['adjudicator'],                                    icon: '⚖️' },
  { label: 'Audit Log',  to: '/audit',           roles: ['administrator', 'auditor'],                       icon: '🔍' },
];

function StatusDot({ status }: { status: 'ok' }) {
  return <span className="inline-block w-2 h-2 rounded-full bg-green-400" title={status} />;
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();
  const navigate         = useNavigate();
  const location         = useLocation();

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
            {location.pathname.replace(/\//g, ' › ').replace(/^ › /, '').toUpperCase() || 'HOME'}
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
