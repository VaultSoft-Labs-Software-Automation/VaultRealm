import { useState, useEffect } from 'react';
import {
  api,
  type ServerDetail,
  type ServerPlayersData,
  type BannedPlayer,
  type BannedIp,
} from '../api/client';
import { useToast } from './Toast';

interface ServerPlayersTabProps {
  server: ServerDetail;
}

export function ServerPlayersTab({ server }: ServerPlayersTabProps) {
  const [data, setData] = useState<ServerPlayersData | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeSubtab, setActiveSubtab] = useState<'online' | 'banned-players' | 'banned-ips' | 'actions'>('online');

  // Form states for Quick Moderation
  const [actionType, setActionType] = useState<'kick' | 'ban' | 'ban-ip' | 'op'>('kick');
  const [targetInput, setTargetInput] = useState('');
  const [reasonInput, setReasonInput] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Search filters
  const [playerSearch, setPlayerSearch] = useState('');
  const [ipSearch, setIpSearch] = useState('');

  const { addToast } = useToast();

  const fetchPlayers = async () => {
    setLoading(true);
    try {
      const res = await api.getServerPlayers(server.id);
      setData(res);
    } catch (err) {
      console.error('Failed to fetch player moderation data', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPlayers();
    const interval = setInterval(fetchPlayers, 6000);
    return () => clearInterval(interval);
  }, [server.id]);

  const handleExecuteAction = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetInput.trim()) return;

    setSubmitting(true);
    try {
      if (actionType === 'kick') {
        const res = await api.kickPlayer(server.id, targetInput.trim(), reasonInput.trim() || undefined);
        addToast({ type: 'success', title: 'Player Kicked', message: res.message });
      } else if (actionType === 'ban') {
        const res = await api.banPlayer(server.id, targetInput.trim(), reasonInput.trim() || undefined);
        addToast({ type: 'success', title: 'Player Banned', message: res.message });
      } else if (actionType === 'ban-ip') {
        const res = await api.banIp(server.id, targetInput.trim(), reasonInput.trim() || undefined);
        addToast({ type: 'success', title: 'IP Address Blocked', message: res.message });
      } else if (actionType === 'op') {
        const isCurrentlyOp = (data?.ops || []).some(
          (o) => o.name.toLowerCase() === targetInput.trim().toLowerCase(),
        );
        const res = await api.setPlayerOp(server.id, targetInput.trim(), !isCurrentlyOp);
        addToast({
          type: 'info',
          title: isCurrentlyOp ? 'OP Revoked' : 'OP Granted',
          message: res.message,
        });
      }

      setTargetInput('');
      setReasonInput('');
      await fetchPlayers();
    } catch (err) {
      addToast({
        type: 'error',
        title: 'Action Failed',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleKickDirect = async (player: string) => {
    const reason = prompt(`Enter reason for kicking ${player} (optional):`, 'Kicked by administrator');
    if (reason === null) return;

    try {
      const res = await api.kickPlayer(server.id, player, reason || undefined);
      addToast({ type: 'success', title: `Kicked ${player}`, message: res.message });
      await fetchPlayers();
    } catch (err) {
      addToast({
        type: 'error',
        title: 'Could not kick player',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleBanDirect = async (player: string) => {
    const reason = prompt(`Enter reason for banning ${player} (optional):`, 'Banned by administrator');
    if (reason === null) return;

    try {
      const res = await api.banPlayer(server.id, player, reason || undefined);
      addToast({ type: 'success', title: `Banned ${player}`, message: res.message });
      await fetchPlayers();
    } catch (err) {
      addToast({
        type: 'error',
        title: 'Could not ban player',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleBanIpDirect = async (player: string) => {
    const reason = prompt(`Enter reason for IP banning ${player} (optional):`, 'IP banned by administrator');
    if (reason === null) return;

    try {
      const res = await api.banIp(server.id, player, reason || undefined);
      addToast({ type: 'success', title: `IP Banned ${player}`, message: res.message });
      await fetchPlayers();
    } catch (err) {
      addToast({
        type: 'error',
        title: 'Could not ban IP',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleUnbanPlayer = async (player: BannedPlayer) => {
    if (!confirm(`Unban player "${player.name}"? They will be allowed to rejoin.`)) return;

    try {
      const res = await api.unbanPlayer(server.id, player.name);
      addToast({ type: 'success', title: `Unbanned ${player.name}`, message: res.message });
      await fetchPlayers();
    } catch (err) {
      addToast({
        type: 'error',
        title: 'Could not unban player',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleUnbanIp = async (bannedIp: BannedIp) => {
    if (!confirm(`Unblock IP address "${bannedIp.ip}"? Players connecting from this IP will be allowed.`)) return;

    try {
      const res = await api.unbanIp(server.id, bannedIp.ip);
      addToast({ type: 'success', title: `Unblocked IP ${bannedIp.ip}`, message: res.message });
      await fetchPlayers();
    } catch (err) {
      addToast({
        type: 'error',
        title: 'Could not unban IP',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const filteredBannedPlayers = (data?.bannedPlayers || []).filter((p) =>
    p.name.toLowerCase().includes(playerSearch.toLowerCase()) ||
    (p.reason && p.reason.toLowerCase().includes(playerSearch.toLowerCase())),
  );

  const filteredBannedIps = (data?.bannedIps || []).filter((b) =>
    b.ip.includes(ipSearch) ||
    (b.reason && b.reason.toLowerCase().includes(ipSearch.toLowerCase())),
  );

  return (
    <div className="space-y-4 sm:space-y-6 animate-fade-in">
      {/* ── Metric Summary Strip ───────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5 sm:gap-4">
        <div className="card p-3 sm:p-4 border border-border flex items-center justify-between">
          <div>
            <span className="text-[10px] sm:text-[11px] text-muted-foreground font-mono block">Connected</span>
            <div className="flex items-center gap-1.5 sm:gap-2 mt-0.5 sm:mt-1">
              <span className="text-lg sm:text-xl font-bold font-mono text-emerald-400">
                {data?.online.count ?? 0}
              </span>
              <span className="text-[10px] sm:text-xs text-muted-foreground font-mono">
                / {data?.online.max ?? 20} max
              </span>
            </div>
          </div>
          <span className="text-xl sm:text-2xl opacity-80">🟢</span>
        </div>

        <div className="card p-3 sm:p-4 border border-border flex items-center justify-between">
          <div>
            <span className="text-[10px] sm:text-[11px] text-muted-foreground font-mono block">Banned Players</span>
            <span className="text-lg sm:text-xl font-bold font-mono text-red-400 mt-0.5 sm:mt-1 block">
              {data?.bannedPlayers.length ?? 0}
            </span>
          </div>
          <span className="text-xl sm:text-2xl opacity-80">🚫</span>
        </div>

        <div className="card p-3 sm:p-4 border border-border flex items-center justify-between">
          <div>
            <span className="text-[10px] sm:text-[11px] text-muted-foreground font-mono block">Blocked IPs</span>
            <span className="text-lg sm:text-xl font-bold font-mono text-amber-400 mt-0.5 sm:mt-1 block">
              {data?.bannedIps.length ?? 0}
            </span>
          </div>
          <span className="text-xl sm:text-2xl opacity-80">🛑</span>
        </div>

        <div className="card p-3 sm:p-4 border border-border flex items-center justify-between">
          <div>
            <span className="text-[10px] sm:text-[11px] text-muted-foreground font-mono block">Operators (OP)</span>
            <span className="text-lg sm:text-xl font-bold font-mono text-primary mt-0.5 sm:mt-1 block">
              {data?.ops.length ?? 0}
            </span>
          </div>
          <span className="text-xl sm:text-2xl opacity-80">⭐</span>
        </div>
      </div>

      {/* ── Subtab Navigation & Quick Action Strip ───────────────────────────── */}
      <div className="card p-3 sm:p-4 border border-border/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4">
        <div className="flex bg-card-subtle p-1 rounded-lg border border-border overflow-x-auto no-scrollbar touch-scroll">
          <button
            onClick={() => setActiveSubtab('online')}
            className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-all flex items-center gap-1.5 shrink-0 whitespace-nowrap ${
              activeSubtab === 'online'
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <span>🟢 Online</span>
            <span className="badge badge-neutral text-[9px] py-0 px-1 font-mono">
              {data?.online.count ?? 0}
            </span>
          </button>

          <button
            onClick={() => setActiveSubtab('banned-players')}
            className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-all flex items-center gap-1.5 shrink-0 whitespace-nowrap ${
              activeSubtab === 'banned-players'
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <span>🚫 Banned</span>
            <span className="badge badge-neutral text-[9px] py-0 px-1 font-mono">
              {data?.bannedPlayers.length ?? 0}
            </span>
          </button>

          <button
            onClick={() => setActiveSubtab('banned-ips')}
            className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-all flex items-center gap-1.5 shrink-0 whitespace-nowrap ${
              activeSubtab === 'banned-ips'
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <span>🛑 IPs</span>
            <span className="badge badge-neutral text-[9px] py-0 px-1 font-mono">
              {data?.bannedIps.length ?? 0}
            </span>
          </button>

          <button
            onClick={() => setActiveSubtab('actions')}
            className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-all flex items-center gap-1.5 shrink-0 whitespace-nowrap ${
              activeSubtab === 'actions'
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <span>⚡ Actions</span>
          </button>
        </div>

        <button
          onClick={fetchPlayers}
          disabled={loading}
          className="btn btn-secondary text-xs py-1.5 px-3 flex items-center justify-center gap-1 w-full sm:w-auto shrink-0"
        >
          <span className={loading ? 'animate-spin inline-block' : ''}>🔄</span>
          <span>Refresh</span>
        </button>
      </div>

      {/* ── Subtab 1: Online Players ────────────────────────────────────────── */}
      {activeSubtab === 'online' && (
        <div className="space-y-4">
          {(data?.online.players || []).length === 0 ? (
            <div className="card p-12 text-center border border-dashed border-border/80">
              <span className="text-3xl mb-3 block">👥</span>
              <h4 className="font-bold text-base text-foreground">No players connected</h4>
              <p className="text-xs text-muted-foreground mt-1 max-w-md mx-auto">
                No players are currently online. When players join the game server, they will appear here with instant kick, ban, and operator controls.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {data?.online.players.map((playerName) => {
                const isOp = (data.ops || []).some(
                  (o) => o.name.toLowerCase() === playerName.toLowerCase(),
                );

                return (
                  <div
                    key={playerName}
                    className="card p-3.5 sm:p-4 border border-border flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:border-primary/40 transition-colors"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <img
                        src={`https://mc-heads.net/avatar/${encodeURIComponent(playerName)}/36`}
                        alt={playerName}
                        className="w-9 h-9 rounded bg-muted/30 border border-border/50 shrink-0"
                        onError={(e) => {
                          // Fallback icon
                          (e.target as HTMLElement).style.display = 'none';
                        }}
                      />
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="font-bold text-sm text-foreground truncate font-mono">
                            {playerName}
                          </span>
                          {isOp && (
                            <span className="badge badge-warning text-[9px] py-0 px-1 font-bold">
                              OP
                            </span>
                          )}
                        </div>
                        <span className="text-[10px] text-emerald-400 font-mono flex items-center gap-1 mt-0.5">
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> Connected
                        </span>
                      </div>
                    </div>

                    <div className="grid grid-cols-3 sm:flex sm:items-center gap-1.5 w-full sm:w-auto pt-2 sm:pt-0 border-t sm:border-t-0 border-border/40">
                      <button
                        onClick={() => handleKickDirect(playerName)}
                        className="btn btn-secondary btn-sm text-xs py-1.5 sm:py-1 px-2 text-amber-400 hover:text-amber-300 flex items-center justify-center"
                        title="Kick player from server"
                      >
                        Kick
                      </button>
                      <button
                        onClick={() => handleBanDirect(playerName)}
                        className="btn btn-secondary btn-sm text-xs py-1.5 sm:py-1 px-2 text-red-400 hover:text-red-300 flex items-center justify-center"
                        title="Ban player from server"
                      >
                        Ban
                      </button>
                      <button
                        onClick={() => handleBanIpDirect(playerName)}
                        className="btn btn-secondary btn-sm text-xs py-1.5 sm:py-1 px-2 text-destructive flex items-center justify-center"
                        title="Ban IP address"
                      >
                        Ban IP
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Subtab 2: Banned Players ────────────────────────────────────────── */}
      {activeSubtab === 'banned-players' && (
        <div className="space-y-4">
          <div className="relative">
            <input
              type="text"
              placeholder="Filter banned players by name or reason..."
              value={playerSearch}
              onChange={(e) => setPlayerSearch(e.target.value)}
              className="input w-full text-xs pl-8 font-mono"
            />
            <span className="absolute left-2.5 top-2.5 text-xs text-muted-foreground">🔍</span>
          </div>

          {filteredBannedPlayers.length === 0 ? (
            <div className="card p-12 text-center text-muted-foreground border border-dashed border-border/80">
              <span className="text-2xl mb-2 block">✅</span>
              <p className="text-sm font-semibold text-foreground">No banned players</p>
              <p className="text-xs text-muted-foreground mt-1">
                {playerSearch ? 'No bans match your search query.' : 'No players are currently banned on this server.'}
              </p>
            </div>
          ) : (
            <div className="card overflow-hidden border border-border">
              <div className="overflow-x-auto">
                <table className="w-full text-xs text-left">
                  <thead className="bg-card-subtle border-b border-border text-[11px] text-muted-foreground font-mono">
                    <tr>
                      <th className="p-3">Player</th>
                      <th className="p-3">Reason</th>
                      <th className="p-3">Banned At</th>
                      <th className="p-3">Source</th>
                      <th className="p-3 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/40 font-mono">
                    {filteredBannedPlayers.map((bp) => (
                      <tr key={bp.name + (bp.created || '')} className="hover:bg-muted/10 transition-colors">
                        <td className="p-3 font-semibold text-foreground">
                          <div className="flex items-center gap-2">
                            <span>🚫</span>
                            <span>{bp.name}</span>
                          </div>
                        </td>
                        <td className="p-3 text-muted-foreground">
                          {bp.reason || 'Banned by operator'}
                        </td>
                        <td className="p-3 text-[11px] text-muted-foreground">
                          {bp.created || 'N/A'}
                        </td>
                        <td className="p-3 text-[11px] text-muted-foreground">
                          {bp.source || 'Server'}
                        </td>
                        <td className="p-3 text-right">
                          <button
                            onClick={() => handleUnbanPlayer(bp)}
                            className="btn btn-secondary text-[11px] py-1 px-2.5 text-emerald-400 hover:text-emerald-300 border-emerald-500/20"
                          >
                            ✓ Pardon / Unban
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Subtab 3: Blocked IPs ───────────────────────────────────────────── */}
      {activeSubtab === 'banned-ips' && (
        <div className="space-y-4">
          <div className="relative">
            <input
              type="text"
              placeholder="Filter blocked IP addresses..."
              value={ipSearch}
              onChange={(e) => setIpSearch(e.target.value)}
              className="input w-full text-xs pl-8 font-mono"
            />
            <span className="absolute left-2.5 top-2.5 text-xs text-muted-foreground">🔍</span>
          </div>

          {filteredBannedIps.length === 0 ? (
            <div className="card p-12 text-center text-muted-foreground border border-dashed border-border/80">
              <span className="text-2xl mb-2 block">🛡️</span>
              <p className="text-sm font-semibold text-foreground">No blocked IP addresses</p>
              <p className="text-xs text-muted-foreground mt-1">
                {ipSearch ? 'No banned IPs match your search query.' : 'No IP addresses are currently blocked.'}
              </p>
            </div>
          ) : (
            <div className="card overflow-hidden border border-border">
              <div className="overflow-x-auto">
                <table className="w-full text-xs text-left">
                  <thead className="bg-card-subtle border-b border-border text-[11px] text-muted-foreground font-mono">
                    <tr>
                      <th className="p-3">IP Address</th>
                      <th className="p-3">Reason</th>
                      <th className="p-3">Blocked At</th>
                      <th className="p-3">Source</th>
                      <th className="p-3 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/40 font-mono">
                    {filteredBannedIps.map((bi) => (
                      <tr key={bi.ip} className="hover:bg-muted/10 transition-colors">
                        <td className="p-3 font-semibold text-amber-400">
                          <div className="flex items-center gap-2">
                            <span>🛑</span>
                            <span>{bi.ip}</span>
                          </div>
                        </td>
                        <td className="p-3 text-muted-foreground">
                          {bi.reason || 'Blocked by operator'}
                        </td>
                        <td className="p-3 text-[11px] text-muted-foreground">
                          {bi.created || 'N/A'}
                        </td>
                        <td className="p-3 text-[11px] text-muted-foreground">
                          {bi.source || 'Server'}
                        </td>
                        <td className="p-3 text-right">
                          <button
                            onClick={() => handleUnbanIp(bi)}
                            className="btn btn-secondary text-[11px] py-1 px-2.5 text-emerald-400 hover:text-emerald-300 border-emerald-500/20"
                          >
                            ✓ Unblock IP
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Subtab 4: Quick Moderation Form ─────────────────────────────────── */}
      {activeSubtab === 'actions' && (
        <div className="card p-6 border border-border/80 space-y-5 max-w-2xl">
          <div>
            <h3 className="font-bold text-base text-foreground">Execute Moderation Action</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Instantly kick, ban, block IP, or manage operator status for any player.
            </p>
          </div>

          <form onSubmit={handleExecuteAction} className="space-y-4">
            {/* Action Selector */}
            <div>
              <label className="block text-xs font-semibold text-foreground mb-1">
                Moderation Action
              </label>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {[
                  { id: 'kick', label: '⚡ Kick Player', color: 'border-amber-500/40 text-amber-400' },
                  { id: 'ban', label: '🚫 Ban Player', color: 'border-red-500/40 text-red-400' },
                  { id: 'ban-ip', label: '🛑 Block IP', color: 'border-rose-500/40 text-rose-400' },
                  { id: 'op', label: '⭐ Toggle OP', color: 'border-primary/40 text-primary' },
                ].map((act) => (
                  <button
                    key={act.id}
                    type="button"
                    onClick={() => setActionType(act.id as 'kick' | 'ban' | 'ban-ip' | 'op')}
                    className={`p-2.5 text-xs font-semibold rounded-lg border transition-all cursor-pointer ${
                      actionType === act.id
                        ? 'bg-primary/20 border-primary text-foreground shadow-sm'
                        : 'bg-card border-border/60 text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {act.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Target Input */}
            <div>
              <label className="block text-xs font-semibold text-foreground mb-1">
                {actionType === 'ban-ip' ? 'Target IP Address or Player Name' : 'Player Username'}
              </label>
              <input
                type="text"
                placeholder={
                  actionType === 'ban-ip'
                    ? 'e.g. 192.168.1.100 or PlayerName'
                    : 'e.g. BadGriefer99'
                }
                value={targetInput}
                onChange={(e) => setTargetInput(e.target.value)}
                className="input w-full text-xs font-mono"
                required
              />
            </div>

            {/* Reason Input (not needed for OP) */}
            {actionType !== 'op' && (
              <div>
                <label className="block text-xs font-semibold text-foreground mb-1">
                  Reason <span className="text-[10px] text-muted-foreground font-mono">(Optional)</span>
                </label>
                <input
                  type="text"
                  placeholder="e.g. Griefing, suspicious activity, language"
                  value={reasonInput}
                  onChange={(e) => setReasonInput(e.target.value)}
                  className="input w-full text-xs"
                />
              </div>
            )}

            <button
              type="submit"
              disabled={submitting || !targetInput.trim()}
              className="btn btn-primary text-xs py-2 px-5 font-bold cursor-pointer"
            >
              {submitting ? 'Executing...' : `Execute ${actionType.toUpperCase()}`}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

