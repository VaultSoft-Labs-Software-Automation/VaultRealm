import { useState, useEffect, useCallback } from 'react';
import {
  api,
  type PublicGoogleDriveConfig,
  type GoogleDriveTestResult,
  type ApiError,
} from '../api/client';
import { useToast } from './Toast';

interface GoogleDriveConfigModalProps {
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
}

type SetupTab = 'login' | 'shared-folder' | 'manual';

const APPS_SCRIPT_TEMPLATE = `// VaultRealm Google Drive Shared Folder Webhook
// Deploy as: Web app (Execute as: Me, Who has access: Anyone)
function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var folder = DriveApp.getRootFolder();
    if (data.folderId) {
      try { folder = DriveApp.getFolderById(data.folderId); } catch(err) {}
    }
    if (data.action === 'ping') {
      return ContentService.createTextOutput(JSON.stringify({
        ok: true,
        folderName: folder.getName(),
        folderId: folder.getId()
      })).setMimeType(ContentService.MimeType.JSON);
    }
    if (data.action === 'upload') {
      var decoded = Utilities.base64Decode(data.contentBase64);
      var blob = Utilities.newBlob(decoded, 'application/gzip', data.filename);
      var file = folder.createFile(blob);
      if (data.description) file.setDescription(data.description);
      return ContentService.createTextOutput(JSON.stringify({
        ok: true,
        fileId: file.getId(),
        webViewLink: file.getUrl(),
        filename: file.getName()
      })).setMimeType(ContentService.MimeType.JSON);
    }
    if (data.action === 'delete') {
      DriveApp.getFileById(data.fileId).setTrashed(true);
      return ContentService.createTextOutput(JSON.stringify({ ok: true })).setMimeType(ContentService.MimeType.JSON);
    }
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'Unknown action' })).setMimeType(ContentService.MimeType.JSON);
  } catch(err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: err.toString() })).setMimeType(ContentService.MimeType.JSON);
  }
}
function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({ ok: true, service: 'VaultRealm Webhook' })).setMimeType(ContentService.MimeType.JSON);
}`;

