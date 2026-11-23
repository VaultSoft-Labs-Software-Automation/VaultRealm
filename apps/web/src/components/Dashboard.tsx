import { type ServerDetail, type CapacityStatus } from '../api/client';
import { useToast } from './Toast';

interface DashboardProps {
  servers: ServerDetail[];
  capacity: CapacityStatus | null;
  onSelectServer: (id: string) => void;
  onOpenDeploy: () => void;
  onQuickPower: (id: string, action: 'start' | 'stop') => void;
}

export function Dashboard({
  servers,
  capacity,
  onSelectServer,
  onOpenDeploy,
  onQuickPower,
}: DashboardProps) {
  const { addToast } = useToast();
  const hostRamTotal = capacity?.host.totalHostRamMb ?? 8192;
  const hostRamBudget = capacity?.host.budgetRamMb ?? 6963;
  const hostRamAllocated = capacity?.host.allocatedRamMb ?? 0;
  const hostRamPercent = Math.min(100, Math.round((hostRamAllocated / hostRamBudget) * 100));

  const userServersCount = capacity?.user.serverCount ?? servers.length;
  const userServersQuota = capacity?.user.quotaServers ?? 3;
  const userRamUsed = capacity?.user.ramMb ?? 0;
  const userRamQuota = capacity?.user.quotaRamMb ?? 8192;

  return (
    <div className="space-y-6 sm:space-y-8 animate-fade-in">
      {/* Top Resource Summary Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 sm:gap-4">
        {/* Host RAM Budget Guard */}
        <div className="card p-3.5 sm:p-5 flex flex-col justify-between">
          <div>
            <div className="flex justify-between items-center mb-1.5 sm:mb-2">
              <span className="text-[10px] sm:text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1">
                <span>🛡️</span> <span className="hidden xs:inline">Host </span>RAM
              </span>
              <span className="badge badge-primary text-[9px] sm:text-[10px] py-0 px-1 sm:px-1.5">{hostRamPercent}%</span>
            </div>
            <div className="text-lg sm:text-2xl font-bold font-mono text-foreground mt-0.5 sm:mt-1">
              {hostRamAllocated}{' '}
              <span className="text-[10px] sm:text-xs font-normal text-muted-foreground">/ {hostRamBudget} MB</span>
            </div>
          </div>
          <div>
            <div className="w-full bg-muted rounded-full h-1.5 sm:h-2 mt-2.5 sm:mt-4 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  hostRamPercent > 80 ? 'bg-amber-500' : 'bg-primary'
                }`}
                style={{ width: `${hostRamPercent}%` }}
              />
            </div>
            <span className="text-[9px] sm:text-[10px] text-muted-foreground mt-1.5 sm:mt-2 block truncate">
              85% cap of {hostRamTotal} MB host RAM
            </span>
          </div>
        </div>

        {/* User Server Quota */}
        <div className="card p-3.5 sm:p-5 flex flex-col justify-between">
          <div>
            <div className="flex justify-between items-center mb-1.5 sm:mb-2">
              <span className="text-[10px] sm:text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1">
                <span>🎮</span> Servers
              </span>
              <span className="badge badge-success text-[9px] sm:text-[10px] py-0 px-1 sm:px-1.5">
                {userServersCount}/{userServersQuota}
              </span>
            </div>
            <div className="text-lg sm:text-2xl font-bold font-mono text-foreground mt-0.5 sm:mt-1">
              {userServersCount}{' '}
              <span className="text-[10px] sm:text-xs font-normal text-muted-foreground">Active</span>
            </div>
          </div>
          <div>
            <div className="w-full bg-muted rounded-full h-1.5 sm:h-2 mt-2.5 sm:mt-4 overflow-hidden">
              <div
                className="bg-emerald-500 h-full rounded-full transition-all duration-500"
                style={{ width: `${Math.min(100, (userServersCount / userServersQuota) * 100)}%` }}
              />
            </div>
            <span className="text-[9px] sm:text-[10px] text-muted-foreground mt-1.5 sm:mt-2 block truncate">
              {userServersQuota - userServersCount} slot(s) remaining
            </span>
          </div>
        </div>

        {/* User RAM Quota */}
        <div className="card p-3.5 sm:p-5 flex flex-col justify-between">
          <div>
            <div className="flex justify-between items-center mb-1.5 sm:mb-2">
              <span className="text-[10px] sm:text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1">
                <span>⚡</span> Memory
              </span>
              <span className="badge badge-primary text-[9px] sm:text-[10px] py-0 px-1 sm:px-1.5">
                {Math.round((userRamUsed / userRamQuota) * 100)}%
              </span>
            </div>
            <div className="text-lg sm:text-2xl font-bold font-mono text-foreground mt-0.5 sm:mt-1">
              {userRamUsed}{' '}
              <span className="text-[10px] sm:text-xs font-normal text-muted-foreground">/ {userRamQuota} MB</span>
            </div>
          </div>
          <div>
            <div className="w-full bg-muted rounded-full h-1.5 sm:h-2 mt-2.5 sm:mt-4 overflow-hidden">
              <div
                className="bg-primary h-full rounded-full transition-all duration-500"
                style={{ width: `${Math.min(100, (userRamUsed / userRamQuota) * 100)}%` }}
              />
            </div>
            <span className="text-[9px] sm:text-[10px] text-muted-foreground mt-1.5 sm:mt-2 block truncate">
              {userRamQuota - userRamUsed} MB available
            </span>
          </div>
        </div>

        {/* Quick Action Card */}
        <div className="card p-3.5 sm:p-5 border-primary/30 bg-gradient-to-br from-primary/10 via-card to-card flex flex-col justify-between glow-primary">
          <div>
            <div className="flex items-center gap-1 mb-1 sm:mb-2">
              <span className="text-[10px] sm:text-xs font-bold text-primary uppercase tracking-wider">
                🚀 Deploy
              </span>
            </div>
            <p className="text-[10px] sm:text-xs text-muted-foreground leading-relaxed line-clamp-2">
              Instant game container.
            </p>
          </div>
          <button
            onClick={onOpenDeploy}
            className="btn btn-primary text-xs py-2 sm:py-2.5 w-full font-bold shadow-md mt-2.5 sm:mt-4"
          >
            Deploy 🚀
          </button>
        </div>
      </div>

      {/* Servers List or Empty State */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-bold text-foreground">Your Game Servers</h2>
            <span className="badge badge-neutral text-xs">{servers.length}</span>
          </div>
          <button
            onClick={onOpenDeploy}
            className="btn btn-secondary btn-sm text-xs font-semibold"
          >
            + New Server
          </button>
        </div>

        {servers.length === 0 ? (
          <div className="card p-12 border border-border text-center glow-primary max-w-2xl mx-auto">
            <div className="h-16 w-16 mx-auto rounded-2xl bg-primary/20 flex items-center justify-center mb-4">
              <span className="text-3xl">🎮</span>
            </div>
            <h3 className="text-xl font-bold text-foreground">No game servers deployed yet</h3>
            <p className="text-sm text-muted-foreground mt-2 max-w-md mx-auto leading-relaxed">
              VaultRealm lets you self-host Minecraft, Palworld, Valheim, and more in lightweight, isolated Docker containers.
            </p>
            <button
              onClick={onOpenDeploy}
              className="btn btn-primary text-sm py-2.5 px-6 font-bold mt-6 shadow-lg glow-primary"
            >
              Deploy Your First Server 🚀
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {servers.map((server) => {
              const primaryPort = server.ports[0];
              const joinAddress = primaryPort
                ? `${window.location.hostname}:${primaryPort.hostPort}`
                : 'N/A';

              return (
                <div
                  key={server.id}
                  onClick={() => onSelectServer(server.id)}
                  className="card card-interactive p-5 flex flex-col justify-between group"
                >
                  <div>
                    {/* Header: Template, Type, Version & Status */}
                    <div className="flex items-start justify-between mb-3 gap-2">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="badge badge-primary text-[10px]">
                          {server.templateName}
                        </span>
                        {server.serverType && (
                          <span
                            className="badge badge-info text-[10px] font-mono tracking-wider font-bold"
                            title={`Server Engine: ${server.serverType}`}
                          >
                            ⚡ {server.serverType}
                          </span>
                        )}
                        {server.version && (
                          <span
                            className="badge badge-neutral text-[10px] font-mono font-bold text-violet-300 border-violet-500/30 bg-violet-950/30"
                            title={`Minecraft / Game Version: ${server.version}`}
                          >
                            🏷️ {server.version === 'LATEST' ? 'LATEST' : server.version.startsWith('v') ? server.version : `v${server.version}`}
                          </span>
                        )}
                      </div>
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

                    {/* Name */}
                    <h3 className="font-bold text-base text-foreground group-hover:text-primary transition-colors line-clamp-1">
                      {server.name}
                    </h3>

                    {/* Quick Specs Subtitle if Type or Version exists */}
                    {(server.serverType || server.version) && (
                      <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground font-mono">
                        {server.serverType && (
                          <span className="text-cyan-400 font-semibold inline-flex items-center gap-1">
                            <span className="text-[9px]">●</span>
                            <span>{server.serverType}</span>
                          </span>
                        )}
                        {server.serverType && server.version && <span className="opacity-40">•</span>}
                        {server.version && (
                          <span className="text-violet-300 font-semibold">
                            {server.version === 'LATEST' ? 'Latest Release' : `v${server.version}`}
                          </span>
                        )}
                      </div>
                    )}

                    {/* Connection Address */}
                    <div
                      onClick={(e) => {
                        e.stopPropagation();
                        navigator.clipboard.writeText(joinAddress);
                        addToast({ type: 'info', title: 'Address copied to clipboard' });
                      }}
                      className="mt-2 flex items-center justify-between gap-1.5 bg-card-subtle px-2.5 py-1.5 rounded-md border border-border/60 hover:border-primary/40 transition-colors cursor-pointer"
                      title="Tap to copy connection address"
                    >
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="text-[11px] text-muted-foreground font-mono">Connect:</span>
                        <span className="text-xs font-mono font-semibold text-primary truncate">
                          {joinAddress}
                        </span>
                      </div>
                      <span className="text-[11px] text-muted-foreground shrink-0 hover:text-primary">📋</span>
                    </div>

                    {/* Memory allocation bar */}
                    <div className="mt-4 pt-3 border-t border-border/50">
                      <div className="flex justify-between text-xs text-muted-foreground mb-1">
                        <span>RAM</span>
                        <span className="font-mono text-foreground font-medium">{server.ramMb} MB</span>
                      </div>
                      <div className="w-full bg-muted rounded-full h-1.5 overflow-hidden">
                        <div
                          className="bg-primary h-full rounded-full"
                          style={{ width: `${Math.min(100, (server.ramMb / 8192) * 100)}%` }}
                        />
                      </div>
                    </div>
                  </div>

                  {/* Actions footer */}
                  <div className="mt-5 pt-3 border-t border-border/50 flex items-center justify-between">
                    <span className="text-xs text-primary font-semibold group-hover:translate-x-0.5 transition-transform inline-flex items-center gap-1">
                      Manage Server →
                    </span>
                    <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
                      {server.status === 'running' ? (
                        <button
                          onClick={() => onQuickPower(server.id, 'stop')}
                          className="btn btn-secondary btn-sm text-amber-400 hover:text-amber-300"
                        >
                          ⏹ Stop
                        </button>
                      ) : (
                        <button
                          onClick={() => onQuickPower(server.id, 'start')}
                          className="btn btn-primary btn-sm"
                        >
                          ▶ Start
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
