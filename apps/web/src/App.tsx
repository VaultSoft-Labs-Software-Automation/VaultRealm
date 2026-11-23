import { useState, useEffect } from 'react';
import {
  api,
  setAuthToken,
  type User,
  type ServerDetail,
  type CapacityStatus,
  type ApiError,
} from './api/client';
import { ToastProvider, useToast } from './components/Toast';
import { AuthModal } from './components/AuthModal';
import { Dashboard } from './components/Dashboard';
import { DeployWizard } from './components/DeployWizard';
import { ServerView } from './components/ServerView';
import { AdminView } from './components/AdminView';

export function AppContent() {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  const [servers, setServers] = useState<ServerDetail[]>([]);
  const [capacity, setCapacity] = useState<CapacityStatus | null>(null);
  const [selectedServerId, setSelectedServerId] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem('vr_selected_server');
    } catch {
      return null;
    }
  });
  const [showDeployWizard, setShowDeployWizard] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [loading, setLoading] = useState(true);

  const { addToast } = useToast();

  const loadData = async () => {
    try {
      const [serversData, capacityData] = await Promise.all([
        api.listServers(),
        api.getCapacity(),
      ]);
      setServers(serversData);
      setCapacity(capacityData);
    } catch {
      // not logged in or error
    }
  };

  useEffect(() => {
    // Check authentication and setup status
    const init = async () => {
      try {
        const user = await api.getMe();
        setCurrentUser(user);
        await loadData();
      } catch {
        setAuthToken(null);
        // Check if first-run setup is required
        try {
          const res = await api.getSetupStatus();
          setNeedsSetup(res.needsSetup);
        } catch {
          setNeedsSetup(false);
        }
      } finally {
        setLoading(false);
      }
    };

    void init();
  }, []);

  useEffect(() => {
    try {
      if (selectedServerId) {
        sessionStorage.setItem('vr_selected_server', selectedServerId);
      } else {
        sessionStorage.removeItem('vr_selected_server');
      }
    } catch {
      // ignore
    }
  }, [selectedServerId]);

  const handleLogout = async () => {
    try {
      await api.logout();
      setCurrentUser(null);
      setSelectedServerId(null);
      try {
        sessionStorage.removeItem('vr_selected_server');
      } catch {
        // ignore
      }
      setShowAdmin(false);
      addToast({ type: 'info', title: 'Signed out.' });
    } catch {
      setCurrentUser(null);
    }
  };

  const handleQuickPower = async (id: string, action: 'start' | 'stop') => {
    try {
      if (action === 'start') await api.startServer(id);
      if (action === 'stop') await api.stopServer(id);
      addToast({ type: 'success', title: `Server ${action} initiated.` });
      await loadData();
    } catch (err) {
      const error = err as ApiError;
      addToast({ type: 'error', title: `Failed to ${action} server`, message: error.message });
    }
  };

  const toggleTheme = () => {
    const nextTheme = theme === 'dark' ? 'light' : 'dark';
    setTheme(nextTheme);
    document.documentElement.classList.toggle('light', nextTheme === 'light');
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center">
          <img
            src="/VR2.jpg"
            alt="VaultRealm"
            className="h-16 w-auto object-contain mx-auto mb-4 rounded-xl shadow-lg border border-border animate-pulse"
          />
          <p className="text-xs text-muted-foreground font-mono mb-1">Loading VaultRealm...</p>
          <a
            href="https://www.vaultsoftlabs.tech/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] text-muted-foreground/80 hover:text-primary transition-colors font-mono inline-flex items-center gap-1"
          >
            by VaultSoft Labs <span className="text-[9px]">↗</span>
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className={`w-full min-h-screen flex flex-col bg-background text-foreground ${theme}`}>
      {/* ── Navigation Bar ────────────────────────────────────────────────── */}
      <header className="w-full border-b border-border bg-card/80 backdrop-blur-lg sticky top-0 z-40 shadow-sm">
        <div className="w-full mx-auto max-w-[1600px] px-3 sm:px-6 lg:px-10 py-2.5 sm:py-3.5 flex items-center justify-between gap-2 sm:gap-4">
          <div
            onClick={() => {
              setSelectedServerId(null);
              setShowAdmin(false);
            }}
            className="flex items-center gap-2.5 sm:gap-3.5 cursor-pointer group select-none min-w-0"
          >
            <img
              src="/VR2.jpg"
              alt="VaultRealm"
              className="h-8 sm:h-11 w-auto object-contain rounded-lg shadow-sm border border-border/40 group-hover:scale-105 transition-transform shrink-0"
            />
            <div className="flex flex-col min-w-0">
              <div className="flex items-center gap-1.5 sm:gap-2">
                <span className="font-bold text-xs sm:text-sm text-foreground tracking-tight truncate">VaultRealm</span>
                <span className="badge badge-primary text-[9px] sm:text-[10px] py-0 px-1.5 font-mono">v0.5</span>
              </div>
              <a
                href="https://www.vaultsoftlabs.tech/"
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="hidden sm:flex text-[11px] text-muted-foreground hover:text-primary transition-colors items-center gap-1 font-mono tracking-tight mt-0.5"
                title="Engineered by VaultSoft Labs"
              >
                <span>by</span>
                <span className="font-semibold text-foreground/90 hover:underline">VaultSoft Labs</span>
                <span className="text-[9px] text-primary opacity-70">↗</span>
              </a>
            </div>
          </div>

          <div className="flex items-center gap-1.5 sm:gap-3 shrink-0">
            {/* Theme Toggle */}
            <button
              onClick={toggleTheme}
              className="btn btn-secondary btn-sm p-1.5 sm:p-2 text-xs"
              title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {theme === 'dark' ? '☀️' : '🌙'}
            </button>

            {currentUser ? (
              <div className="flex items-center gap-1.5 sm:gap-3">
                {currentUser.role === 'admin' && (
                  <button
                    onClick={() => {
                      setShowAdmin(true);
                      setSelectedServerId(null);
                    }}
                    className={`btn btn-sm px-2 sm:px-3 text-xs ${
                      showAdmin
                        ? 'btn-primary'
                        : 'btn-secondary text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    <span>⚙️</span>
                    <span className="hidden sm:inline">Admin Control</span>
                    <span className="sm:hidden">Admin</span>
                  </button>
                )}

                <div className="flex items-center gap-1.5 sm:gap-3 pl-1.5 sm:pl-3 border-l border-border">
                  <div className="flex items-center gap-1.5 sm:gap-2">
                    <div className="h-7 w-7 rounded-full bg-primary/20 border border-primary/30 flex items-center justify-center text-xs font-bold text-primary shrink-0">
                      {currentUser.username.charAt(0).toUpperCase()}
                    </div>
                    <div className="text-left hidden md:block">
                      <span className="text-xs font-bold text-foreground block leading-none mb-0.5">
                        {currentUser.username}
                      </span>
                      <span className="badge badge-neutral text-[9px] py-0 px-1.5 uppercase font-mono">
                        {currentUser.role}
                      </span>
                    </div>
                  </div>
                  <button
                    onClick={handleLogout}
                    className="btn btn-secondary btn-sm p-1.5 text-muted-foreground hover:text-destructive"
                    title="Sign Out"
                  >
                    🚪
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      {/* ── Main Content Area ─────────────────────────────────────────────── */}
      <main className="flex-1 w-full mx-auto max-w-[1600px] px-3 sm:px-6 lg:px-10 py-4 sm:py-6 lg:py-8">
        {!currentUser ? (
          <AuthModal
            needsSetup={needsSetup ?? false}
            onSuccess={(user) => {
              setCurrentUser(user);
              loadData();
            }}
          />
        ) : showAdmin ? (
          <AdminView onBack={() => setShowAdmin(false)} />
        ) : selectedServerId ? (
          <ServerView
            serverId={selectedServerId}
            onBack={() => setSelectedServerId(null)}
            onDelete={() => {
              setSelectedServerId(null);
              loadData();
            }}
          />
        ) : (
          <Dashboard
            servers={servers}
            capacity={capacity}
            onSelectServer={(id) => setSelectedServerId(id)}
            onOpenDeploy={() => setShowDeployWizard(true)}
            onQuickPower={handleQuickPower}
          />
        )}
      </main>

      {/* ── Deploy Wizard Modal ──────────────────────────────────────────── */}
      {showDeployWizard && (
        <DeployWizard
          onClose={() => setShowDeployWizard(false)}
          onSuccess={(newServerId) => {
            setShowDeployWizard(false);
            setSelectedServerId(newServerId);
            loadData();
          }}
        />
      )}

      {/* ── Footer ───────────────────────────────────────────────────────── */}
      <footer className="w-full border-t border-border bg-card/40 backdrop-blur-sm mt-auto">
        <div className="w-full mx-auto max-w-[1600px] px-6 sm:px-8 lg:px-10 py-5 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-muted-foreground">
          <div className="flex items-center gap-2 flex-wrap justify-center sm:justify-start">
            <span className="font-semibold text-foreground">VaultRealm</span>
            <span className="text-border">•</span>
            <span>Engineered by</span>
            <a
              href="https://www.vaultsoftlabs.tech/"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-foreground hover:text-primary transition-colors inline-flex items-center gap-1 group"
            >
              <span>VaultSoft Labs</span>
              <span className="text-[10px] text-primary opacity-70 group-hover:opacity-100 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform">↗</span>
            </a>
            <span className="text-border">•</span>
            <span>All rights reserved</span>
          </div>

          <div className="flex items-center gap-4 text-xs text-muted-foreground font-mono">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse"></span>
              Autonomous Game Cloud
            </span>
            <span className="text-border">•</span>
            <a
              href="https://www.vaultsoftlabs.tech/"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-primary transition-colors inline-flex items-center gap-1"
            >
              <span>vaultsoftlabs.tech</span>
              <span className="text-[9px] opacity-70">↗</span>
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}

export function App() {
  return (
    <ToastProvider>
      <AppContent />
    </ToastProvider>
  );
}
export default App;
