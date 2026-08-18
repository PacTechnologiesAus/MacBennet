import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import type { CurrentUser } from '@mac/protocol';
import { api, ApiError } from './api.js';
import { Login } from './pages/Login.js';
import { Dashboard } from './pages/Dashboard.js';
import { Projects } from './pages/Projects.js';
import { ProjectDetail } from './pages/ProjectDetail.js';
import { Tasks } from './pages/Tasks.js';
import { TaskDetail } from './pages/TaskDetail.js';
import { Runs } from './pages/Runs.js';
import { RunDetail } from './pages/RunDetail.js';
import { Workers } from './pages/Workers.js';
import { Audit } from './pages/Audit.js';
import { Settings } from './pages/Settings.js';
import { Discovery } from './pages/Discovery.js';
import { Reports } from './pages/Reports.js';
import { NightShift } from './pages/NightShift.js';
import { Monday } from './pages/Monday.js';
import { Security } from './pages/Security.js';
import { CompanyContext, CompanyContextWarning } from './pages/CompanyContext.js';

export function App() {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    // The session lives in an HttpOnly cookie, so the only way to know whether
    // one is valid is to ask the server.
    api
      .me()
      .then((r) => setUser(r.user))
      .catch((err) => {
        if (!(err instanceof ApiError && err.status === 401)) console.error(err);
      })
      .finally(() => setChecked(true));
  }, []);

  if (!checked) return <div className="login-shell">Loading…</div>;
  if (!user) return <Login onAuthenticated={setUser} />;

  return <Shell user={user} onSignedOut={() => setUser(null)} />;
}

function Shell({ user, onSignedOut }: { user: CurrentUser; onSignedOut: () => void }) {
  const navigate = useNavigate();

  const signOut = async () => {
    await api.logout().catch(() => undefined);
    onSignedOut();
    navigate('/');
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <strong>Mac Bennett</strong>
          <span>Automation Engineer · Sprint 3.2</span>
        </div>
        <nav className="nav">
          <NavLink to="/" end>Dashboard</NavLink>
          <NavLink to="/night-shift">Night shift</NavLink>
          <NavLink to="/discovery">Discovery</NavLink>
          <NavLink to="/projects">Projects</NavLink>
          <NavLink to="/tasks">Tasks</NavLink>
          <NavLink to="/runs">Runs</NavLink>
          <NavLink to="/reports">Reports</NavLink>
          <NavLink to="/monday">monday.com</NavLink>
          <NavLink to="/workers">Workers</NavLink>
          <NavLink to="/company-context">PAC context</NavLink>
          <NavLink to="/security">Security</NavLink>
          <NavLink to="/audit">Audit</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
        {/*
          Sprint 3.2: an operator must not have to open a page to learn that Mac
          is running on week-old cached company policy.
        */}
        <CompanyContextWarning />

        <div className="sidebar-footer">
          <div>{user.name}</div>
          <div className="dim">{user.role}</div>
          <button className="small" style={{ marginTop: 8 }} onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </aside>

      <main className="main">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/night-shift" element={<NightShift user={user} />} />
          <Route path="/monday" element={<Monday user={user} />} />
          <Route path="/security" element={<Security user={user} />} />
          <Route path="/company-context" element={<CompanyContext user={user} />} />
          <Route path="/discovery" element={<Discovery user={user} />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/projects" element={<Projects user={user} />} />
          <Route path="/projects/:id" element={<ProjectDetail user={user} />} />
          <Route path="/tasks" element={<Tasks user={user} />} />
          <Route path="/tasks/:id" element={<TaskDetail user={user} />} />
          <Route path="/runs" element={<Runs />} />
          <Route path="/runs/:id" element={<RunDetail user={user} />} />
          <Route path="/workers" element={<Workers user={user} />} />
          <Route path="/audit" element={<Audit />} />
          <Route path="/settings" element={<Settings user={user} />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
