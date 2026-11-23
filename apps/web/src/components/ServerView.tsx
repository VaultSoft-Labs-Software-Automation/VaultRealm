import { useState, useEffect, useRef } from 'react';
import {
  api,
  type ServerDetail,
  type ContainerStats,
  type DiagnosisFinding,
  type TimelineEvent,
  type ApiError,
} from '../api/client';
import { useToast } from './Toast';
import { useConfirm } from './ConfirmModal';
import { CompanionTab } from './CompanionTab';
import { ServerMetrics, type MetricSnapshot } from './ServerMetrics';
import { ServerModsTab } from './ServerModsTab';
import { ServerPlayersTab } from './ServerPlayersTab';
import { ServerPropertiesTab } from './ServerPropertiesTab';
import { ServerBackupsTab } from './ServerBackupsTab';

interface ServerViewProps {
  serverId: string;
  onBack: () => void;
  onDelete: () => void;
}

type ServerTab = 'overview' | 'console' | 'players' | 'mods' | 'properties' | 'backups' | 'debug' | 'companion' | 'settings';

export function ServerView({ serverId, onBack, onDelete }: ServerViewProps) {
  const [server, setServer] = useState<ServerDetail | null>(null);
  const [activeTab, setActiveTab] = useState<ServerTab>(() => {
    try {
      const saved = sessionStorage.getItem(`vr_tab_${serverId}`);
      if (saved && ['overview', 'console', 'players', 'mods', 'properties', 'backups', 'debug', 'companion', 'settings'].includes(saved)) {
        return saved as ServerTab;
      }
    } catch {
      // ignore
    }
    return 'overview';
  });
  const [consoleLogs, setConsoleLogs] = useState<string[]>([]);
  const [commandInput, setCommandInput] = useState('');
  const [findings, setFindings] = useState<DiagnosisFinding[]>([]);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [loadingAction, setLoadingAction] = useState<string | null>(null);
  const [stats, setStats] = useState<ContainerStats | null>(null);
  const [metricsHistory, setMetricsHistory] = useState<MetricSnapshot[]>([]);
  const lastStatsRef = useRef<{ time: number; rx: number; tx: number } | null>(null);

  const consoleContainerRef = useRef<HTMLDivElement>(null);
  const consoleBottomRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const isInitialLoadRef = useRef(true);
  const { addToast } = useToast();
  const { confirm, ConfirmDialog } = useConfirm();

  useEffect(() => {
    try {
      sessionStorage.setItem(`vr_tab_${serverId}`, activeTab);
    } catch {
      // ignore
    }
  }, [activeTab, serverId]);

  const fetchServer = async () => {
    try {
      const data = await api.getServer(serverId);
      setServer(data);
    } catch (err) {
      console.error(err);
    }
  };

  const fetchDiagnosis = async () => {
    try {
      const data = await api.getDiagnosis(serverId);
      setFindings(data);
    } catch (err) {
      console.error(err);
    }
  };

  const fetchEvents = async () => {
    try {
      const data = await api.getEvents(serverId);
      setEvents(data);
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    fetchServer();
    const interval = setInterval(fetchServer, 4000);
    return () => clearInterval(interval);
  }, [serverId]);

  useEffect(() => {
    if (activeTab === 'debug') {
      fetchDiagnosis();
      fetchEvents();
    } else if (activeTab === 'overview') {
      api
        .getServerStats(serverId)
        .then((s) => {
          setStats(s);
        })
        .catch(() => {});
    }
  }, [activeTab, serverId]);

  // WebSocket for console logs & stats
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const token = api.getToken();
    const tokenParam = token ? `?token=${encodeURIComponent(token)}` : '';
    const wsUrl = `${protocol}//${window.location.host}/ws/servers/${serverId}${tokenParam}`;
    let ws: WebSocket | null = null;

    try {
      ws = new WebSocket(wsUrl);

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'log') {
            setConsoleLogs((prev) => [...prev.slice(-400), String(msg.data)]);
          } else if (msg.type === 'status') {
            setServer((prev) => (prev ? { ...prev, status: msg.data } : null));
          } else if (msg.type === 'stats') {
            const rawStats = msg.data as ContainerStats;
            const now = Date.now();
            let rxSpeedBps = 0;
            let txSpeedBps = 0;

            if (lastStatsRef.current) {
              const dt = Math.max(0.5, (now - lastStatsRef.current.time) / 1000);
              const drx = Math.max(0, rawStats.networkRxBytes - lastStatsRef.current.rx);
              const dtx = Math.max(0, rawStats.networkTxBytes - lastStatsRef.current.tx);
              rxSpeedBps = drx / dt;
              txSpeedBps = dtx / dt;
            }

            lastStatsRef.current = {
              time: now,
              rx: rawStats.networkRxBytes,
              tx: rawStats.networkTxBytes,
            };

            setStats(rawStats);

            const snapshot: MetricSnapshot = {
              timestamp: new Date().toISOString(),
              timeLabel: new Date().toLocaleTimeString(),
              cpuPercent: rawStats.cpuPercent ?? 0,
              memoryUsageMb: rawStats.memoryUsageMb ?? 0,
              memoryLimitMb: rawStats.memoryLimitMb ?? 0,
              memoryPercent: rawStats.memoryPercent ?? 0,
              diskUsedMb: rawStats.diskUsedMb ?? 0,
              diskLimitMb: rawStats.diskLimitMb ?? 10240,
              diskPercent: rawStats.diskPercent ?? 0,
              networkRxBytes: rawStats.networkRxBytes ?? 0,
              networkTxBytes: rawStats.networkTxBytes ?? 0,
              rxSpeedBps,
              txSpeedBps,
              pids: rawStats.pids ?? 0,
            };

            setMetricsHistory((prev) => [...prev.slice(-59), snapshot]);
          } else if (msg.type === 'command_ack') {
            const out = msg.data.output;
            setConsoleLogs((prev) => [...prev, `> ${out}`]);
          }
        } catch {
          // ignore
        }
      };
    } catch (err) {
      console.error('WebSocket connection error:', err);
    }

    return () => {
      ws?.close();
    };
  }, [serverId]);

  const scrollToBottom = (behavior: ScrollBehavior = 'auto') => {
    const container = consoleContainerRef.current;
    if (!container) return;
    if (behavior === 'auto') {
      container.scrollTop = container.scrollHeight;
    } else {
      container.scrollTo({
        top: container.scrollHeight,
        behavior: 'smooth',
      });
    }
  };

  const handleConsoleScroll = () => {
    const container = consoleContainerRef.current;
    if (!container) return;
    const { scrollTop, scrollHeight, clientHeight } = container;
    const isAtBottom = scrollHeight - scrollTop - clientHeight <= 60;
    setAutoScroll(isAtBottom);
  };

  // Scroll to bottom when switching to console tab or when mounted
  useEffect(() => {
    if (activeTab === 'console') {
      requestAnimationFrame(() => {
        scrollToBottom('auto');
      });
      const timer = setTimeout(() => {
        scrollToBottom('auto');
      }, 60);
      return () => clearTimeout(timer);
    }
  }, [activeTab]);

  // Scroll to new line when consoleLogs update
  useEffect(() => {
    if (activeTab !== 'console') return;
    if (!consoleContainerRef.current) return;

    if (isInitialLoadRef.current) {
      requestAnimationFrame(() => {
        scrollToBottom('auto');
      });
      if (consoleLogs.length > 0) {
        const timer = setTimeout(() => {
          isInitialLoadRef.current = false;
          scrollToBottom('auto');
        }, 120);
        return () => clearTimeout(timer);
      }
    } else if (autoScroll) {
      requestAnimationFrame(() => {
        scrollToBottom('smooth');
      });
    }
  }, [consoleLogs, activeTab, autoScroll]);

  const handlePowerAction = async (action: 'start' | 'stop' | 'restart' | 'kill') => {
    setLoadingAction(action);
    try {
      if (action === 'start') await api.startServer(serverId);
      if (action === 'stop') await api.stopServer(serverId);
      if (action === 'restart') await api.restartServer(serverId);
      if (action === 'kill') await api.killServer(serverId);

      addToast({ type: 'success', title: `Server ${action} initiated.` });
      await fetchServer();
    } catch (err) {
      const error = err as ApiError;
      addToast({ type: 'error', title: `Failed to ${action} server`, message: error.message });
    } finally {
      setLoadingAction(null);
    }
  };

  const handleSendCommand = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!commandInput.trim()) return;

    const cmd = commandInput;
    setCommandInput('');
    setConsoleLogs((prev) => [...prev, `$ ${cmd}`]);
    setAutoScroll(true);
    requestAnimationFrame(() => {
      scrollToBottom('auto');
    });

    try {
      const res = await api.sendCommand(serverId, cmd);
      setConsoleLogs((prev) => [...prev, res.output]);
      requestAnimationFrame(() => {
        scrollToBottom('auto');
      });
    } catch (err) {
      const error = err as ApiError;
      addToast({ type: 'error', title: 'Command failed', message: error.message });
    }
  };

  const handleApplyFix = async (fix: { type: string; payload?: Record<string, unknown> }) => {
    try {
      const res = await api.applyFix(serverId, fix);
      addToast({ type: 'success', title: 'Fix Applied', message: res.message });
      await fetchServer();
      await fetchDiagnosis();
    } catch (err) {
      const error = err as ApiError;
      addToast({ type: 'error', title: 'Could not apply fix', message: error.message });
    }
  };

  const handleDeleteServer = async () => {
    const ok = await confirm({
      title: 'Delete Server Permanently',
      message:
        'This will permanently stop the container and purge its persistent storage volume. All world data, configurations, and backups will be lost. This action cannot be undone.',
      confirmLabel: 'Delete Forever',
      variant: 'danger',
    });
    if (!ok) return;

    try {
      await api.deleteServer(serverId);
      addToast({ type: 'success', title: 'Server deleted successfully.' });
      onDelete();
    } catch (err) {
      const error = err as ApiError;
      addToast({ type: 'error', title: 'Delete Failed', message: error.message });
    }
  };

  if (!server) {
    return (
      <div className="flex items-center justify-center p-12">
        <div className="text-center">
          <div className="inline-block animate-spin text-2xl text-primary mb-2">⟳</div>
          <p className="text-xs text-muted-foreground">Loading server metrics...</p>
        </div>
      </div>
    );
  }

  const primaryPort = server.ports[0];
  const joinAddress = primaryPort ? `${window.location.hostname}:${primaryPort.hostPort}` : 'N/A';

  return (
    <>
    <div className="space-y-6 animate-fade-in">
      {/* Top Navigation & Status */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4 border-b border-border pb-4 sm:pb-5">
        <div className="flex items-start gap-2.5 sm:gap-3 min-w-0">
          <button
            onClick={onBack}
            className="btn btn-secondary btn-sm shrink-0 mt-0.5"
          >
            ← Back
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 sm:gap-2.5 flex-wrap">
              <h1 className="text-lg sm:text-xl font-bold text-foreground tracking-tight truncate">{server.name}</h1>
              <span
                className={`badge shrink-0 ${
                  server.status === 'running'
                    ? 'badge-success'
                    : server.status === 'starting' || server.status === 'pulling'
                      ? 'badge-warning animate-pulse'
                      : server.status === 'error' || server.status === 'crashed'
                        ? 'badge-error'
                        : 'badge-neutral'
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    server.status === 'running'
                      ? 'bg-emerald-400'
                      : server.status === 'error' || server.status === 'crashed'
                        ? 'bg-red-400'
                        : 'bg-amber-400'
                  }`}
                />
                {server.status}
              </span>
            </div>
            <div className="flex items-center gap-1.5 sm:gap-2 mt-1 flex-wrap">
              <span className="badge badge-primary text-[10px] py-0 px-1.5 sm:px-2">{server.templateName}</span>
              {server.serverType && (
                <span className="badge badge-info text-[10px] py-0 px-1.5 sm:px-2 font-mono font-bold">
                  ⚡ {server.serverType}
                </span>
              )}
              {server.version && (
                <span className="badge badge-neutral text-[10px] py-0 px-1.5 sm:px-2 font-mono font-bold text-violet-300 border-violet-500/30 bg-violet-950/30">
                  🏷️ {server.version === 'LATEST' ? 'LATEST' : server.version.startsWith('v') ? server.version : `v${server.version}`}
                </span>
              )}
              <span className="text-xs text-muted-foreground hidden xs:inline">•</span>
              <span className="text-xs text-muted-foreground hidden xs:inline">Connect:</span>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(joinAddress);
                  addToast({ type: 'info', title: 'Address copied to clipboard' });
                }}
                className="font-mono text-xs text-primary hover:underline cursor-pointer bg-card-subtle px-2 py-0.5 rounded border border-border/60 flex items-center gap-1 max-w-[200px] sm:max-w-none truncate"
                title="Click to copy address"
              >
                <span className="truncate">{joinAddress}</span>
                <span className="text-[10px] shrink-0">📋</span>
              </button>
            </div>
          </div>
        </div>

        {/* Quick Power Actions */}
        <div className="grid grid-cols-3 sm:flex sm:items-center gap-1.5 sm:gap-2 w-full sm:w-auto shrink-0">
          {server.status === 'pulling' || server.status === 'creating' || server.status === 'starting' ? (
            <button
              disabled
              className="col-span-3 btn btn-primary btn-sm opacity-80 cursor-not-allowed flex items-center justify-center gap-1.5 w-full sm:w-auto"
            >
              <span className="inline-block animate-spin text-xs">⟳</span>
              <span className="capitalize">{server.status}...</span>
            </button>
          ) : server.status !== 'running' ? (
            <button
              onClick={() => handlePowerAction('start')}
              disabled={loadingAction === 'start' || server.status === 'stopping'}
              className="col-span-3 btn btn-primary btn-sm w-full sm:w-auto py-2 sm:py-1.5 font-bold"
            >
              ▶ Start Server
            </button>
          ) : (
            <>
              <button
                onClick={() => handlePowerAction('restart')}
                disabled={loadingAction === 'restart'}
                className="btn btn-secondary btn-sm py-2 sm:py-1.5"
              >
                🔄 Restart
              </button>
              <button
                onClick={() => handlePowerAction('stop')}
                disabled={loadingAction === 'stop'}
                className="btn btn-secondary btn-sm text-amber-400 hover:text-amber-300 border-amber-500/30 py-2 sm:py-1.5"
              >
                ⏹ Stop
              </button>
              <button
                onClick={() => handlePowerAction('kill')}
                disabled={loadingAction === 'kill'}
                className="btn btn-danger btn-sm py-2 sm:py-1.5"
              >
                ⚠️ Kill
              </button>
            </>
          )}
        </div>
      </div>

      {/* Tabs Strip */}
      <div className="flex border-b border-border gap-1 overflow-x-auto no-scrollbar touch-scroll -mx-3 px-3 sm:mx-0 sm:px-0">
        {[
          { id: 'overview', label: 'Overview', icon: '📊' },
          { id: 'console', label: 'Live Console', icon: '💻' },
          { id: 'players', label: 'Players & Bans', icon: '👥' },
          { id: 'mods', label: 'Mods & Addons', icon: '🧩' },
          { id: 'properties', label: 'Properties', icon: '⚙️' },
          { id: 'backups', label: 'Backups', icon: '💾' },
          { id: 'debug', label: 'Auto-Diagnosis', icon: '🔍' },
          { id: 'companion', label: 'AI Companion', icon: '🤖' },
          { id: 'settings', label: 'Settings', icon: '🔧' },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as ServerTab)}
            className={`py-2 px-3 sm:px-4 text-xs font-semibold rounded-t-lg transition-all cursor-pointer flex items-center gap-1.5 sm:gap-2 border-b-2 -mb-px shrink-0 whitespace-nowrap ${
              activeTab === tab.id
                ? 'border-primary text-primary bg-primary/10'
                : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/50'
            }`}
          >
            <span>{tab.icon}</span>
            <span>{tab.label}</span>
            {tab.id === 'debug' && findings.length > 0 && (
              <span className="badge badge-error text-[10px] py-0 px-1.5 ml-1">
                {findings.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Tab: Overview / Live Metrics */}
      {activeTab === 'overview' && (
        <ServerMetrics
          server={server}
          stats={stats}
          history={metricsHistory}
          onClearHistory={() => setMetricsHistory([])}
        />
      )}

      {/* Tab: Console */}
      {activeTab === 'console' && (
        <div className="card overflow-hidden flex flex-col h-[65vh] min-h-[400px] max-h-[600px] sm:h-[540px] bg-black/95 shadow-xl relative">
          <div className="px-3 sm:px-4 py-2.5 sm:py-3 bg-card-subtle border-b border-border flex items-center justify-between text-xs text-muted-foreground gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="flex gap-1.5 shrink-0">
                <span className="h-2.5 w-2.5 rounded-full bg-red-500/80 inline-block" />
                <span className="h-2.5 w-2.5 rounded-full bg-amber-500/80 inline-block" />
                <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/80 inline-block" />
              </span>
              <span className="font-mono text-[11px] text-muted-foreground ml-1 sm:ml-2 truncate max-w-[110px] xs:max-w-[160px] sm:max-w-none">
                Live Terminal • {server.name}
              </span>
            </div>
            <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
              <button
                type="button"
                onClick={() => {
                  const next = !autoScroll;
                  setAutoScroll(next);
                  if (next) scrollToBottom('auto');
                }}
                className={`btn btn-sm text-[10px] sm:text-[11px] py-1 px-2 sm:px-2.5 transition-colors flex items-center gap-1 sm:gap-1.5 ${
                  autoScroll
                    ? 'text-emerald-400 bg-emerald-950/40 border border-emerald-500/30'
                    : 'text-amber-400 bg-amber-950/40 border border-amber-500/30'
                }`}
                title={autoScroll ? 'Auto-scroll is active (click to pause)' : 'Auto-scroll paused (click to resume)'}
              >
                <span className={`inline-block w-1.5 h-1.5 rounded-full ${autoScroll ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'}`} />
                <span className="hidden sm:inline">{autoScroll ? 'Auto-scroll: ON' : 'Auto-scroll: PAUSED'}</span>
                <span className="sm:hidden">{autoScroll ? 'Scroll: ON' : 'Paused'}</span>
              </button>
              <button
                onClick={() => setConsoleLogs([])}
                className="btn btn-ghost btn-sm text-[10px] sm:text-[11px] py-1 px-1.5 sm:px-2"
              >
                Clear
              </button>
            </div>
          </div>
          <div
            ref={consoleContainerRef}
            onScroll={handleConsoleScroll}
            className="flex-1 p-3 sm:p-4 font-mono text-xs overflow-y-auto space-y-1 relative"
          >
            {consoleLogs.length === 0 ? (
              server.status === 'pulling' ? (
                <div className="flex flex-col items-center justify-center p-8 text-center text-muted-foreground my-auto h-full">
                  <div className="animate-spin text-3xl mb-3 text-primary">⟳</div>
                  <div className="font-semibold text-foreground text-sm">Downloading Game Server Image</div>
                  <div className="text-xs max-w-md mt-1 text-muted-foreground/90">
                    Docker is currently downloading and extracting the container image ({server.templateId}). Console logs will stream automatically once the server process launches.
                  </div>
                </div>
              ) : server.status === 'creating' ? (
                <div className="flex flex-col items-center justify-center p-8 text-center text-muted-foreground my-auto h-full">
                  <div className="animate-spin text-3xl mb-3 text-primary">⟳</div>
                  <div className="font-semibold text-foreground text-sm">Preparing Server Environment</div>
                  <div className="text-xs max-w-md mt-1 text-muted-foreground/90">
                    Allocating ports and configuring persistent storage...
                  </div>
                </div>
              ) : server.status === 'starting' ? (
                <div className="flex flex-col items-center justify-center p-8 text-center text-muted-foreground my-auto h-full">
                  <div className="animate-spin text-3xl mb-3 text-primary">⟳</div>
                  <div className="font-semibold text-foreground text-sm">Server Starting Up</div>
                  <div className="text-xs max-w-md mt-1 text-muted-foreground/90">
                    Waiting for initial log output from container process...
                  </div>
                </div>
              ) : server.status === 'stopped' ? (
                <div className="flex flex-col items-center justify-center p-8 text-center text-muted-foreground my-auto h-full">
                  <div className="text-3xl mb-3 opacity-60">⏹</div>
                  <div className="font-semibold text-foreground text-sm">Server is Stopped</div>
                  <div className="text-xs max-w-md mt-1 text-muted-foreground/90">
                    Click "Start Server" to launch the server and view live console logs.
                  </div>
                </div>
              ) : (
                <div className="text-muted-foreground italic">Connected to console. Waiting for container log output...</div>
              )
            ) : (
              consoleLogs.map((line, idx) => (
                <div
                  key={idx}
                  className={`leading-relaxed whitespace-pre-wrap ${
                    line.includes('ERROR') || line.includes('Exception')
                      ? 'text-red-400'
                      : line.includes('WARN')
                        ? 'text-amber-400'
                        : line.startsWith('$') || line.startsWith('>')
                          ? 'text-primary font-bold'
                          : 'text-zinc-300'
                  }`}
                >
                  {line}
                </div>
              ))
            )}
            <div ref={consoleBottomRef} />
            {!autoScroll && (
              <button
                type="button"
                onClick={() => {
                  setAutoScroll(true);
                  scrollToBottom('auto');
                }}
                className="sticky bottom-2 float-right mr-2 bg-primary text-primary-foreground text-xs py-1 px-3 rounded-full shadow-lg flex items-center gap-1.5 hover:opacity-90 transition-all font-sans font-semibold border border-primary-foreground/20 animate-bounce cursor-pointer z-10"
              >
                <span>↓</span>
                <span>Jump to bottom</span>
              </button>
            )}
          </div>
          <form onSubmit={handleSendCommand} className="p-3 border-t border-border bg-card-subtle flex gap-2">
            <input
              type="text"
              value={commandInput}
              onChange={(e) => setCommandInput(e.target.value)}
              placeholder="Send command to console (e.g. say Hello, time set day)..."
              className="input flex-1 font-mono text-xs"
            />
            <button type="submit" className="btn btn-primary btn-sm px-4">
              Send
            </button>
          </form>
        </div>
      )}

      {/* Tab: Players & Moderation */}
      {activeTab === 'players' && (
        <ServerPlayersTab server={server} />
      )}

      {/* Tab: Mods & Addons */}
      {activeTab === 'mods' && (
        <ServerModsTab
          server={server}
          onRestartServer={() => handlePowerAction('restart')}
        />
      )}

      {/* Tab: Properties */}
      {activeTab === 'properties' && (
        <ServerPropertiesTab
          server={server}
          onRestartServer={() => handlePowerAction('restart')}
        />
      )}

      {/* Tab: Debug */}
      {activeTab === 'debug' && (
        <div className="space-y-6">
          <div className="flex justify-between items-center">
            <div>
              <h3 className="font-bold text-base text-foreground">Auto-Diagnosis Engine</h3>
              <p className="text-xs text-muted-foreground">
                Automated error inspection analyzing container state, exit codes, and logs
              </p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={fetchDiagnosis}
                className="btn btn-secondary text-xs py-1.5 px-3"
              >
                Re-diagnose
              </button>
              <a
                href={api.getDebugBundleUrl(serverId)}
                download={`vaultrealm-debug-${serverId}.zip`}
                className="btn btn-primary text-xs py-1.5 px-3 font-semibold flex items-center gap-1.5"
              >
                📦 Download Debug Bundle (.zip)
              </a>
            </div>
          </div>

          {/* Findings List */}
          {findings.length === 0 ? (
            <div className="card p-8 border border-border/60 text-center">
              <span className="text-2xl mb-2 block">✅</span>
              <h4 className="font-bold text-sm text-foreground">No critical findings detected</h4>
              <p className="text-xs text-muted-foreground mt-1 max-w-md mx-auto">
                The diagnosis engine analyzed server logs and container status. No known error patterns or crash loops were found.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {findings.map((f, i) => (
                <div
                  key={i}
                  className={`card p-5 border transition-all ${
                    f.severity === 'error'
                      ? 'border-destructive/40 bg-destructive/5'
                      : f.severity === 'warn'
                        ? 'border-amber-500/40 bg-amber-500/5'
                        : 'border-blue-500/40 bg-blue-500/5'
                  }`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="flex items-center gap-2">
                        <span
                          className={`text-[10px] uppercase font-bold px-2 py-0.5 rounded ${
                            f.severity === 'error'
                              ? 'bg-destructive text-white'
                              : f.severity === 'warn'
                                ? 'bg-amber-500 text-black'
                                : 'bg-blue-500 text-white'
                          }`}
                        >
                          {f.severity}
                        </span>
                        <h4 className="font-bold text-sm text-foreground">{f.title}</h4>
                      </div>
                      <p className="text-xs text-muted-foreground mt-2">{f.explanation}</p>
                      {f.evidence && f.evidence.length > 0 && (
                        <div className="mt-2 text-xs font-mono bg-black/40 p-2 rounded border border-border/40 text-red-300">
                          {f.evidence[0]}
                        </div>
                      )}
                    </div>

                    {/* Actionable Fix Buttons */}
                    <div className="flex flex-col gap-2 shrink-0">
                      {f.fixes.map((fix, idx) => (
                        <button
                          key={idx}
                          onClick={() => handleApplyFix(fix.action)}
                          className="btn btn-primary text-xs py-1.5 px-3 font-semibold shadow glow-primary cursor-pointer text-left"
                        >
                          ⚡ {fix.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Event Timeline */}
          <div>
            <h4 className="font-bold text-sm text-foreground mb-3">Event Timeline</h4>
            <div className="card p-4 border border-border/60 space-y-3 max-h-72 overflow-y-auto">
              {events.map((evt) => (
                <div key={evt.id} className="text-xs flex items-start gap-3 border-b border-border/30 pb-2">
                  <span className="text-[10px] text-muted-foreground font-mono shrink-0">
                    {new Date(evt.ts).toLocaleTimeString()}
                  </span>
                  <div className="flex-1">
                    <span className="font-semibold text-foreground mr-2 font-mono text-[11px] text-primary">
                      [{evt.kind}]
                    </span>
                    <span className="text-zinc-300">{evt.message}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Tab: Companion */}
      {activeTab === 'companion' && (
        <CompanionTab serverId={serverId} />
      )}

      {/* Tab: Backups */}
      {activeTab === 'backups' && (
        <ServerBackupsTab
          serverId={serverId}
          serverStatus={server.status}
          isMinecraft={server.templateId.includes('minecraft')}
        />
      )}

      {/* Tab: Settings */}
      {activeTab === 'settings' && (
        <div className="space-y-6">
          <div className="card p-6 border border-border/80 flex items-center justify-between gap-4">
            <div>
              <h3 className="font-bold text-base text-foreground">Minecraft Server Properties</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                Customize online-mode, world spawn point, PvP, difficulty, view distance, and gameplay rules one by one.
              </p>
            </div>
            <button
              onClick={() => setActiveTab('properties')}
              className="btn btn-secondary text-xs py-2 px-4 font-semibold shrink-0"
            >
              Open Server Properties →
            </button>
          </div>

          <div className="card p-6 border border-border/80 space-y-4">
            <h3 className="font-bold text-base text-foreground">Server Specifications</h3>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs">
              <div>
                <span className="text-muted-foreground block mb-0.5">Engine / Type</span>
                <span className="font-mono text-cyan-400 font-bold">{server.serverType || 'Standard'}</span>
              </div>
              <div>
                <span className="text-muted-foreground block mb-0.5">Game Version</span>
                <span className="font-mono text-violet-300 font-bold">{server.version || 'Default'}</span>
              </div>
              <div>
                <span className="text-muted-foreground block mb-0.5">Server ID</span>
                <span className="font-mono text-foreground">{server.id}</span>
              </div>
              <div>
                <span className="text-muted-foreground block mb-0.5">Created At</span>
                <span className="font-mono text-foreground">
                  {new Date(server.createdAt).toLocaleString()}
                </span>
              </div>
            </div>
          </div>

          <div className="card p-6 border border-destructive/40 bg-destructive/5 space-y-3">
            <h3 className="font-bold text-base text-destructive">Danger Zone</h3>
            <p className="text-xs text-muted-foreground">
              Permanently stops the container and purges the persistent storage volume. This action cannot be undone.
            </p>
            <button
              onClick={handleDeleteServer}
              className="btn bg-destructive hover:bg-destructive/90 text-white text-xs py-2 px-4 font-bold cursor-pointer"
            >
              Delete Server Permanently
            </button>
          </div>
        </div>
      )}
    </div>
    {ConfirmDialog}
    </>
  );
}