export function GoogleDriveConfigModal({ open, onClose, onSaved }: GoogleDriveConfigModalProps) {
  const [activeTab, setActiveTab] = useState<SetupTab>('login');
  const [loading, setLoading] = useState(false);
  const [testing, setTesting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [config, setConfig] = useState<PublicGoogleDriveConfig | null>(null);

  // Tab 1: Google Login (OAuth)
  const [oauthClientId, setOauthClientId] = useState('');
  const [oauthClientSecret, setOauthClientSecret] = useState('');
  const [authCode, setAuthCode] = useState('');
  const [showCodeInput, setShowCodeInput] = useState(false);
  const [showCustomCredentials, setShowCustomCredentials] = useState(false);
  const [savingAppCreds, setSavingAppCreds] = useState(false);
  const [copiedRedirectUri, setCopiedRedirectUri] = useState(false);

  // Tab 2: Shared Folder (Google Apps Script Webhook)
  const [webhookUrl, setWebhookUrl] = useState('');
  const [webhookFolderId, setWebhookFolderId] = useState('');
  const [copiedScript, setCopiedScript] = useState(false);

  // Tab 3: Manual OAuth
  const [manualClientId, setManualClientId] = useState('');
  const [manualClientSecret, setManualClientSecret] = useState('');
  const [manualRefreshToken, setManualRefreshToken] = useState('');
  const [manualFolderId, setManualFolderId] = useState('');

  const [testResult, setTestResult] = useState<GoogleDriveTestResult | null>(null);

  const { addToast } = useToast();

  const fetchConfig = useCallback(async () => {
    try {
      setLoading(true);
      const data = await api.getGoogleDriveConfig();
      setConfig(data);
      if (data.configured) {
        if (data.mode === 'webhook') {
          setActiveTab('shared-folder');
          setWebhookFolderId(data.folderId || '');
        } else {
          setActiveTab('login');
          if (data.clientId) {
            setOauthClientId(data.clientId);
            setManualClientId(data.clientId);
          }
          setManualFolderId(data.folderId || '');
        }
      } else {
        // Not configured yet
        if (data.clientId) {
          setOauthClientId(data.clientId);
          setManualClientId(data.clientId);
        }
        if (!data.hasClientCredentials && !data.hasEnvCredentials) {
          setShowCustomCredentials(true);
        }
      }
    } catch (err) {
      console.error('Failed to load Google Drive configuration:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void fetchConfig();
  }, [open, fetchConfig]);

  // Listen for popup callback message
  useEffect(() => {
    const handleMessage = (e: MessageEvent) => {
      if (e.data && e.data.type === 'GDRIVE_AUTH_SUCCESS') {
        addToast({
          type: 'success',
          title: 'Google Drive connected successfully!',
          message: e.data.config?.userName
            ? `Signed in as ${e.data.config.userName}`
            : 'Google Drive is now active for off-site backups.',
        });
        void fetchConfig();
        onSaved?.();
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [fetchConfig, onSaved, addToast]);

  if (!open) return null;

  // 1-Click "Sign in with Google"
  const handleSignInWithGoogle = async () => {
    // Check if we have credentials
    const hasCreds =
      config?.hasClientCredentials ||
      config?.hasEnvCredentials ||
      (oauthClientId.trim() && oauthClientSecret.trim());

    if (!hasCreds) {
      setShowCustomCredentials(true);
      addToast({
        type: 'warning',
        title: 'OAuth Credentials Required',
        message: 'Please enter your Google Client ID and Client Secret below before signing in.',
      });
      return;
    }

    setLoading(true);
    try {
      const redirectUri = `${window.location.origin}/api/system/google-drive/callback`;
      const res = await api.getGoogleDriveAuthUrl({
        redirectUri,
        clientId: oauthClientId.trim() || undefined,
        clientSecret: oauthClientSecret.trim() || undefined,
      });

      // Open OAuth consent in a centered popup
      const width = 550;
      const height = 650;
      const left = window.screenX + (window.outerWidth - width) / 2;
      const top = window.screenY + (window.outerHeight - height) / 2;
      const popup = window.open(
        res.url,
        'vaultrealm_google_auth',
        `width=${width},height=${height},left=${left},top=${top},status=0,menubar=0,toolbar=0`,
      );

      if (!popup || popup.closed) {
        // Fallback to direct redirect if popup blocked
        window.location.href = res.url;
      }
    } catch (err) {
      const error = err as ApiError;
      addToast({
        type: 'error',
        title: 'Could not start Google Sign-In',
        message: error.message || 'Please verify your Google Client ID and Client Secret.',
      });
      setShowCustomCredentials(true);
    } finally {
      setLoading(false);
    }
  };

  const handleSaveAppCredentials = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!oauthClientId.trim()) {
      addToast({ type: 'warning', title: 'Google Client ID is required.' });
      return;
    }

    setSavingAppCreds(true);
    try {
      const res = await api.saveGoogleDriveAppCredentials({
        clientId: oauthClientId.trim(),
        clientSecret: oauthClientSecret.trim() || undefined,
      });
      setConfig(res.config);
      setOauthClientSecret('');
      addToast({
        type: 'success',
        title: 'OAuth Credentials Saved!',
        message: 'Client ID and Secret stored securely. You can now click "Sign in with Google".',
      });
    } catch (err) {
      const error = err as ApiError;
      addToast({
        type: 'error',
        title: 'Failed to save OAuth credentials',
        message: error.message,
      });
    } finally {
      setSavingAppCreds(false);
    }
  };

  const handleCopyRedirectUri = () => {
    const uri = `${window.location.origin}/api/system/google-drive/callback`;
    navigator.clipboard.writeText(uri);
    setCopiedRedirectUri(true);
    addToast({ type: 'info', title: 'Authorized Redirect URI copied to clipboard!' });
    setTimeout(() => setCopiedRedirectUri(false), 3000);
  };

  // Submit Authorization Code directly
  const handleExchangeCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!authCode.trim()) return;

    setLoading(true);
    try {
      const redirectUri = `${window.location.origin}/api/system/google-drive/callback`;
      const res = await api.exchangeGoogleDriveCode({
        code: authCode.trim(),
        redirectUri,
        clientId: oauthClientId.trim() || undefined,
        clientSecret: oauthClientSecret.trim() || undefined,
      });

      setConfig(res.config);
      setAuthCode('');
      setShowCodeInput(false);
      addToast({
        type: 'success',
        title: 'Google Drive connected!',
        message: `Authenticated as ${res.config.userName || res.config.userEmail || 'Google User'}.`,
      });
      onSaved?.();
    } catch (err) {
      const error = err as ApiError;
      addToast({
        type: 'error',
        title: 'Authentication failed',
        message: error.message,
      });
    } finally {
      setLoading(false);
    }
  };

  // Connect Shared Folder (Google Apps Script Webhook)
  const handleSaveWebhook = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!webhookUrl.trim()) {
      addToast({ type: 'warning', title: 'Webhook URL is required.' });
      return;
    }

    setLoading(true);
    try {
      const res = await api.saveGoogleDriveConfig({
        mode: 'webhook',
        webhookUrl: webhookUrl.trim(),
        folderId: webhookFolderId.trim() || undefined,
      });

      setConfig(res.config);
      addToast({
        type: 'success',
        title: 'Google Drive Folder Connected!',
        message: 'Backups will now automatically upload to your shared Google Drive folder.',
      });
      onSaved?.();
    } catch (err) {
      const error = err as ApiError;
      addToast({
        type: 'error',
        title: 'Could not connect shared folder',
        message: error.message,
      });
    } finally {
      setLoading(false);
    }
  };

  // Save Manual OAuth
  const handleSaveManualOAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualClientId.trim()) {
      addToast({ type: 'warning', title: 'Client ID is required.' });
      return;
    }
    if (!config?.configured && (!manualClientSecret.trim() || !manualRefreshToken.trim())) {
      addToast({ type: 'warning', title: 'Client Secret and Refresh Token are required.' });
      return;
    }

    setLoading(true);
    try {
      const res = await api.saveGoogleDriveConfig({
        mode: 'oauth',
        clientId: manualClientId.trim(),
        clientSecret: manualClientSecret.trim() || undefined,
        refreshToken: manualRefreshToken.trim() || undefined,
        folderId: manualFolderId.trim() || undefined,
      });

      setConfig(res.config);
      setManualClientSecret('');
      setManualRefreshToken('');
      addToast({
        type: 'success',
        title: 'Google Drive credentials updated!',
      });
      onSaved?.();
    } catch (err) {
      const error = err as ApiError;
      addToast({
        type: 'error',
        title: 'Failed to save configuration',
        message: error.message,
      });
    } finally {
      setLoading(false);
    }
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await api.testGoogleDriveConnection();
      setTestResult(res.details);
      addToast({
        type: 'success',
        title: 'Connection test passed!',
        message: res.details.folderName
          ? `Connected to "${res.details.folderName}"`
          : 'Google Drive is responding properly.',
      });
    } catch (err) {
      const error = err as ApiError;
      setTestResult({ ok: false, error: error.message });
      addToast({
        type: 'error',
        title: 'Connection test failed',
        message: error.message,
      });
    } finally {
      setTesting(false);
    }
  };

  const handleDisconnect = async () => {
    if (!confirm('Disconnect Google Drive from VaultRealm? Local server files remain intact.')) {
      return;
    }
    setDisconnecting(true);
    try {
      await api.deleteGoogleDriveConfig();
      setConfig({ configured: false });
      setTestResult(null);
      setAuthCode('');
      setWebhookUrl('');
      addToast({ type: 'info', title: 'Google Drive disconnected.' });
      onSaved?.();
    } catch (err) {
      const error = err as ApiError;
      addToast({ type: 'error', title: 'Failed to disconnect', message: error.message });
    } finally {
      setDisconnecting(false);
    }
  };

  const handleCopyScript = () => {
    navigator.clipboard.writeText(APPS_SCRIPT_TEMPLATE);
    setCopiedScript(true);
    addToast({ type: 'info', title: 'Google Apps Script copied to clipboard!' });
    setTimeout(() => setCopiedScript(false), 3000);
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-md animate-fade-in p-4">
      <div className="card max-w-xl w-full p-0 border border-border shadow-2xl overflow-hidden flex flex-col max-h-[92vh]">
        {/* Accent Bar */}
        <div className="h-1.5 w-full bg-gradient-to-r from-blue-500 via-emerald-400 to-indigo-500" />

        {/* Header */}
        <div className="p-5 sm:p-6 border-b border-border/60 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-blue-500/10 border border-blue-500/30 flex items-center justify-center text-xl shrink-0">
              ☁️
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-bold text-foreground">Google Drive Cloud Storage</h3>
                {config?.configured ? (
                  <span className="badge badge-success text-[10px] py-0 px-2 flex items-center gap-1">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                    <span>{config.mode === 'webhook' ? 'Folder Connected' : 'Google Account Active'}</span>
                  </span>
                ) : (
                  <span className="badge badge-neutral text-[10px] py-0 px-2">Not Connected</span>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                Automated off-site cloud backups and disaster recovery
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="btn btn-ghost btn-sm text-lg text-muted-foreground hover:text-foreground cursor-pointer"
          >
            ✕
          </button>
        </div>

        {/* Connected Banner (if configured) */}
        {config?.configured && (
          <div className="mx-6 mt-4 p-4 rounded-xl bg-emerald-950/20 border border-emerald-500/30 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
            <div className="space-y-0.5">
              <div className="flex items-center gap-2 font-bold text-emerald-300">
                <span>✅</span>
                <span>{config.displayName || config.userName || config.folderName || 'Google Drive Connected'}</span>
              </div>
              {config.userEmail && (
                <p className="text-[11px] text-zinc-300 font-mono">{config.userEmail}</p>
              )}
              {config.folderName && (
                <p className="text-[11px] text-muted-foreground">
                  Target Folder: <span className="font-semibold text-foreground">{config.folderName}</span>
                </p>
              )}
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={handleTestConnection}
                disabled={testing}
                className="btn btn-secondary btn-sm text-[11px] py-1.5 px-3 flex items-center gap-1 cursor-pointer"
              >
                {testing ? <span className="animate-spin text-xs">⟳</span> : <span>⚡</span>}
                <span>{testing ? 'Testing...' : 'Test Connection'}</span>
              </button>
              <button
                type="button"
                onClick={handleDisconnect}
                disabled={disconnecting}
                className="btn btn-ghost btn-sm text-[11px] text-destructive hover:bg-destructive/10 py-1.5 px-2.5 cursor-pointer"
              >
                {disconnecting ? '...' : 'Disconnect'}
              </button>
            </div>

            {testResult && testResult.ok && (
              <div className="w-full pt-2 border-t border-emerald-500/30 flex items-center justify-between text-[11px] text-emerald-300 font-mono">
                <span>Verified: {testResult.folderName || 'Google Drive Active'}</span>
                {testResult.storageQuota?.limitBytes && testResult.storageQuota.usageBytes !== undefined ? (
                  <span>
                    Storage: {(testResult.storageQuota.usageBytes / (1024 * 1024 * 1024)).toFixed(1)} GB /{' '}
                    {(testResult.storageQuota.limitBytes / (1024 * 1024 * 1024)).toFixed(1)} GB
                  </span>
                ) : null}
              </div>
            )}
          </div>
        )}

        {/* Navigation Tabs */}
        <div className="flex border-b border-border/80 px-6 gap-2 mt-2 bg-card-subtle/30 overflow-x-auto">
          <button
            onClick={() => setActiveTab('login')}
            className={`py-2.5 px-3.5 text-xs font-semibold border-b-2 -mb-px transition-colors cursor-pointer flex items-center gap-1.5 shrink-0 ${
              activeTab === 'login'
                ? 'border-primary text-primary bg-primary/5'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            <span>🌟</span>
            <span>Sign in with Google</span>
          </button>
          <button
            onClick={() => setActiveTab('shared-folder')}
            className={`py-2.5 px-3.5 text-xs font-semibold border-b-2 -mb-px transition-colors cursor-pointer flex items-center gap-1.5 shrink-0 ${
              activeTab === 'shared-folder'
                ? 'border-primary text-primary bg-primary/5'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            <span>📁</span>
            <span>Shared Folder (Zero Cloud Setup)</span>
          </button>
          <button
            onClick={() => setActiveTab('manual')}
            className={`py-2.5 px-3.5 text-xs font-semibold border-b-2 -mb-px transition-colors cursor-pointer flex items-center gap-1.5 shrink-0 ${
              activeTab === 'manual'
                ? 'border-primary text-primary bg-primary/5'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            <span>⚙️</span>
            <span>Manual OAuth</span>
          </button>
        </div>

        {/* Content Body */}
        <div className="p-6 overflow-y-auto space-y-5">
          {/* ─────────────────── TAB 1: SIGN IN WITH GOOGLE ─────────────────── */}
          {activeTab === 'login' && (
            <div className="space-y-5">
              {/* Raw IP Warning */}
              {typeof window !== 'undefined' &&
                window.location.hostname !== 'localhost' &&
                window.location.hostname !== '127.0.0.1' &&
                /^(?:\d{1,3}\.){3}\d{1,3}$/.test(window.location.hostname) && (
                  <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-200 space-y-1.5">
                    <div className="flex items-center gap-2 font-bold text-amber-300">
                      <span>⚠️</span>
                      <span>Accessing via Raw IP Address ({window.location.hostname})</span>
                    </div>
                    <p className="text-[11px] text-amber-200/90 leading-relaxed">
                      Google OAuth 2.0 policy disallows numeric IP addresses as Authorized Redirect URIs. For server deployments without a domain name, click the{' '}
                      <button
                        type="button"
                        onClick={() => setActiveTab('shared-folder')}
                        className="underline font-bold text-amber-300 hover:text-white cursor-pointer"
                      >
                        Shared Folder (Zero Cloud Setup)
                      </button>{' '}
                      tab above — it connects in 60 seconds with no domain or Google Cloud credentials needed.
                    </p>
                  </div>
                )}

              <div className="text-center py-4 px-3 rounded-2xl bg-card-subtle border border-border/80 space-y-4">
                <div className="max-w-md mx-auto space-y-1.5">
                  <h4 className="text-sm font-bold text-foreground">Connect with 1-Click Google Login</h4>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Authenticate securely directly with your personal or Google Workspace account. Backups are stored in your Google Drive cloud with zero third-party intermediaries.
                  </p>
                  {config?.hasEnvCredentials && (
                    <div className="pt-1">
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-[11px] font-medium">
                        <span>⚡</span>
                        <span>Google OAuth App Credentials active from container</span>
                      </span>
                    </div>
                  )}
                </div>

                {/* Big Google Login Button */}
                <div className="flex justify-center pt-1">
                  <button
                    type="button"
                    onClick={handleSignInWithGoogle}
                    disabled={loading}
                    className="btn bg-white hover:bg-zinc-100 text-zinc-900 font-bold text-xs py-3 px-6 rounded-xl flex items-center gap-3 shadow-lg hover:shadow-xl transition-all cursor-pointer border border-zinc-200"
                  >
                    <svg className="w-4 h-4" viewBox="0 0 24 24">
                      <path
                        fill="#4285F4"
                        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                      />
                      <path
                        fill="#34A853"
                        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                      />
                      <path
                        fill="#FBBC05"
                        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                      />
                      <path
                        fill="#EA4335"
                        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
                      />
                    </svg>
                    <span>{loading ? 'Opening Google...' : 'Sign in with Google'}</span>
                  </button>
                </div>

                {/* Important Checklist Callout */}
                <div className="text-left bg-card p-3 rounded-xl border border-border/60 text-[11px] text-muted-foreground space-y-1.5 max-w-lg mx-auto">
                  <div className="font-semibold text-foreground flex items-center gap-1.5">
                    <span>📋</span>
                    <span>Common Setup Requirements:</span>
                  </div>
                  <ul className="list-disc list-inside space-y-1 text-[11px] text-zinc-300">
                    <li>
                      <strong>Google Drive API:</strong> Must be enabled in{' '}
                      <a
                        href="https://console.cloud.google.com/apis/library/drive.googleapis.com"
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary hover:underline"
                      >
                        API Library ↗
                      </a>
                    </li>
                    <li>
                      <strong>Test Users:</strong> If your OAuth consent screen is in <em>"Testing"</em> status, add your Google account to{' '}
                      <a
                        href="https://console.cloud.google.com/apis/credentials/consent"
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary hover:underline"
                      >
                        OAuth consent screen &rarr; Test users ↗
                      </a>
                    </li>
                  </ul>
                </div>
              </div>

              {/* Paste Authorization Code fallback */}
              <div className="pt-2">
                <button
                  type="button"
                  onClick={() => setShowCodeInput(!showCodeInput)}
                  className="text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-1.5 cursor-pointer"
                >
                  <span>{showCodeInput ? '▼' : '▶'}</span>
                  <span>Having trouble with the popup? Enter Google Authorization Code directly</span>
                </button>

                {showCodeInput && (
                  <form onSubmit={handleExchangeCode} className="mt-2.5 p-3 rounded-xl bg-card-subtle border border-border space-y-2 animate-fade-in">
                    <p className="text-[11px] text-muted-foreground">
                      If Google displays an authorization code or redirect query, paste it here:
                    </p>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={authCode}
                        onChange={(e) => setAuthCode(e.target.value)}
                        placeholder="Paste Google Authorization Code (4/0A...)"
                        className="input flex-1 text-xs font-mono"
                        required
                      />
                      <button
                        type="submit"
                        disabled={loading || !authCode.trim()}
                        className="btn btn-primary text-xs py-1.5 px-3 font-semibold cursor-pointer shrink-0"
                      >
                        Connect Code
                      </button>
                    </div>
                  </form>
                )}
              </div>

              {/* Custom OAuth Client ID & Secret Accordion */}
              <div className="border-t border-border/60 pt-3">
                <button
                  type="button"
                  onClick={() => setShowCustomCredentials(!showCustomCredentials)}
                  className="text-[11px] text-muted-foreground hover:text-foreground flex items-center justify-between w-full cursor-pointer py-1"
                >
                  <span className="flex items-center gap-1.5 font-semibold">
                    <span>⚙️</span>
                    <span>OAuth App Credentials (Client ID & Secret)</span>
                    {config?.hasEnvCredentials ? (
                      <span className="badge badge-success text-[10px] py-0 px-1.5 ml-1.5 font-normal">
                        ✓ Container Env Configured
                      </span>
                    ) : config?.hasClientCredentials ? (
                      <span className="badge badge-success text-[10px] py-0 px-1.5 ml-1.5 font-normal">
                        ✓ App Credentials Configured
                      </span>
                    ) : null}
                  </span>
                  <span className="text-[10px]">{showCustomCredentials ? 'Hide ▲' : 'Customize ▼'}</span>
                </button>

                {showCustomCredentials && (
                  <div className="mt-2.5 p-4 rounded-xl bg-card-subtle border border-border/80 space-y-3 animate-fade-in text-xs">
                    <p className="text-muted-foreground leading-relaxed">
                      VaultRealm connects to Google Drive using your Google Cloud OAuth 2.0 Web Application credentials. Enter your Client ID and Client Secret from Google Cloud Console:
                    </p>
                    <div className="space-y-2">
                      <div>
                        <label className="block text-[11px] font-semibold text-foreground mb-1">
                          Google Client ID <span className="text-destructive">*</span>
                        </label>
                        <input
                          type="text"
                          value={oauthClientId}
                          onChange={(e) => setOauthClientId(e.target.value)}
                          placeholder="772379419361-xxxx.apps.googleusercontent.com"
                          className="input w-full text-xs font-mono"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-semibold text-foreground mb-1">
                          Google Client Secret{' '}
                          {config?.hasClientCredentials ? (
                            <span className="text-muted-foreground font-normal">(Leave blank to keep existing encrypted secret)</span>
                          ) : (
                            <span className="text-destructive">*</span>
                          )}
                        </label>
                        <input
                          type="password"
                          value={oauthClientSecret}
                          onChange={(e) => setOauthClientSecret(e.target.value)}
                          placeholder={config?.hasClientCredentials ? '••••••••••••••••' : 'GOCSPX-xxxx...'}
                          className="input w-full text-xs font-mono"
                        />
                      </div>
                    </div>

                    <div className="flex items-center justify-between pt-1">
                      <button
                        type="button"
                        onClick={handleSaveAppCredentials}
                        disabled={savingAppCreds || !oauthClientId.trim()}
                        className="btn btn-secondary btn-sm text-xs py-1.5 px-3 flex items-center gap-1.5 font-semibold cursor-pointer"
                      >
                        {savingAppCreds ? <span className="animate-spin text-xs">⟳</span> : <span>💾</span>}
                        <span>{savingAppCreds ? 'Saving...' : 'Save App Credentials'}</span>
                      </button>

                      <a
                        href="https://console.cloud.google.com/apis/credentials"
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary hover:underline font-semibold text-[11px]"
                      >
                        Google Cloud Console ↗
                      </a>
                    </div>

                    <div className="p-2.5 rounded-lg bg-card border border-border/60 text-[11px] text-muted-foreground space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-foreground">Authorized Redirect URI:</span>
                        <button
                          type="button"
                          onClick={handleCopyRedirectUri}
                          className="text-[10px] text-primary hover:underline cursor-pointer font-semibold"
                        >
                          {copiedRedirectUri ? '✓ Copied' : 'Copy URI'}
                        </button>
                      </div>
                      <code className="block p-1.5 rounded bg-muted/30 font-mono text-[10px] break-all select-all text-foreground">
                        {window.location.origin}/api/system/google-drive/callback
                      </code>
                      <p className="text-[10px] text-muted-foreground">
                        Must match the Authorized Redirect URI in your Google Cloud Console Web Client.
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ─────────────────── TAB 2: SHARED FOLDER (GOOGLE APPS SCRIPT) ─────────────────── */}
          {activeTab === 'shared-folder' && (
            <div className="space-y-4">
              <div className="p-4 rounded-xl bg-blue-500/10 border border-blue-500/30 text-xs space-y-2">
                <div className="flex items-center gap-2 font-bold text-blue-300">
                  <span>💡</span>
                  <span>Easiest Method for Non-Technical Users</span>
                </div>
                <p className="text-zinc-300 leading-relaxed">
                  No Google Cloud account or API keys required! Any personal or school Google Drive account can receive backups in 60 seconds using a simple Google Apps Script Web App.
                </p>
              </div>

              {/* Step-by-step instructions */}
              <div className="space-y-3 text-xs">
                <div className="flex items-start gap-3 p-3 rounded-lg bg-card-subtle border border-border">
                  <span className="w-5 h-5 rounded-full bg-primary/20 text-primary font-bold flex items-center justify-center shrink-0 text-[11px]">
                    1
                  </span>
                  <div className="flex-1">
                    <p className="font-semibold text-foreground">Create or Open your Folder in Google Drive</p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      Open <a href="https://drive.google.com" target="_blank" rel="noreferrer" className="text-primary hover:underline">drive.google.com</a>, create a folder named <strong>VaultRealm Backups</strong>.
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-3 p-3 rounded-lg bg-card-subtle border border-border">
                  <span className="w-5 h-5 rounded-full bg-primary/20 text-primary font-bold flex items-center justify-center shrink-0 text-[11px]">
                    2
                  </span>
                  <div className="flex-1 space-y-2">
                    <div className="flex items-center justify-between">
                      <p className="font-semibold text-foreground">Copy the Pre-Built Script</p>
                      <button
                        type="button"
                        onClick={handleCopyScript}
                        className="btn btn-secondary btn-sm text-[11px] py-1 px-2.5 flex items-center gap-1 cursor-pointer font-bold text-primary"
                      >
                        <span>{copiedScript ? '✅' : '📋'}</span>
                        <span>{copiedScript ? 'Copied!' : 'Copy Script'}</span>
                      </button>
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      Inside your folder or at <a href="https://script.google.com" target="_blank" rel="noreferrer" className="text-primary hover:underline">script.google.com</a>, create a new project and paste this script.
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-3 p-3 rounded-lg bg-card-subtle border border-border">
                  <span className="w-5 h-5 rounded-full bg-primary/20 text-primary font-bold flex items-center justify-center shrink-0 text-[11px]">
                    3
                  </span>
                  <div className="flex-1">
                    <p className="font-semibold text-foreground">Deploy as Web App</p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      Click <strong>Deploy &gt; New deployment &gt; Select type: Web app</strong>.<br />
                      Set <em>Execute as: Me</em> and <em>Who has access: Anyone</em>.
                    </p>
                  </div>
                </div>
              </div>

              {/* Form */}
              <form onSubmit={handleSaveWebhook} className="space-y-3 pt-2">
                <div>
                  <label className="block text-xs font-semibold text-foreground mb-1">
                    Web App URL <span className="text-destructive">*</span>
                  </label>
                  <input
                    type="url"
                    value={webhookUrl}
                    onChange={(e) => setWebhookUrl(e.target.value)}
                    placeholder="https://script.google.com/macros/s/AKfycb.../exec"
                    required
                    className="input w-full text-xs font-mono"
                  />
                  <p className="text-[11px] text-muted-foreground mt-1">
                    Paste the deployment URL given by Google Apps Script.
                  </p>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-foreground mb-1">
                    Folder ID <span className="text-muted-foreground font-normal">(Optional)</span>
                  </label>
                  <input
                    type="text"
                    value={webhookFolderId}
                    onChange={(e) => setWebhookFolderId(e.target.value)}
                    placeholder="Found in your drive folder link: drive.google.com/drive/folders/FOLDER_ID"
                    className="input w-full text-xs font-mono"
                  />
                </div>

                <div className="flex justify-end gap-2 pt-3 border-t border-border/60">
                  <button
                    type="button"
                    onClick={onClose}
                    className="btn btn-secondary text-xs py-2 px-4"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={loading}
                    className="btn btn-primary text-xs py-2 px-5 font-bold cursor-pointer"
                  >
                    {loading ? 'Connecting...' : 'Connect Shared Folder'}
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* ─────────────────── TAB 3: MANUAL OAUTH CREDENTIALS ─────────────────── */}
          {activeTab === 'manual' && (
            <form onSubmit={handleSaveManualOAuth} className="space-y-4">
              <div className="p-3 rounded-lg bg-card-subtle border border-border text-xs text-muted-foreground">
                For developers and sysadmins who already have OAuth 2.0 refresh tokens generated via Google Cloud Console or OAuth Playground.
              </div>

              <div>
                <label className="block text-xs font-semibold text-foreground mb-1">
                  Client ID <span className="text-destructive">*</span>
                </label>
                <input
                  type="text"
                  value={manualClientId}
                  onChange={(e) => setManualClientId(e.target.value)}
                  placeholder="xxxx.apps.googleusercontent.com"
                  required
                  className="input w-full text-xs font-mono"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-foreground mb-1">
                    Client Secret {config?.configured ? '(Leave blank to retain)' : <span className="text-destructive">*</span>}
                  </label>
                  <input
                    type="password"
                    value={manualClientSecret}
                    onChange={(e) => setManualClientSecret(e.target.value)}
                    placeholder={config?.configured ? '••••••••••••••••' : 'GOCSPX-xxxx...'}
                    required={!config?.configured}
                    className="input w-full text-xs font-mono"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-foreground mb-1">
                    Refresh Token {config?.configured ? '(Leave blank to retain)' : <span className="text-destructive">*</span>}
                  </label>
                  <input
                    type="password"
                    value={manualRefreshToken}
                    onChange={(e) => setManualRefreshToken(e.target.value)}
                    placeholder={config?.configured ? '••••••••••••••••' : '1//xxxx...'}
                    required={!config?.configured}
                    className="input w-full text-xs font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-foreground mb-1">
                  Custom Folder ID <span className="text-muted-foreground font-normal">(Optional)</span>
                </label>
                <input
                  type="text"
                  value={manualFolderId}
                  onChange={(e) => setManualFolderId(e.target.value)}
                  placeholder="Drive Folder ID (root if blank)"
                  className="input w-full text-xs font-mono"
                />
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-border/60">
                <button
                  type="button"
                  onClick={onClose}
                  className="btn btn-secondary text-xs py-2 px-4"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className="btn btn-primary text-xs py-2 px-5 font-bold cursor-pointer"
                >
                  {loading ? 'Saving...' : 'Save Credentials'}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
