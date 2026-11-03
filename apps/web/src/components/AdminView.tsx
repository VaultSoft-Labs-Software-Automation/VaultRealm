import { useState, useEffect } from 'react';
import {
  api,
  downloadWithAuth,
  type CapacityStatus,
  type PublicGoogleDriveConfig,
  type SystemBackupDetail,
  type ApiError,
} from '../api/client';
import { useToast } from './Toast';
import { GoogleDriveConfigModal } from './GoogleDriveConfigModal';

interface AdminViewProps {
  onBack: () => void;
}

export function AdminView({ onBack }: AdminViewProps) {
  const [invites, setInvites] = useState<Array<{ id: string; code: string; uses: number; maxUses: number; createdAt: string }>>([]);
  const [capacity, setCapacity] = useState<CapacityStatus | null>(null);
  const [maxUses, setMaxUses] = useState(10);
  const [creating, setCreating] = useState(false);

  // Telegram Bot Management
  const [telegramConfig, setTelegramConfig] = useState<import('../api/client').PublicTelegramConfig | null>(null);
  const [telegramToken, setTelegramToken] = useState('');
  const [telegramChatIds, setTelegramChatIds] = useState('');
  const [telegramEnabled, setTelegramEnabled] = useState(false);
  const [telegramNotifications, setTelegramNotifications] = useState(true);
  const [savingTelegram, setSavingTelegram] = useState(false);

  // Google Drive & System Backups
  const [gdriveConfig, setGdriveConfig] = useState<PublicGoogleDriveConfig | null>(null);
  const [systemBackups, setSystemBackups] = useState<SystemBackupDetail[]>([]);
  const [showGdriveModal, setShowGdriveModal] = useState(false);
  const [creatingSystemBackup, setCreatingSystemBackup] = useState(false);
  const [systemUploadToDrive, setSystemUploadToDrive] = useState(false);

  const { addToast } = useToast();

  const loadData = async () => {
    try {
      const [invitesData, capacityData, driveData, systemBackupsData, telegramData] = await Promise.allSettled([
        api.listInvites(),
        api.getCapacity(),
        api.getGoogleDriveConfig(),
        api.listSystemBackups(),
        api.getTelegramConfig(),
      ]);

      if (invitesData.status === 'fulfilled') setInvites(invitesData.value);
      if (capacityData.status === 'fulfilled') setCapacity(capacityData.value);
      if (driveData.status === 'fulfilled') {
        setGdriveConfig(driveData.value);
        if (driveData.value.configured) {
          setSystemUploadToDrive(true);
        }
      }
      if (systemBackupsData.status === 'fulfilled') setSystemBackups(systemBackupsData.value.backups);
      if (telegramData.status === 'fulfilled') {
        setTelegramConfig(telegramData.value);
        setTelegramEnabled(telegramData.value.enabled);
        setTelegramNotifications(telegramData.value.notificationsEnabled);
        setTelegramChatIds((telegramData.value.allowedChatIds || []).join(', '));
      }
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleSaveTelegram = async () => {
    setSavingTelegram(true);
    try {
      const chatIds = telegramChatIds.split(',').map((id) => id.trim()).filter(Boolean);
      const data: { token?: string; enabled: boolean; allowedChatIds: string[]; notificationsEnabled: boolean } = {
        enabled: telegramEnabled,
        allowedChatIds: chatIds,
        notificationsEnabled: telegramNotifications,
      };
      if (telegramToken.trim()) data.token = telegramToken.trim();
      const result = await api.saveTelegramConfig(data);
      setTelegramConfig(result.config);
      setTelegramToken('');
      addToast({ type: 'success', title: 'Telegram bot settings saved.' });
    } catch (err) {
      const error = err as ApiError;
      addToast({ type: 'error', title: 'Could not save Telegram settings', message: error.message });
    } finally {
      setSavingTelegram(false);
    }
  };

  const handleCreateInvite = async () => {
    setCreating(true);
    try {
      const inv = await api.createInvite(maxUses);
      addToast({ type: 'success', title: `Invite created: ${inv.code}` });
      await loadData();
    } catch (err) {
      const error = err as ApiError;
      addToast({ type: 'error', title: 'Could not create invite', message: error.message });
    } finally {
      setCreating(false);
    }
  };

  const handleDeleteInvite = async (id: string) => {
    try {
      await api.deleteInvite(id);
      addToast({ type: 'success', title: 'Invite code revoked.' });
      setInvites((prev) => prev.filter((i) => i.id !== id));
    } catch (err) {
      const error = err as ApiError;
      addToast({ type: 'error', title: 'Could not delete invite', message: error.message });
    }
  };

  const handleCreateSystemBackup = async () => {
    setCreatingSystemBackup(true);
    try {
      const b = await api.createSystemBackup({ uploadToDrive: systemUploadToDrive });
      addToast({
        type: 'success',
        title: 'Full System Snapshot Created!',
        message: b.gdriveFileId
          ? 'Database & configurations backed up and uploaded to Google Drive.'
          : 'Database & configurations safely archived locally.',
      });
      await loadData();
    } catch (err) {
      const error = err as ApiError;
      addToast({
        type: 'error',
        title: 'System backup failed',
        message: error.message || 'Could not archive system state.',
      });
    } finally {
      setCreatingSystemBackup(false);
    }
  };

  const handleDownloadSystemBackup = async (filename: string) => {
    try {
      addToast({ type: 'info', title: 'Starting system backup download...' });
      const url = api.getSystemBackupDownloadUrl(filename);
      await downloadWithAuth(url, filename);
    } catch (err) {
      const error = err as Error;
      addToast({
        type: 'error',
        title: 'Download failed',
        message: error.message || 'Could not download system snapshot.',
      });
    }
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center justify-between border-b border-border pb-4">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="btn btn-secondary btn-sm"
          >
            ← Back
          </button>
          <div>
            <h1 className="text-xl font-bold text-foreground">Admin Control Plane</h1>
            <p className="text-xs text-muted-foreground">Manage registration invites, host capacity, Google Drive sync, and disaster recovery</p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Create & Manage Invites */}
        <div className="card p-6 border border-border/80 space-y-4">
          <h2 className="text-base font-bold text-foreground">Community Registration Invites</h2>
          <p className="text-xs text-muted-foreground">
            VaultRealm is invite-only to protect host resources. Generate codes for friends and community players.
          </p>

          <div className="flex flex-col sm:flex-row gap-2">
            <div className="flex-1">
              <input
                type="number"
                min={1}
                max={100}
                value={maxUses}
                onChange={(e) => setMaxUses(Number(e.target.value))}
                placeholder="Max uses"
                className="input w-full text-xs"
              />
            </div>
            <button
              onClick={handleCreateInvite}
              disabled={creating}
              className="btn btn-primary text-xs px-4 py-2 font-bold cursor-pointer shrink-0"
            >
              Generate Invite Code 🎟️
            </button>
          </div>

          <div className="space-y-2 mt-4 max-h-72 overflow-y-auto">
            {invites.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">No active invites generated yet.</p>
            ) : (
              invites.map((inv) => (
                <div
                  key={inv.id}
                  className="p-3 rounded-lg border border-border bg-card-subtle flex items-center justify-between text-xs font-mono"
                >
                  <div>
                    <span className="font-bold text-primary mr-3">{inv.code}</span>
                    <span className="text-muted-foreground text-[10px]">
                      {inv.uses} / {inv.maxUses} uses
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(inv.code);
                        addToast({ type: 'info', title: 'Invite code copied!' });
                      }}
                      className="btn btn-secondary btn-sm text-[11px] py-1 px-2.5"
                    >
                      📋 Copy
                    </button>
                    <button
                      onClick={() => handleDeleteInvite(inv.id)}
                      className="btn btn-danger btn-sm text-[11px] py-1 px-2"
                    >
                      Revoke
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Host Node Specs */}
        <div className="card p-6 border border-border/80 space-y-4">
          <h2 className="text-base font-bold text-foreground">Host Infrastructure</h2>
          <p className="text-xs text-muted-foreground">
            Docker host node hardware and budget thresholds
          </p>

          <div className="space-y-3 text-xs">
            <div className="flex justify-between py-2 border-b border-border/40">
              <span className="text-muted-foreground">Total Physical RAM</span>
              <span className="font-mono text-foreground font-bold">
                {capacity?.host.totalHostRamMb} MB
              </span>
            </div>
            <div className="flex justify-between py-2 border-b border-border/40">
              <span className="text-muted-foreground">Safety Budget Cap</span>
              <span className="font-mono text-primary font-bold">
                {capacity?.host.budgetPct}% ({capacity?.host.budgetRamMb} MB)
              </span>
            </div>
            <div className="flex justify-between py-2 border-b border-border/40">
              <span className="text-muted-foreground">Allocated Server Memory</span>
              <span className="font-mono text-foreground">
                {capacity?.host.allocatedRamMb} MB
              </span>
            </div>
            <div className="flex justify-between py-2 border-b border-border/40">
              <span className="text-muted-foreground">Available Allocation Buffer</span>
              <span className="font-mono text-emerald-400 font-bold">
                {capacity?.host.availableBudgetRamMb} MB
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Telegram Bot Management */}
      <div className="card p-6 border border-border/80 space-y-5">
        <div className="flex items-center justify-between border-b border-border/60 pb-4">
          <div>
            <h2 className="text-base font-bold text-foreground">Telegram Server Management Bot</h2>
            <p className="text-xs text-muted-foreground mt-1">
              Manage server power, Minecraft settings, console commands, and backups from Telegram.
            </p>
          </div>
          <span className={`badge ${telegramConfig?.configured && telegramEnabled ? 'badge-success' : 'badge-neutral'}`}>
            {telegramConfig?.configured && telegramEnabled ? 'Active' : 'Not active'}
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <label className="space-y-1.5">
            <span className="text-xs font-semibold text-foreground">Bot Token</span>
            <input
              type="password"
              value={telegramToken}
              onChange={(e) => setTelegramToken(e.target.value)}
              placeholder={telegramConfig?.configured ? 'Token already configured (enter to replace)' : 'Paste token from @BotFather'}
              className="input w-full text-xs"
            />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-semibold text-foreground">Allowed Telegram User/Chat IDs</span>
            <input
              type="text"
              value={telegramChatIds}
              onChange={(e) => setTelegramChatIds(e.target.value)}
              placeholder="123456789, -1001234567890"
              className="input w-full text-xs"
            />
            <span className="text-[10px] text-muted-foreground">Use /start with the bot to see your IDs. Separate multiple IDs with commas.</span>
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-5 text-xs">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={telegramEnabled} onChange={(e) => setTelegramEnabled(e.target.checked)} />
            Enable bot management
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={telegramNotifications} onChange={(e) => setTelegramNotifications(e.target.checked)} />
            Send server alerts
          </label>
        </div>

        <div className="flex justify-end">
          <button onClick={handleSaveTelegram} disabled={savingTelegram} className="btn btn-primary text-xs">
            {savingTelegram ? 'Saving...' : 'Save Telegram Settings'}
          </button>
        </div>
      </div>

      {/* Disaster Recovery & Google Drive Cloud Storage */}
      <div className="card p-6 border border-border/80 space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border/60 pb-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2.5">
              <h2 className="text-base font-bold text-foreground">Disaster Recovery & Google Drive Cloud Storage</h2>
              {gdriveConfig?.configured ? (
                <span className="badge badge-success text-[10px] py-0 px-2 flex items-center gap-1">
                  <span>☁️</span>
                  <span>Drive Connected</span>
                </span>
              ) : (
                <span className="badge badge-neutral text-[10px] py-0 px-2 text-muted-foreground">
                  ☁️ Drive Not Configured
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Automated off-site disaster recovery. Snapshot the SQLite database, server metadata, and configs with 1-click Google Drive sync.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowGdriveModal(true)}
              className="btn btn-secondary text-xs py-2 px-3.5 flex items-center gap-1.5 cursor-pointer"
            >
              <span>⚙️</span>
              <span>{gdriveConfig?.configured ? 'Manage Google Drive' : 'Connect Google Drive'}</span>
            </button>
          </div>
        </div>

        {/* Snapshot trigger card */}
        <div className="p-4 rounded-xl bg-card-subtle border border-border/80 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-1">
            <h3 className="text-xs font-bold text-foreground">Full Panel Database Snapshot</h3>
            <p className="text-[11px] text-muted-foreground">
              Archives <code>panel.db</code>, SQLite WAL/SHM journaling state, and panel configuration files into a self-contained disaster recovery archive.
            </p>
            {gdriveConfig?.configured && (
              <label className="flex items-center gap-2 cursor-pointer pt-1 text-xs">
                <input
                  type="checkbox"
                  checked={systemUploadToDrive}
                  onChange={(e) => setSystemUploadToDrive(e.target.checked)}
                  className="rounded border-border"
                />
                <span className="text-zinc-300">Sync snapshot directly to Google Drive</span>
              </label>
            )}
          </div>

          <button
            onClick={handleCreateSystemBackup}
            disabled={creatingSystemBackup}
            className="btn btn-primary text-xs py-2.5 px-4 font-bold flex items-center gap-2 cursor-pointer shadow-md shadow-primary/20 shrink-0"
          >
            {creatingSystemBackup ? <span className="animate-spin text-xs">⟳</span> : <span>💾</span>}
            <span>{creatingSystemBackup ? 'Archiving System...' : 'Create Full System Backup'}</span>
          </button>
        </div>

        {/* System Backups List */}
        <div className="space-y-3">
          <h3 className="text-xs font-bold text-foreground">System Snapshots</h3>
          {systemBackups.length === 0 ? (
            <p className="text-xs text-muted-foreground italic py-3">No system disaster recovery snapshots created yet.</p>
          ) : (
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {systemBackups.map((sb) => (
                <div
                  key={sb.filename}
                  className="p-3 rounded-lg border border-border bg-card flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
                >
                  <div className="space-y-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono font-bold text-foreground truncate">{sb.filename}</span>
                      <span className="badge badge-neutral text-[10px] py-0 px-1.5 font-mono">
                        {formatBytes(sb.sizeBytes)}
                      </span>
                      {sb.gdriveFileId ? (
                        <span className="badge badge-success text-[10px] py-0 px-1.5">☁️ Synced to Drive</span>
                      ) : (
                        <span className="badge badge-neutral text-[10px] py-0 px-1.5 text-muted-foreground">Local Only</span>
                      )}
                    </div>
                    <div className="text-[10px] text-muted-foreground font-mono">
                      Created: {new Date(sb.createdAt).toLocaleString()}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {sb.gdriveWebLink && (
                      <a
                        href={sb.gdriveWebLink}
                        target="_blank"
                        rel="noreferrer"
                        className="btn btn-secondary btn-sm text-[11px] py-1 px-2.5 flex items-center gap-1"
                      >
                        <span>Drive</span>
                        <span>↗</span>
                      </a>
                    )}
                    <button
                      onClick={() => handleDownloadSystemBackup(sb.filename)}
                      className="btn btn-primary btn-sm text-[11px] py-1 px-3 flex items-center gap-1 font-semibold cursor-pointer"
                    >
                      <span>⬇️</span>
                      <span>Download</span>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Google Drive Configuration Modal */}
      <GoogleDriveConfigModal
        open={showGdriveModal}
        onClose={() => setShowGdriveModal(false)}
        onSaved={() => void loadData()}
      />
    </div>
  );
}
