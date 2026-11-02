import { useState, useEffect, useCallback } from 'react';
import {
  api,
  downloadWithAuth,
  type BackupDetail,
  type PublicGoogleDriveConfig,
  type ApiError,
} from '../api/client';
import { useToast } from './Toast';
import { useConfirm } from './ConfirmModal';
import { GoogleDriveConfigModal } from './GoogleDriveConfigModal';

interface ServerBackupsTabProps {
  serverId: string;
  serverStatus: string;
  isMinecraft?: boolean;
}

export function ServerBackupsTab({
  serverId,
  serverStatus,
  isMinecraft = false,
}: ServerBackupsTabProps) {
  const [backups, setBackups] = useState<BackupDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [uploadingId, setUploadingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Modals & configuration
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showGdriveModal, setShowGdriveModal] = useState(false);
  const [gdriveConfig, setGdriveConfig] = useState<PublicGoogleDriveConfig | null>(null);

  // Create form state
  const [backupName, setBackupName] = useState('');
  const [uploadToDrive, setUploadToDrive] = useState(false);

  const { addToast } = useToast();
  const { confirm, ConfirmDialog } = useConfirm();

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      const [backupsRes, driveRes] = await Promise.allSettled([
        api.getServerBackups(serverId),
        api.getGoogleDriveConfig(),
      ]);

      if (backupsRes.status === 'fulfilled') {
        setBackups(backupsRes.value.backups);
      }
      if (driveRes.status === 'fulfilled') {
        setGdriveConfig(driveRes.value);
      }
    } catch (err) {
      console.error('Failed to load server backups:', err);
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  };

  const totalBytes = backups.reduce((acc, b) => acc + (b.sizeBytes || 0), 0);
  const driveSyncedCount = backups.filter((b) => !!b.gdriveFileId).length;

  const handleOpenCreateModal = () => {
    const defaultName = `Backup ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    setBackupName(defaultName);
    setUploadToDrive(Boolean(gdriveConfig?.configured));
    setShowCreateModal(true);
  };

  const handleCreateBackup = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    try {
      await api.createServerBackup(serverId, {
        name: backupName.trim() || undefined,
        uploadToDrive,
      });

      addToast({
        type: 'success',
        title: 'Backup created successfully!',
        message: uploadToDrive
          ? 'Backup snapshot saved! Uploading to Google Drive in the background...'
          : 'Archive saved locally.',
      });

      setShowCreateModal(false);
      await loadData();
      if (uploadToDrive) {
        setTimeout(() => void loadData(), 5000);
        setTimeout(() => void loadData(), 12000);
      }
    } catch (err) {
      const error = err as ApiError;
      addToast({
        type: 'error',
        title: 'Backup creation failed',
        message: error.message || 'Could not archive server volume.',
      });
    } finally {
      setCreating(false);
    }
  };

  const handleRestore = async (backup: BackupDetail) => {
    const ok = await confirm({
      title: `Restore Backup: ${backup.name}?`,
      message:
        'Restoring will replace the server storage volume with this snapshot. The container will be safely paused during extraction and restarted. Any unsaved progress since this backup was made will be replaced. Are you sure you want to proceed?',
      confirmLabel: 'Restore Snapshot',
      variant: 'warning',
    });

    if (!ok) return;

    setRestoringId(backup.id);
    try {
      await api.restoreServerBackup(serverId, backup.id);
      addToast({
        type: 'success',
        title: 'Server restored successfully!',
        message: 'Storage volume restored and container restarted.',
      });
      await loadData();
    } catch (err) {
      const error = err as ApiError;
      addToast({
        type: 'error',
        title: 'Restore failed',
        message: error.message || 'Failed to extract backup snapshot.',
      });
    } finally {
      setRestoringId(null);
    }
  };

  const handleDownload = async (backup: BackupDetail) => {
    const filename = `${backup.name.replace(/[^a-zA-Z0-9_-]/g, '_')}_${backup.id.slice(0, 8)}.tar.gz`;
    try {
      addToast({ type: 'info', title: 'Starting download...' });
      const downloadUrl = api.getServerBackupDownloadUrl(serverId, backup.id);
      await downloadWithAuth(downloadUrl, filename);
    } catch (err) {
      const error = err as Error;
      addToast({
        type: 'error',
        title: 'Download failed',
        message: error.message || 'Could not download backup file.',
      });
    }
  };

  const handleUploadToDrive = async (backup: BackupDetail) => {
    setUploadingId(backup.id);
    try {
      const updated = await api.uploadBackupToDrive(serverId, backup.id);
      addToast({
        type: 'success',
        title: 'Uploaded to Google Drive!',
        message: 'Backup is now safely stored in your Google Drive cloud.',
      });
      setBackups((prev) => prev.map((b) => (b.id === backup.id ? updated : b)));
    } catch (err) {
      const error = err as ApiError;
      addToast({
        type: 'error',
        title: 'Upload to Google Drive failed',
        message: error.message,
      });
    } finally {
      setUploadingId(null);
    }
  };

  const handleDelete = async (backup: BackupDetail) => {
    const ok = await confirm({
      title: `Delete Backup: ${backup.name}?`,
      message:
        'Permanently delete this backup archive from local storage and Google Drive (if synced)? This action cannot be undone.',
      confirmLabel: 'Delete Backup',
      variant: 'danger',
    });

    if (!ok) return;

    setDeletingId(backup.id);
    try {
      await api.deleteServerBackup(serverId, backup.id);
      addToast({
        type: 'success',
        title: 'Backup deleted.',
      });
      setBackups((prev) => prev.filter((b) => b.id !== backup.id));
    } catch (err) {
      const error = err as ApiError;
      addToast({
        type: 'error',
        title: 'Failed to delete backup',
        message: error.message,
      });
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Overview & Action Bar */}
      <div className="card p-6 border border-border/80">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-3">
              <h2 className="text-lg font-bold text-foreground">Server Backups & Restore</h2>
              {gdriveConfig?.configured ? (
                <button
                  onClick={() => setShowGdriveModal(true)}
                  className="badge badge-success text-[10px] py-0.5 px-2.5 flex items-center gap-1.5 cursor-pointer hover:opacity-90"
                  title="Click to view Google Drive settings"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  <span>Google Drive Connected ☁️</span>
                </button>
              ) : (
                <button
                  onClick={() => setShowGdriveModal(true)}
                  className="badge badge-neutral text-[10px] py-0.5 px-2.5 flex items-center gap-1.5 cursor-pointer hover:border-primary/50 text-muted-foreground hover:text-foreground"
                  title="Click to connect Google Drive"
                >
                  <span>☁️ Connect Google Drive</span>
                </button>
              )}
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed max-w-2xl">
              Create complete `.tar.gz` snapshots of your world, configurations, player inventories, and mods.
              {isMinecraft && (
                <span className="text-primary font-medium ml-1">
                  Minecraft live flush automatically issues RCON <code>save-all flush</code> before archiving.
                </span>
              )}
            </p>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            <button
              onClick={() => void loadData()}
              disabled={loading}
              className="btn btn-secondary btn-sm py-2 px-3 text-xs"
              title="Refresh backups list"
            >
              🔄 Refresh
            </button>
            <button
              onClick={handleOpenCreateModal}
              disabled={creating || restoringId !== null}
              className="btn btn-primary btn-sm py-2 px-4 font-bold text-xs flex items-center gap-1.5 cursor-pointer shadow-lg shadow-primary/20"
            >
              <span>💾</span>
              <span>Create Backup Now</span>
            </button>
          </div>
        </div>

        {/* Stats Row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-6 pt-5 border-t border-border/60 text-xs">
          <div>
            <span className="text-muted-foreground block text-[11px] mb-0.5">Total Backups</span>
            <span className="font-mono text-base font-bold text-foreground">{backups.length}</span>
          </div>
          <div>
            <span className="text-muted-foreground block text-[11px] mb-0.5">Storage Used</span>
            <span className="font-mono text-base font-bold text-primary">{formatBytes(totalBytes)}</span>
          </div>
          <div>
            <span className="text-muted-foreground block text-[11px] mb-0.5">Google Drive Synced</span>
            <span className="font-mono text-base font-bold text-emerald-400">
              {driveSyncedCount} / {backups.length}
            </span>
          </div>
          <div>
            <span className="text-muted-foreground block text-[11px] mb-0.5">Latest Snapshot</span>
            <span className="font-mono text-xs font-semibold text-zinc-300">
              {backups.length > 0 ? new Date(backups[0].createdAt).toLocaleDateString() : 'None yet'}
            </span>
          </div>
        </div>
      </div>

      {/* Backups List */}
      <div className="card p-6 border border-border/80 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-bold text-sm text-foreground">Snapshot History</h3>
          <span className="text-[11px] text-muted-foreground font-mono">
            Server status: <span className="capitalize text-foreground font-semibold">{serverStatus}</span>
          </span>
        </div>

        {loading ? (
          <div className="py-12 flex flex-col items-center justify-center text-center text-muted-foreground gap-2">
            <span className="animate-spin text-2xl text-primary">⟳</span>
            <span className="text-xs">Loading backup archives...</span>
          </div>
        ) : backups.length === 0 ? (
          <div className="py-14 text-center space-y-3 rounded-xl border border-dashed border-border/80 bg-card-subtle/50 p-6">
            <div className="text-4xl">💾</div>
            <div>
              <h4 className="text-sm font-bold text-foreground">No backups created yet</h4>
              <p className="text-xs text-muted-foreground mt-1 max-w-md mx-auto">
                Protect your game progress against corruption, griefing, or accidental mod breakages by creating your first backup.
              </p>
            </div>
            <button
              onClick={handleOpenCreateModal}
              className="btn btn-primary text-xs py-2 px-5 font-bold cursor-pointer"
            >
              Create First Backup Now
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {backups.map((b) => (
              <div
                key={b.id}
                className="p-4 rounded-xl border border-border bg-card-subtle flex flex-col md:flex-row md:items-center justify-between gap-4 transition-all hover:border-border/90"
              >
                <div className="space-y-1.5 min-w-0">
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <span className="font-bold text-sm text-foreground truncate">{b.name}</span>
                    <span className="badge badge-neutral text-[10px] py-0 px-2 font-mono">
                      {formatBytes(b.sizeBytes)}
                    </span>
                    {b.gdriveFileId ? (
                      <span className="badge badge-success text-[10px] py-0 px-2 flex items-center gap-1">
                        <span>☁️</span>
                        <span>Google Drive</span>
                      </span>
                    ) : (
                      <span className="badge badge-neutral text-[10px] py-0 px-2 text-muted-foreground">
                        💻 Local Only
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 text-[11px] text-muted-foreground font-mono flex-wrap">
                    <span>📅 {new Date(b.createdAt).toLocaleString()}</span>
                    <span>&bull;</span>
                    <span className="truncate max-w-[220px]">ID: {b.id}</span>
                    {b.gdriveWebLink && (
                      <>
                        <span>&bull;</span>
                        <a
                          href={b.gdriveWebLink}
                          target="_blank"
                          rel="noreferrer"
                          className="text-primary hover:underline flex items-center gap-1 font-sans"
                        >
                          <span>Open in Drive</span>
                          <span>↗</span>
                        </a>
                      </>
                    )}
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 shrink-0 flex-wrap">
                  {/* Upload to Drive (if not yet synced) */}
                  {!b.gdriveFileId && gdriveConfig?.configured && (
                    <button
                      onClick={() => handleUploadToDrive(b)}
                      disabled={uploadingId === b.id}
                      className="btn btn-secondary btn-sm text-[11px] py-1.5 px-3 flex items-center gap-1 cursor-pointer"
                      title="Upload snapshot to Google Drive"
                    >
                      {uploadingId === b.id ? (
                        <span className="animate-spin text-xs">⟳</span>
                      ) : (
                        <span>☁️</span>
                      )}
                      <span>{uploadingId === b.id ? 'Syncing...' : 'Sync to Drive'}</span>
                    </button>
                  )}

                  {/* Download */}
                  <button
                    onClick={() => handleDownload(b)}
                    className="btn btn-secondary btn-sm text-[11px] py-1.5 px-3 flex items-center gap-1 cursor-pointer"
                    title="Download .tar.gz archive"
                  >
                    <span>⬇️</span>
                    <span>Download</span>
                  </button>

                  {/* Restore */}
                  <button
                    onClick={() => handleRestore(b)}
                    disabled={restoringId === b.id}
                    className="btn btn-primary btn-sm text-[11px] py-1.5 px-3.5 font-bold flex items-center gap-1 cursor-pointer shadow-sm"
                    title="Restore server from this snapshot"
                  >
                    {restoringId === b.id ? (
                      <span className="animate-spin text-xs">⟳</span>
                    ) : (
                      <span>🔄</span>
                    )}
                    <span>{restoringId === b.id ? 'Restoring...' : 'Restore'}</span>
                  </button>

                  {/* Delete */}
                  <button
                    onClick={() => handleDelete(b)}
                    disabled={deletingId === b.id}
                    className="btn btn-ghost btn-sm text-[11px] text-destructive hover:bg-destructive/10 py-1.5 px-2.5 cursor-pointer"
                    title="Delete backup"
                  >
                    {deletingId === b.id ? (
                      <span className="animate-spin text-xs">⟳</span>
                    ) : (
                      <span>🗑️</span>
                    )}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Create Backup Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-md animate-fade-in p-4">
          <div className="card max-w-lg w-full p-0 border border-border shadow-2xl overflow-hidden">
            <div className="h-1 w-full bg-gradient-to-r from-primary to-blue-500" />
            <div className="p-6 border-b border-border/60 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/30 flex items-center justify-center text-xl">
                  💾
                </div>
                <div>
                  <h3 className="text-base font-bold text-foreground">Create Server Backup</h3>
                  <p className="text-xs text-muted-foreground">
                    Generate an instant snapshot of this game server
                  </p>
                </div>
              </div>
              <button
                onClick={() => setShowCreateModal(false)}
                className="btn btn-ghost btn-sm text-lg text-muted-foreground hover:text-foreground"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleCreateBackup} className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-semibold text-foreground mb-1">
                  Backup Label / Name
                </label>
                <input
                  type="text"
                  value={backupName}
                  onChange={(e) => setBackupName(e.target.value)}
                  placeholder="e.g. Pre-Ender-Dragon-Fight"
                  maxLength={80}
                  className="input w-full text-xs"
                />
                <p className="text-[11px] text-muted-foreground mt-1">
                  A descriptive name to identify this snapshot later.
                </p>
              </div>

              {/* Google Drive Upload Option */}
              <div className="p-3.5 rounded-xl border border-border bg-card-subtle space-y-2">
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={uploadToDrive}
                    onChange={(e) => setUploadToDrive(e.target.checked)}
                    disabled={!gdriveConfig?.configured}
                    className="mt-0.5 rounded border-border"
                  />
                  <div className="space-y-0.5 text-xs">
                    <span className="font-semibold text-foreground flex items-center gap-1.5">
                      <span>☁️ Sync directly to Google Drive</span>
                      {gdriveConfig?.configured ? (
                        <span className="badge badge-success text-[9px] py-0 px-1.5">Connected</span>
                      ) : (
                        <span className="badge badge-neutral text-[9px] py-0 px-1.5">Not Configured</span>
                      )}
                    </span>
                    <p className="text-muted-foreground text-[11px]">
                      Automatically uploads the compressed archive to your Google Drive for off-site disaster recovery.
                    </p>
                  </div>
                </label>

                {!gdriveConfig?.configured && (
                  <div className="pt-2 border-t border-border/40 flex items-center justify-between text-[11px]">
                    <span className="text-muted-foreground">Google Drive is not set up yet.</span>
                    <button
                      type="button"
                      onClick={() => {
                        setShowCreateModal(false);
                        setShowGdriveModal(true);
                      }}
                      className="text-primary hover:underline font-semibold cursor-pointer"
                    >
                      Connect Google Drive →
                    </button>
                  </div>
                )}
              </div>

              {/* Notice */}
              <div className="p-3 rounded-lg bg-blue-500/10 border border-blue-500/20 text-[11px] text-zinc-300 flex items-start gap-2">
                <span>ℹ️</span>
                <span>
                  The archive will be compressed into a standard <code>.tar.gz</code> bundle containing all world files, configs, and plugins.
                </span>
              </div>

              <div className="flex items-center justify-end gap-2 pt-4 border-t border-border/60">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="btn btn-secondary text-xs py-2 px-4"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="btn btn-primary text-xs py-2 px-5 font-bold cursor-pointer flex items-center gap-1.5"
                >
                  {creating && <span className="animate-spin text-xs">⟳</span>}
                  <span>{creating ? 'Compressing & Archiving...' : 'Create Backup'}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Google Drive Configuration Modal */}
      <GoogleDriveConfigModal
        open={showGdriveModal}
        onClose={() => setShowGdriveModal(false)}
        onSaved={() => void loadData()}
      />

      {ConfirmDialog}
    </div>
  );
}

