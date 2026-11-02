import { useState, useEffect, useRef } from 'react';
import {
  api,
  type LlmEndpoint,
  type LlmEndpointPreset,
  type TestConnectionResult,
  type CompanionUsage,
  type BotDetail,
  type ApiError,
  type CompanionTrace,
} from '../api/client';
import { useToast } from './Toast';
import { useConfirm } from './ConfirmModal';

interface CompanionTabProps {
  serverId: string;
}

const PERSONA_TEMPLATES = [
  { id: 'helpful', label: 'Helpful Friend', description: 'Polite, eager to help, friendly tone' },
  { id: 'builder', label: 'Master Builder', description: 'Focused on gathering materials, crafting, and building' },
  { id: 'survival', label: 'Survival Pro', description: 'Resourceful, protective, watches player health and safety' },
  { id: 'funny', label: 'Playful & Witty', description: 'Cracks jokes, humorous reactions, energetic' },
];

export function CompanionTab({ serverId }: CompanionTabProps) {
  const [endpoints, setEndpoints] = useState<LlmEndpoint[]>([]);
  const [presets, setPresets] = useState<LlmEndpointPreset[]>([]);
  const [usage, setUsage] = useState<CompanionUsage | null>(null);
  const [bot, setBot] = useState<BotDetail | null>(null);
  const [loading, setLoading] = useState(true);

  // Bot configuration state
  const [botName, setBotName] = useState('Buddy');
  const [botPersona, setBotPersona] = useState('helpful friend');
  const [botEndpointId, setBotEndpointId] = useState('');
  const [botModel, setBotModel] = useState('');
  const [botMode, setBotMode] = useState<'off' | 'manual' | 'auto-solo' | 'always'>('manual');
  const [botAuthMode, setBotAuthMode] = useState<'offline' | 'microsoft' | 'proxy'>('offline');
  const [botBudget, setBotBudget] = useState<number | ''>(200000);
  const [botRpm, setBotRpm] = useState(10);
  const [savingBot, setSavingBot] = useState(false);
  const [spawningBot, setSpawningBot] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [sayInput, setSayInput] = useState('');

  // Phase 6d sub-tabs & traces & device-code state
  const [activeSubTab, setActiveSubTab] = useState<'control' | 'usage' | 'traces' | 'endpoints' | 'logs'>('control');
  const [botLogs, setBotLogs] = useState<string[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [autoScrollLogs, setAutoScrollLogs] = useState(true);
  const botLogsContainerRef = useRef<HTMLDivElement>(null);

  const fetchBotLogs = async () => {
    try {
      setLoadingLogs(true);
      const res = await api.getBotLogs(serverId, 300);
      setBotLogs(res.logs || []);
    } catch {
      // ignore
    } finally {
      setLoadingLogs(false);
    }
  };

  useEffect(() => {
    if (activeSubTab !== 'logs') return;
    void fetchBotLogs();
    const interval = setInterval(fetchBotLogs, 2000);
    return () => clearInterval(interval);
  }, [activeSubTab, serverId]);

  useEffect(() => {
    if (autoScrollLogs && botLogsContainerRef.current) {
      botLogsContainerRef.current.scrollTop = botLogsContainerRef.current.scrollHeight;
    }
  }, [botLogs, autoScrollLogs]);
  const [traces, setTraces] = useState<CompanionTrace[]>([]);
  const [loadingTraces, setLoadingTraces] = useState(false);
  const [expandedTraceId, setExpandedTraceId] = useState<string | null>(null);
  const [deviceCodeModal, setDeviceCodeModal] = useState<{
    open: boolean;
    userCode?: string;
    verificationUri?: string;
    message?: string;
  } | null>(null);
  const [loadingDeviceCode, setLoadingDeviceCode] = useState(false);

  // New/Edit endpoint form
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [defaultModel, setDefaultModel] = useState('');
  const [timeoutS, setTimeoutS] = useState(30);
  const [selectedPreset, setSelectedPreset] = useState<string>('custom');
  const [submitting, setSubmitting] = useState(false);

  // Test connection state
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; result: TestConnectionResult } | null>(null);

  const { addToast } = useToast();
  const { confirm, ConfirmDialog } = useConfirm();

  const fetchData = async () => {
    try {
      setLoading(true);
      const [presetsRes, endpointsRes, usageRes, botRes] = await Promise.all([
        api.listEndpointPresets().catch(() => ({ presets: [] })),
        api.listEndpoints().catch(() => ({ endpoints: [] })),
        api.getBotUsage(serverId).catch(() => null),
        api.getBot(serverId).catch(() => ({ configured: false, bot: null })),
      ]);
      setPresets(presetsRes.presets);
      setEndpoints(endpointsRes.endpoints);
      setUsage(usageRes);

      if (botRes.bot) {
        setBot(botRes.bot);
        setBotName(botRes.bot.name);
        setBotPersona(botRes.bot.persona);
        setBotEndpointId(botRes.bot.endpointId);
        setBotModel(botRes.bot.model ?? '');
        setBotMode(botRes.bot.mode);
        setBotAuthMode(botRes.bot.authMode);
        setBotBudget(botRes.bot.dailyTokenBudget);
        setBotRpm(botRes.bot.rpmLimit);
      } else if (endpointsRes.endpoints.length > 0 && !botEndpointId) {
        setBotEndpointId(endpointsRes.endpoints[0].id);
      }
    } catch (err) {
      console.error(err);
      addToast({ type: 'error', title: 'Failed to load companion settings' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [serverId]);

  const handlePresetSelect = (presetId: string) => {
    setSelectedPreset(presetId);
    const preset = presets.find((p) => p.id === presetId);
    if (preset && preset.id !== 'custom') {
      setName(preset.name);
      setBaseUrl(preset.baseUrl);
      setDefaultModel(preset.defaultModel);
    }
  };

  const resetForm = () => {
    setEditingId(null);
    setName('');
    setBaseUrl('');
    setApiKey('');
    setDefaultModel('');
    setTimeoutS(30);
    setSelectedPreset('custom');
  };

  const handleEdit = (ep: LlmEndpoint) => {
    setEditingId(ep.id);
    setName(ep.name);
    setBaseUrl(ep.baseUrl);
    setApiKey('');
    setDefaultModel(ep.defaultModel ?? '');
    setTimeoutS(ep.timeoutS ?? 30);
    setSelectedPreset('custom');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !baseUrl.trim()) {
      addToast({ type: 'error', title: 'Validation error', message: 'Name and Base URL are required' });
      return;
    }

    try {
      setSubmitting(true);
      if (editingId) {
        await api.updateEndpoint(editingId, {
          name: name.trim(),
          baseUrl: baseUrl.trim(),
          apiKey: apiKey.trim() ? apiKey.trim() : undefined,
          defaultModel: defaultModel.trim() || undefined,
          timeoutS,
        });
        addToast({ type: 'success', title: 'Endpoint updated successfully' });
      } else {
        const created = await api.createEndpoint({
          name: name.trim(),
          baseUrl: baseUrl.trim(),
          apiKey: apiKey.trim() || undefined,
          defaultModel: defaultModel.trim() || undefined,
          timeoutS,
        });
        if (!botEndpointId) setBotEndpointId(created.id);
        addToast({ type: 'success', title: 'Endpoint connected successfully' });
      }
      resetForm();
      fetchData();
    } catch (err: unknown) {
      const error = err as ApiError;
      addToast({ type: 'error', title: 'Save failed', message: error.message || 'Failed to save endpoint' });
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string, epName: string) => {
    const ok = await confirm({
      title: 'Remove Endpoint',
      message: `Are you sure you want to remove "${epName}"? Any bots using this endpoint will need to be reconfigured.`,
      confirmLabel: 'Remove',
      variant: 'danger',
    });
    if (!ok) return;

    try {
      await api.deleteEndpoint(id);
      addToast({ type: 'success', title: 'Endpoint removed' });
      if (editingId === id) resetForm();
      fetchData();
    } catch (err: unknown) {
      const error = err as ApiError;
      addToast({ type: 'error', title: 'Delete failed', message: error.message || 'Failed to delete endpoint' });
    }
  };

  const handleTestConnection = async (id: string) => {
    try {
      setTestingId(id);
      setTestResult(null);
      const result = await api.testEndpoint(id);
      setTestResult({ id, result });
      const hasFailure = result.steps.some((s) => s.status === 'fail');
      if (hasFailure) {
        addToast({ type: 'error', title: 'Test connection failed', message: 'See details below.' });
      } else {
        addToast({ type: 'success', title: 'Endpoint connection verified!' });
      }
      api.listEndpoints().then((res) => setEndpoints(res.endpoints)).catch(() => {});
    } catch (err: unknown) {
      const error = err as ApiError;
      addToast({ type: 'error', title: 'Connection test failed', message: error.message });
    } finally {
      setTestingId(null);
    }
  };

  const handleSaveBot = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!botEndpointId) {
      addToast({ type: 'error', title: 'Endpoint required', message: 'Please connect and select an LLM endpoint first.' });
      return;
    }

    try {
      setSavingBot(true);
      await api.updateBot(serverId, {
        endpointId: botEndpointId,
        name: botName.trim() || 'Buddy',
        persona: botPersona.trim() || 'helpful friend',
        model: botModel.trim() || null,
        mode: botMode,
        authMode: botAuthMode,
        dailyTokenBudget: typeof botBudget === 'number' ? Math.max(1000, botBudget) : (parseInt(String(botBudget), 10) || 200000),
        rpmLimit: botRpm,
      });
      addToast({ type: 'success', title: 'Companion configured successfully!' });
      fetchData();
    } catch (err: unknown) {
      const error = err as ApiError;
      addToast({ type: 'error', title: 'Failed to configure companion', message: error.message });
    } finally {
      setSavingBot(false);
    }
  };

  const handleSpawnToggle = async () => {
    if (!bot || bot.status === 'offline' || bot.status === 'error') {
      try {
        setSpawningBot(true);
        addToast({
          type: 'info',
          title: 'Preparing Companion...',
          message: 'Pulling bot container image and launching runner...',
        });
        await api.spawnBot(serverId);
        addToast({
          type: 'success',
          title: 'Companion Spawned!',
          message: 'Bot container started and joining game server.',
        });
        fetchData();
      } catch (err: unknown) {
        const error = err as ApiError;
        addToast({ type: 'error', title: 'Failed to spawn bot', message: error.message });
      } finally {
        setSpawningBot(false);
      }
    } else {
      try {
        setSpawningBot(true);
        await api.despawnBot(serverId);
        addToast({ type: 'success', title: 'Companion despawned' });
        fetchData();
      } catch (err: unknown) {
        const error = err as ApiError;
        addToast({ type: 'error', title: 'Failed to despawn bot', message: error.message });
      } finally {
        setSpawningBot(false);
      }
    }
  };

  const handleQuickCommand = async (action: string) => {
    try {
      setActionLoading(action);
      await api.sendBotAction(serverId, action);
      addToast({ type: 'success', title: `Command executed: !${action}` });
    } catch (err: unknown) {
      const error = err as ApiError;
      addToast({ type: 'error', title: 'Command failed', message: error.message });
    } finally {
      setActionLoading(null);
    }
  };

  const handleSayMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sayInput.trim()) return;

    try {
      setActionLoading('say');
      await api.sendBotAction(serverId, 'say', sayInput.trim());
      addToast({ type: 'success', title: 'Message sent as bot' });
      setSayInput('');
    } catch (err: unknown) {
      const error = err as ApiError;
      addToast({ type: 'error', title: 'Send failed', message: error.message });
    } finally {
      setActionLoading(null);
    }
  };

  const loadTraces = async () => {
    try {
      setLoadingTraces(true);
      const res = await api.getBotTraces(serverId);
      setTraces(res.traces);
    } catch {
      // ignore
    } finally {
      setLoadingTraces(false);
    }
  };

  const handleDeviceCodeLogin = async () => {
    try {
      setLoadingDeviceCode(true);
      const res = await api.getBotDeviceCode(serverId);
      setDeviceCodeModal({
        open: true,
        userCode: res.userCode,
        verificationUri: res.verificationUri,
        message: res.message,
      });
      addToast({ type: 'info', title: 'Device Code Ready', message: `Code: ${res.userCode}` });
    } catch (err: unknown) {
      const error = err as ApiError;
      addToast({ type: 'error', title: 'Device Code Failed', message: error.message });
    } finally {
      setLoadingDeviceCode(false);
    }
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '60px', color: '#94a3b8' }}>
        <div style={{ textAlign: 'center' }}>
          <div className="spinner" style={{ margin: '0 auto 16px' }} />
          Loading companion and AI settings...
        </div>
      </div>
    );
  }

  const isBotActive = bot && (bot.status === 'joining' || bot.status === 'online');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      {ConfirmDialog}

      {/* ── Top Header / Status Banner ── */}
      <div
        style={{
          background: 'linear-gradient(135deg, rgba(30, 41, 59, 0.7), rgba(15, 23, 42, 0.8))',
          borderRadius: '16px',
          border: '1px solid rgba(255, 255, 255, 0.08)',
          padding: '24px',
          backdropFilter: 'blur(12px)',
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '20px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div
            style={{
              width: '52px',
              height: '52px',
              borderRadius: '14px',
              background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '26px',
              boxShadow: '0 8px 24px rgba(99, 102, 241, 0.35)',
            }}
          >
            🤖
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <h2 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 600, color: '#f8fafc' }}>
                AI Companion Hub
              </h2>
              <span
                style={{
                  fontSize: '0.75rem',
                  padding: '3px 9px',
                  borderRadius: '20px',
                  fontWeight: 600,
                  background: isBotActive
                    ? 'rgba(34, 197, 94, 0.15)'
                    : bot
                      ? 'rgba(148, 163, 184, 0.15)'
                      : 'rgba(239, 68, 68, 0.15)',
                  color: isBotActive ? '#4ade80' : bot ? '#94a3b8' : '#f87171',
                  border: `1px solid ${
                    isBotActive
                      ? 'rgba(34, 197, 94, 0.3)'
                      : bot
                        ? 'rgba(148, 163, 184, 0.2)'
                        : 'rgba(239, 68, 68, 0.3)'
                  }`,
                }}
              >
                {bot ? `Bot: ${bot.status}` : 'Not Configured'}
              </span>
            </div>
            <p style={{ margin: '4px 0 0', fontSize: '0.875rem', color: '#94a3b8' }}>
              Connect your LLM provider and spawn an intelligent in-game buddy with function calling and chat.
            </p>
          </div>
        </div>

        {usage && (
          <div style={{ display: 'flex', gap: '20px', alignItems: 'center' }}>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: '0.75rem', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Today's Tokens
              </div>
              <div style={{ fontSize: '1.2rem', fontWeight: 700, color: '#f8fafc' }}>
                {usage.totalTokens.toLocaleString()}
                <span style={{ fontSize: '0.8rem', fontWeight: 400, color: '#64748b', marginLeft: '4px' }}>
                  / {(usage.dailyBudget ?? 200_000).toLocaleString()}
                </span>
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: '0.75rem', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Requests
              </div>
              <div style={{ fontSize: '1.2rem', fontWeight: 700, color: '#a855f7' }}>
                {usage.requests}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Sub-Navigation Tabs ── */}
      <div className="no-scrollbar touch-scroll" style={{ display: 'flex', gap: '8px', borderBottom: '1px solid rgba(255, 255, 255, 0.08)', paddingBottom: '12px', overflowX: 'auto', whiteSpace: 'nowrap' }}>
        {bot?.errorMessage && (
          <div style={{ padding: '10px 14px', borderRadius: '8px', background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: '12px', flexWrap: 'wrap' }}>
            <div style={{ fontSize: '0.8125rem', color: '#fca5a5' }}>
              <strong>Companion Status:</strong> {bot.errorMessage}
            </div>
            <button
              type="button"
              onClick={() => {
                setActiveSubTab('logs');
                void fetchBotLogs();
              }}
              style={{ padding: '4px 10px', fontSize: '0.75rem', fontWeight: 600, background: 'rgba(239, 68, 68, 0.2)', border: '1px solid rgba(239, 68, 68, 0.4)', borderRadius: '6px', color: '#fee2e2', cursor: 'pointer', whiteSpace: 'nowrap' }}
            >
              View Bot Logs 📜
            </button>
          </div>
        )}
        {[
          { id: 'control', label: '🎮 Controls & Setup' },
          { id: 'usage', label: '📊 Usage & Budget' },
          { id: 'traces', label: '🔍 Activity & Traces' },
          { id: 'logs', label: `📜 Bot Live Logs${bot?.status === 'error' ? ' ⚠️' : ''}` },
          { id: 'endpoints', label: `⚡ AI Endpoints (${endpoints.length})` },
        ].map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => {
              setActiveSubTab(tab.id as 'control' | 'usage' | 'traces' | 'endpoints' | 'logs');
              if (tab.id === 'traces') loadTraces();
              if (tab.id === 'logs') void fetchBotLogs();
            }}
            style={{
              background: activeSubTab === tab.id ? 'rgba(99, 102, 241, 0.2)' : 'transparent',
              color: activeSubTab === tab.id ? '#818cf8' : '#94a3b8',
              border: activeSubTab === tab.id ? '1px solid rgba(99, 102, 241, 0.4)' : '1px solid transparent',
              borderRadius: '8px',
              padding: '8px 16px',
              fontWeight: 600,
              fontSize: '0.875rem',
              cursor: 'pointer',
              transition: 'all 0.15s ease',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeSubTab === 'control' && (
        <>

      {/* ── Section 1: Live Bot Control & In-Game Actions ── */}
      <div
        style={{
          background: 'rgba(30, 41, 59, 0.6)',
          borderRadius: '16px',
          border: '1px solid rgba(255, 255, 255, 0.08)',
          padding: '24px',
          display: 'flex',
          flexDirection: 'column',
          gap: '20px',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
          <div>
            <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600, color: '#f8fafc' }}>
              Companion Controls ({bot?.name || 'Buddy'})
            </h3>
            <p style={{ margin: '4px 0 0', fontSize: '0.85rem', color: '#94a3b8' }}>
              Spawn or despawn the containerized bot, send fast non-LLM commands, or chat as the companion.
            </p>
          </div>

          <button
            type="button"
            disabled={spawningBot || !bot}
            onClick={handleSpawnToggle}
            style={{
              background: isBotActive
                ? 'rgba(239, 68, 68, 0.2)'
                : 'linear-gradient(135deg, #10b981, #059669)',
              border: `1px solid ${isBotActive ? 'rgba(239, 68, 68, 0.4)' : 'rgba(16, 185, 129, 0.5)'}`,
              color: isBotActive ? '#fca5a5' : '#ffffff',
              padding: '10px 20px',
              borderRadius: '10px',
              fontWeight: 600,
              fontSize: '0.9rem',
              cursor: spawningBot || !bot ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              boxShadow: isBotActive ? 'none' : '0 4px 14px rgba(16, 185, 129, 0.3)',
              opacity: spawningBot || !bot ? 0.6 : 1,
            }}
          >
            {spawningBot ? '⏳ Pulling & Starting Bot...' : isBotActive ? '⏹ Despawn Bot' : '🚀 Spawn Bot into Server'}
          </button>
        </div>

        {/* Quick Action Commands Strip */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' }}>
          <span style={{ fontSize: '0.8rem', color: '#64748b', fontWeight: 500 }}>Quick Actions:</span>
          {[
            { id: 'follow', label: 'Follow Me', icon: '🏃' },
            { id: 'stop', label: 'Stop Actions', icon: '🛑' },
            { id: 'come', label: 'Come Here', icon: '📍' },
            { id: 'status', label: 'Check Status', icon: '📊' },
          ].map((cmd) => (
            <button
              key={cmd.id}
              type="button"
              disabled={actionLoading !== null || !isBotActive}
              onClick={() => handleQuickCommand(cmd.id)}
              style={{
                background: 'rgba(15, 23, 42, 0.6)',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                color: isBotActive ? '#e2e8f0' : '#64748b',
                padding: '6px 12px',
                borderRadius: '8px',
                fontSize: '0.8rem',
                cursor: isBotActive ? 'pointer' : 'not-allowed',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}
            >
              <span>{cmd.icon}</span>
              <span>{cmd.label}</span>
            </button>
          ))}
        </div>

        {/* Say as Bot input */}
        <form onSubmit={handleSayMessage} style={{ display: 'flex', gap: '10px' }}>
          <input
            type="text"
            value={sayInput}
            disabled={!isBotActive}
            onChange={(e) => setSayInput(e.target.value)}
            placeholder={isBotActive ? `Speak in game chat as ${bot?.name}...` : 'Spawn bot to enable chat...'}
            style={{
              flex: 1,
              padding: '9px 14px',
              borderRadius: '8px',
              background: 'rgba(15, 23, 42, 0.6)',
              border: '1px solid rgba(255, 255, 255, 0.1)',
              color: '#f8fafc',
              fontSize: '0.875rem',
            }}
          />
          <button
            type="submit"
            disabled={!isBotActive || !sayInput.trim() || actionLoading === 'say'}
            style={{
              background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
              border: 'none',
              color: '#ffffff',
              padding: '9px 18px',
              borderRadius: '8px',
              fontWeight: 600,
              fontSize: '0.85rem',
              cursor: isBotActive && sayInput.trim() ? 'pointer' : 'not-allowed',
              opacity: !isBotActive || !sayInput.trim() ? 0.5 : 1,
            }}
          >
            Say
          </button>
        </form>
      </div>

      {/* ── Section 2: Bot Configuration Form ── */}
      <div
        style={{
          background: 'rgba(30, 41, 59, 0.5)',
          borderRadius: '16px',
          border: '1px solid rgba(255, 255, 255, 0.08)',
          padding: '24px',
        }}
      >
        <h3 style={{ margin: '0 0 16px', fontSize: '1.05rem', fontWeight: 600, color: '#f8fafc' }}>
          Companion Bot Configuration
        </h3>

        <form onSubmit={handleSaveBot} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '16px' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.8rem', color: '#94a3b8', marginBottom: '6px' }}>
                Bot Name (in Minecraft) *
              </label>
              <input
                type="text"
                value={botName}
                onChange={(e) => setBotName(e.target.value)}
                placeholder="Buddy"
                required
                style={{
                  width: '100%',
                  padding: '9px 12px',
                  borderRadius: '8px',
                  background: 'rgba(15, 23, 42, 0.6)',
                  border: '1px solid rgba(255, 255, 255, 0.12)',
                  color: '#f8fafc',
                  fontSize: '0.875rem',
                }}
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.8rem', color: '#94a3b8', marginBottom: '6px' }}>
                Connected LLM Endpoint *
              </label>
              <select
                value={botEndpointId}
                onChange={(e) => setBotEndpointId(e.target.value)}
                required
                style={{
                  width: '100%',
                  padding: '9px 12px',
                  borderRadius: '8px',
                  background: 'rgba(15, 23, 42, 0.6)',
                  border: '1px solid rgba(255, 255, 255, 0.12)',
                  color: '#f8fafc',
                  fontSize: '0.875rem',
                }}
              >
                <option value="">-- Select an Endpoint --</option>
                {endpoints.map((ep) => (
                  <option key={ep.id} value={ep.id}>
                    {ep.name} ({ep.defaultModel || 'default model'})
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Persona selector */}
          <div>
            <label style={{ display: 'block', fontSize: '0.8rem', color: '#94a3b8', marginBottom: '8px' }}>
              Persona Presets
            </label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px' }}>
              {PERSONA_TEMPLATES.map((tmpl) => (
                <div
                  key={tmpl.id}
                  onClick={() => setBotPersona(tmpl.description)}
                  style={{
                    background: botPersona === tmpl.description ? 'rgba(99, 102, 241, 0.25)' : 'rgba(15, 23, 42, 0.5)',
                    border: `1px solid ${botPersona === tmpl.description ? '#818cf8' : 'rgba(255, 255, 255, 0.08)'}`,
                    borderRadius: '10px',
                    padding: '12px',
                    cursor: 'pointer',
                    transition: 'all 0.15s ease',
                  }}
                >
                  <div style={{ fontWeight: 600, fontSize: '0.85rem', color: '#f8fafc' }}>{tmpl.label}</div>
                  <div style={{ fontSize: '0.75rem', color: '#94a3b8', marginTop: '4px' }}>{tmpl.description}</div>
                </div>
              ))}
            </div>
          </div>

          <div>
            <label style={{ display: 'block', fontSize: '0.8rem', color: '#94a3b8', marginBottom: '6px' }}>
              Custom Persona Instructions
            </label>
            <textarea
              rows={2}
              value={botPersona}
              onChange={(e) => setBotPersona(e.target.value)}
              placeholder="Describe how Buddy speaks and behaves..."
              style={{
                width: '100%',
                padding: '9px 12px',
                borderRadius: '8px',
                background: 'rgba(15, 23, 42, 0.6)',
                border: '1px solid rgba(255, 255, 255, 0.12)',
                color: '#f8fafc',
                fontSize: '0.875rem',
                fontFamily: 'inherit',
              }}
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '14px' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.8rem', color: '#94a3b8', marginBottom: '6px' }}>
                Auth Mode
              </label>
              <select
                value={botAuthMode}
                onChange={(e) => setBotAuthMode(e.target.value as 'offline' | 'microsoft')}
                style={{
                  width: '100%',
                  padding: '9px 12px',
                  borderRadius: '8px',
                  background: 'rgba(15, 23, 42, 0.6)',
                  border: '1px solid rgba(255, 255, 255, 0.12)',
                  color: '#f8fafc',
                  fontSize: '0.875rem',
                }}
              >
                <option value="offline">Offline (Private Server)</option>
                <option value="microsoft">Microsoft Java Account</option>
              </select>
              {botAuthMode === 'microsoft' && (
                <button
                  type="button"
                  onClick={handleDeviceCodeLogin}
                  disabled={loadingDeviceCode}
                  style={{
                    marginTop: '6px',
                    width: '100%',
                    background: 'rgba(99, 102, 241, 0.15)',
                    border: '1px solid rgba(99, 102, 241, 0.3)',
                    color: '#a5b4fc',
                    padding: '6px 10px',
                    borderRadius: '6px',
                    fontSize: '0.75rem',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  {loadingDeviceCode ? 'Requesting Code...' : '🔑 Device-Code Login'}
                </button>
              )}
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.8rem', color: '#94a3b8', marginBottom: '6px' }}>
                Spawn Mode
              </label>
              <select
                value={botMode}
                onChange={(e) => setBotMode(e.target.value as 'off' | 'manual' | 'auto-solo' | 'always')}
                style={{
                  width: '100%',
                  padding: '9px 12px',
                  borderRadius: '8px',
                  background: 'rgba(15, 23, 42, 0.6)',
                  border: '1px solid rgba(255, 255, 255, 0.12)',
                  color: '#f8fafc',
                  fontSize: '0.875rem',
                }}
              >
                <option value="manual">Manual (Panel button)</option>
                <option value="always">Always (Keep active)</option>
                <option value="auto-solo">Auto-Solo (Spawn when alone)</option>
                <option value="off">Off (Disabled)</option>
              </select>
            </div>

            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                <label style={{ fontSize: '0.8rem', color: '#94a3b8' }}>
                  Daily Token Budget
                </label>
                <span style={{ fontSize: '0.75rem', color: '#818cf8', fontFamily: 'monospace' }}>
                  {typeof botBudget === 'number' ? botBudget.toLocaleString() : '0'} tokens
                </span>
              </div>
              <input
                type="number"
                min="1000"
                max="10000000"
                step="any"
                value={botBudget}
                onChange={(e) => {
                  const val = e.target.value;
                  if (val === '') {
                    setBotBudget('');
                  } else {
                    const parsed = parseInt(val, 10);
                    setBotBudget(isNaN(parsed) ? '' : parsed);
                  }
                }}
                onBlur={() => {
                  if (botBudget === '' || botBudget < 1000) {
                    setBotBudget(1000);
                  } else if (botBudget > 10000000) {
                    setBotBudget(10000000);
                  }
                }}
                style={{
                  width: '100%',
                  padding: '9px 12px',
                  borderRadius: '8px',
                  background: 'rgba(15, 23, 42, 0.6)',
                  border: '1px solid rgba(255, 255, 255, 0.12)',
                  color: '#f8fafc',
                  fontSize: '0.875rem',
                  fontFamily: 'monospace',
                }}
                placeholder="200000"
              />
              <div style={{ display: 'flex', gap: '6px', marginTop: '6px', flexWrap: 'wrap' }}>
                {[
                  { label: '50k', val: 50000 },
                  { label: '100k', val: 100000 },
                  { label: '200k (Default)', val: 200000 },
                  { label: '500k', val: 500000 },
                  { label: '1M', val: 1000000 },
                ].map((preset) => (
                  <button
                    key={preset.val}
                    type="button"
                    onClick={() => setBotBudget(preset.val)}
                    style={{
                      background: botBudget === preset.val ? 'rgba(99, 102, 241, 0.25)' : 'rgba(15, 23, 42, 0.4)',
                      border: botBudget === preset.val ? '1px solid #6366f1' : '1px solid rgba(255, 255, 255, 0.08)',
                      color: botBudget === preset.val ? '#818cf8' : '#94a3b8',
                      fontSize: '0.7rem',
                      padding: '2px 8px',
                      borderRadius: '4px',
                      cursor: 'pointer',
                      transition: 'all 0.2s',
                    }}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '8px' }}>
            <button
              type="submit"
              disabled={savingBot}
              style={{
                background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
                border: 'none',
                color: '#ffffff',
                padding: '10px 22px',
                borderRadius: '8px',
                fontWeight: 600,
                fontSize: '0.875rem',
                cursor: savingBot ? 'not-allowed' : 'pointer',
                opacity: savingBot ? 0.7 : 1,
              }}
            >
              {savingBot ? 'Saving Settings...' : 'Save Bot Settings'}
            </button>
          </div>
        </form>
      </div>
      </>
      )}

      {/* ── Sub-Tab 2: Usage & Budget View ── */}
      {activeSubTab === 'usage' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <div
            style={{
              background: 'rgba(30, 41, 59, 0.6)',
              borderRadius: '16px',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              padding: '24px',
            }}
          >
            <h3 style={{ margin: '0 0 16px', fontSize: '1.05rem', fontWeight: 600, color: '#f8fafc' }}>
              Daily Token Budget & Metering
            </h3>

            {usage ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', fontSize: '0.85rem' }}>
                    <span style={{ color: '#94a3b8' }}>
                      Tokens Used: <strong style={{ color: '#f8fafc' }}>{usage.totalTokens.toLocaleString()}</strong> / {(usage.dailyBudget ?? 200_000).toLocaleString()}
                    </span>
                    <span style={{ color: usage.percentUsed > 90 ? '#f87171' : '#818cf8', fontWeight: 600 }}>
                      {usage.percentUsed}%
                    </span>
                  </div>
                  <div style={{ width: '100%', height: '10px', background: 'rgba(15, 23, 42, 0.6)', borderRadius: '5px', overflow: 'hidden' }}>
                    <div
                      style={{
                        width: `${Math.min(100, usage.percentUsed)}%`,
                        height: '100%',
                        background: usage.percentUsed > 90
                          ? 'linear-gradient(90deg, #f59e0b, #ef4444)'
                          : 'linear-gradient(90deg, #6366f1, #a855f7)',
                        borderRadius: '5px',
                        transition: 'width 0.4s ease',
                      }}
                    />
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '16px' }}>
                  <div style={{ background: 'rgba(15, 23, 42, 0.5)', padding: '16px', borderRadius: '12px', border: '1px solid rgba(255, 255, 255, 0.06)' }}>
                    <div style={{ fontSize: '0.75rem', color: '#94a3b8', textTransform: 'uppercase' }}>Prompt Tokens</div>
                    <div style={{ fontSize: '1.25rem', fontWeight: 700, color: '#f8fafc', marginTop: '4px' }}>
                      {usage.promptTokens.toLocaleString()}
                    </div>
                  </div>
                  <div style={{ background: 'rgba(15, 23, 42, 0.5)', padding: '16px', borderRadius: '12px', border: '1px solid rgba(255, 255, 255, 0.06)' }}>
                    <div style={{ fontSize: '0.75rem', color: '#94a3b8', textTransform: 'uppercase' }}>Completion Tokens</div>
                    <div style={{ fontSize: '1.25rem', fontWeight: 700, color: '#f8fafc', marginTop: '4px' }}>
                      {usage.completionTokens.toLocaleString()}
                    </div>
                  </div>
                  <div style={{ background: 'rgba(15, 23, 42, 0.5)', padding: '16px', borderRadius: '12px', border: '1px solid rgba(255, 255, 255, 0.06)' }}>
                    <div style={{ fontSize: '0.75rem', color: '#94a3b8', textTransform: 'uppercase' }}>Estimated Cost</div>
                    <div style={{ fontSize: '1.25rem', fontWeight: 700, color: '#10b981', marginTop: '4px' }}>
                      ${usage.estimatedCostUsd.toFixed(4)}
                    </div>
                  </div>
                  <div style={{ background: 'rgba(15, 23, 42, 0.5)', padding: '16px', borderRadius: '12px', border: '1px solid rgba(255, 255, 255, 0.06)' }}>
                    <div style={{ fontSize: '0.75rem', color: '#94a3b8', textTransform: 'uppercase' }}>Rate Limit</div>
                    <div style={{ fontSize: '1.25rem', fontWeight: 700, color: '#38bdf8', marginTop: '4px' }}>
                      {usage.rpmLimit} req/min
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div style={{ color: '#94a3b8', fontSize: '0.9rem' }}>No usage recorded yet today.</div>
            )}
          </div>
        </div>
      )}

      {/* ── Sub-Tab 3: Activity & Traces View ── */}
      {activeSubTab === 'traces' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 600, color: '#f8fafc' }}>
              Companion Activity & Decision Traces
            </h3>
            <button
              type="button"
              onClick={loadTraces}
              disabled={loadingTraces}
              style={{
                background: 'rgba(255, 255, 255, 0.08)',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                color: '#e2e8f0',
                padding: '6px 12px',
                borderRadius: '6px',
                fontSize: '0.8rem',
                cursor: 'pointer',
              }}
            >
              {loadingTraces ? 'Refreshing...' : '🔄 Refresh Traces'}
            </button>
          </div>

          {loadingTraces && traces.length === 0 ? (
            <div style={{ padding: '40px', textAlign: 'center', color: '#94a3b8' }}>Loading traces...</div>
          ) : traces.length === 0 ? (
            <div
              style={{
                background: 'rgba(30, 41, 59, 0.4)',
                borderRadius: '12px',
                border: '1px dashed rgba(255, 255, 255, 0.1)',
                padding: '36px',
                textAlign: 'center',
                color: '#94a3b8',
              }}
            >
              <div style={{ fontSize: '32px', marginBottom: '8px' }}>📜</div>
              <div style={{ fontWeight: 600, color: '#e2e8f0' }}>No Traces Recorded</div>
              <div style={{ fontSize: '0.85rem', marginTop: '4px' }}>
                When the bot processes chat commands or triggers skills, full decision traces will appear here.
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {traces.map((trace) => {
                const isExpanded = expandedTraceId === trace.id;
                return (
                  <div
                    key={trace.id}
                    style={{
                      background: 'rgba(30, 41, 59, 0.6)',
                      borderRadius: '12px',
                      border: '1px solid rgba(255, 255, 255, 0.08)',
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      onClick={() => setExpandedTraceId(isExpanded ? null : trace.id)}
                      style={{
                        padding: '14px 18px',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        background: isExpanded ? 'rgba(255, 255, 255, 0.03)' : 'transparent',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        <span
                          style={{
                            fontSize: '0.75rem',
                            padding: '3px 8px',
                            borderRadius: '12px',
                            fontWeight: 600,
                            background: trace.status === 'success' ? 'rgba(34, 197, 94, 0.2)' : 'rgba(239, 68, 68, 0.2)',
                            color: trace.status === 'success' ? '#4ade80' : '#f87171',
                          }}
                        >
                          {trace.status}
                        </span>
                        <span style={{ fontSize: '0.85rem', color: '#cbd5e1' }}>
                          {new Date(trace.timestamp).toLocaleTimeString()}
                        </span>
                        <span style={{ fontSize: '0.8rem', color: '#64748b' }}>
                          ({trace.latencyMs}ms)
                        </span>
                      </div>
                      <span style={{ color: '#94a3b8', fontSize: '0.8rem' }}>
                        {isExpanded ? 'Hide Trace ▲' : 'View Trace ▼'}
                      </span>
                    </div>

                    {isExpanded && (
                      <div style={{ padding: '16px 18px', borderTop: '1px solid rgba(255, 255, 255, 0.06)', background: 'rgba(15, 23, 42, 0.5)' }}>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '16px' }}>
                          <div>
                            <div style={{ fontSize: '0.75rem', fontWeight: 600, color: '#94a3b8', marginBottom: '6px' }}>
                              REQUEST TO MODEL
                            </div>
                            <pre
                              style={{
                                margin: 0,
                                padding: '12px',
                                borderRadius: '8px',
                                background: 'rgba(0, 0, 0, 0.3)',
                                fontSize: '0.75rem',
                                color: '#e2e8f0',
                                overflowX: 'auto',
                                maxHeight: '200px',
                              }}
                            >
                              {JSON.stringify(trace.request, null, 2)}
                            </pre>
                          </div>
                          <div>
                            <div style={{ fontSize: '0.75rem', fontWeight: 600, color: '#94a3b8', marginBottom: '6px' }}>
                              MODEL DECISION & TOOLS
                            </div>
                            <pre
                              style={{
                                margin: 0,
                                padding: '12px',
                                borderRadius: '8px',
                                background: 'rgba(0, 0, 0, 0.3)',
                                fontSize: '0.75rem',
                                color: '#a5b4fc',
                                overflowX: 'auto',
                                maxHeight: '200px',
                              }}
                            >
                              {JSON.stringify(trace.response, null, 2)}
                            </pre>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Sub-Tab 4: AI Provider Endpoints Manager ── */}
      {activeSubTab === 'endpoints' && (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: '24px' }}>
        {/* Left Column: Configured Endpoints */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 600, color: '#f8fafc' }}>
              Connected AI Endpoints ({endpoints.length})
            </h3>
            {editingId && (
              <button
                type="button"
                onClick={resetForm}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: '#94a3b8',
                  cursor: 'pointer',
                  fontSize: '0.85rem',
                  textDecoration: 'underline',
                }}
              >
                + Add New Instead
              </button>
            )}
          </div>

          {endpoints.length === 0 ? (
            <div
              style={{
                background: 'rgba(30, 41, 59, 0.4)',
                borderRadius: '12px',
                border: '1px dashed rgba(255, 255, 255, 0.1)',
                padding: '36px',
                textAlign: 'center',
                color: '#94a3b8',
              }}
            >
              <div style={{ fontSize: '32px', marginBottom: '8px' }}>⚡</div>
              <div style={{ fontWeight: 600, color: '#e2e8f0', marginBottom: '4px' }}>No Endpoints Configured</div>
              <div style={{ fontSize: '0.85rem' }}>
                Use the form on the right to connect an OpenAI, OpenRouter, Vercel AI Gateway, Groq, or local Ollama endpoint.
              </div>
            </div>
          ) : (
            endpoints.map((ep) => {
              const isTesting = testingId === ep.id;
              const hasTestResult = testResult?.id === ep.id;

              return (
                <div
                  key={ep.id}
                  style={{
                    background: 'rgba(30, 41, 59, 0.6)',
                    borderRadius: '14px',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    padding: '20px',
                    transition: 'all 0.2s ease',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '10px' }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ fontWeight: 600, fontSize: '1rem', color: '#f8fafc' }}>{ep.name}</span>
                        {ep.supportsTools ? (
                          <span
                            title="Supports native function calling tools"
                            style={{
                              fontSize: '0.7rem',
                              padding: '2px 7px',
                              borderRadius: '10px',
                              background: 'rgba(16, 185, 129, 0.15)',
                              color: '#34d399',
                              border: '1px solid rgba(16, 185, 129, 0.25)',
                            }}
                          >
                            🛠️ Tools
                          </span>
                        ) : (
                          <span
                            title="Uses JSON action fallback mode"
                            style={{
                              fontSize: '0.7rem',
                              padding: '2px 7px',
                              borderRadius: '10px',
                              background: 'rgba(234, 179, 8, 0.15)',
                              color: '#facc15',
                              border: '1px solid rgba(234, 179, 8, 0.25)',
                            }}
                          >
                            📝 JSON Mode
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: '0.8rem', color: '#94a3b8', marginTop: '2px', wordBreak: 'break-all' }}>
                        {ep.baseUrl}
                      </div>
                    </div>

                    <div style={{ display: 'flex', gap: '6px' }}>
                      <button
                        type="button"
                        onClick={() => handleEdit(ep)}
                        title="Edit"
                        style={{
                          background: 'rgba(255, 255, 255, 0.05)',
                          border: '1px solid rgba(255, 255, 255, 0.1)',
                          color: '#e2e8f0',
                          padding: '6px 10px',
                          borderRadius: '8px',
                          cursor: 'pointer',
                          fontSize: '0.8rem',
                        }}
                      >
                        ✏️
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(ep.id, ep.name)}
                        title="Delete"
                        style={{
                          background: 'rgba(239, 68, 68, 0.1)',
                          border: '1px solid rgba(239, 68, 68, 0.2)',
                          color: '#f87171',
                          padding: '6px 10px',
                          borderRadius: '8px',
                          cursor: 'pointer',
                          fontSize: '0.8rem',
                        }}
                      >
                        🗑️
                      </button>
                    </div>
                  </div>

                  <div
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: '12px',
                      fontSize: '0.8rem',
                      color: '#cbd5e1',
                      background: 'rgba(15, 23, 42, 0.4)',
                      padding: '10px 14px',
                      borderRadius: '8px',
                      marginBottom: '14px',
                    }}
                  >
                    <div>
                      <span style={{ color: '#64748b' }}>Model: </span>
                      <code>{ep.defaultModel || 'auto'}</code>
                    </div>
                    <div>
                      <span style={{ color: '#64748b' }}>Key: </span>
                      <code>{ep.lastFour || 'None'}</code>
                    </div>
                    <div>
                      <span style={{ color: '#64748b' }}>Timeout: </span>
                      <span>{ep.timeoutS}s</span>
                    </div>
                  </div>

                  {/* Test Connection Button & Result */}
                  <div>
                    <button
                      type="button"
                      disabled={isTesting}
                      onClick={() => handleTestConnection(ep.id)}
                      style={{
                        background: 'linear-gradient(135deg, rgba(99, 102, 241, 0.2), rgba(139, 92, 246, 0.2))',
                        border: '1px solid rgba(99, 102, 241, 0.4)',
                        color: '#c7d2fe',
                        padding: '8px 14px',
                        borderRadius: '8px',
                        cursor: isTesting ? 'not-allowed' : 'pointer',
                        fontSize: '0.85rem',
                        fontWeight: 500,
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                      }}
                    >
                      {isTesting ? '🔄 Testing connection...' : '⚡ Test Connection'}
                    </button>

                    {hasTestResult && testResult && (
                      <div
                        style={{
                          marginTop: '12px',
                          background: 'rgba(15, 23, 42, 0.7)',
                          borderRadius: '10px',
                          border: '1px solid rgba(255, 255, 255, 0.08)',
                          padding: '12px',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '8px',
                        }}
                      >
                        <div style={{ fontSize: '0.78rem', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase' }}>
                          Validation Results
                        </div>
                        {testResult.result.steps.map((step, idx) => (
                          <div
                            key={idx}
                            style={{
                              display: 'flex',
                              alignItems: 'flex-start',
                              gap: '10px',
                              fontSize: '0.82rem',
                            }}
                          >
                            <span style={{ fontSize: '0.9rem', lineHeight: '1.2' }}>
                              {step.status === 'pass' ? '✅' : step.status === 'warn' ? '⚠️' : '❌'}
                            </span>
                            <div style={{ flex: 1 }}>
                              <span style={{ fontWeight: 600, color: '#f8fafc' }}>{step.name}: </span>
                              <span
                                style={{
                                  color: step.status === 'pass' ? '#94a3b8' : step.status === 'warn' ? '#fde047' : '#f87171',
                                }}
                              >
                                {step.message}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Right Column: Connect / Edit Endpoint Form */}
        <div
          style={{
            background: 'rgba(30, 41, 59, 0.5)',
            borderRadius: '16px',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            padding: '24px',
            height: 'fit-content',
          }}
        >
          <h3 style={{ margin: '0 0 16px', fontSize: '1.05rem', fontWeight: 600, color: '#f8fafc' }}>
            {editingId ? 'Edit LLM Endpoint' : 'Connect New AI Provider'}
          </h3>

          {!editingId && presets.length > 0 && (
            <div style={{ marginBottom: '18px' }}>
              <label style={{ display: 'block', fontSize: '0.8rem', color: '#94a3b8', marginBottom: '8px' }}>
                Quick Presets
              </label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                {presets.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => handlePresetSelect(preset.id)}
                    style={{
                      background: selectedPreset === preset.id ? 'rgba(99, 102, 241, 0.3)' : 'rgba(15, 23, 42, 0.5)',
                      border: `1px solid ${selectedPreset === preset.id ? '#818cf8' : 'rgba(255, 255, 255, 0.08)'}`,
                      color: selectedPreset === preset.id ? '#ffffff' : '#94a3b8',
                      padding: '6px 12px',
                      borderRadius: '8px',
                      fontSize: '0.8rem',
                      cursor: 'pointer',
                      fontWeight: selectedPreset === preset.id ? 600 : 400,
                      transition: 'all 0.15s ease',
                    }}
                  >
                    {preset.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.8rem', color: '#94a3b8', marginBottom: '6px' }}>
                Display Name *
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. OpenAI Production"
                required
                style={{
                  width: '100%',
                  padding: '9px 12px',
                  borderRadius: '8px',
                  background: 'rgba(15, 23, 42, 0.6)',
                  border: '1px solid rgba(255, 255, 255, 0.12)',
                  color: '#f8fafc',
                  fontSize: '0.875rem',
                }}
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.8rem', color: '#94a3b8', marginBottom: '6px' }}>
                Base URL *
              </label>
              <input
                type="url"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://api.openai.com/v1"
                required
                style={{
                  width: '100%',
                  padding: '9px 12px',
                  borderRadius: '8px',
                  background: 'rgba(15, 23, 42, 0.6)',
                  border: '1px solid rgba(255, 255, 255, 0.12)',
                  color: '#f8fafc',
                  fontSize: '0.875rem',
                }}
              />
              <span style={{ fontSize: '0.72rem', color: '#64748b', marginTop: '4px', display: 'block' }}>
                Must be an OpenAI-compatible endpoint. Local Ollama: http://localhost:11434/v1
              </span>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.8rem', color: '#94a3b8', marginBottom: '6px' }}>
                API Key {editingId && '(Leave blank to keep existing key)'}
              </label>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={editingId ? '••••••••••••••••' : 'sk-... (optional for local Ollama)'}
                style={{
                  width: '100%',
                  padding: '9px 12px',
                  borderRadius: '8px',
                  background: 'rgba(15, 23, 42, 0.6)',
                  border: '1px solid rgba(255, 255, 255, 0.12)',
                  color: '#f8fafc',
                  fontSize: '0.875rem',
                }}
              />
              <span style={{ fontSize: '0.72rem', color: '#64748b', marginTop: '4px', display: 'block' }}>
                🔒 Encrypted at rest via AES-256-GCM. Never exposed in API responses.
              </span>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 100px', gap: '12px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.8rem', color: '#94a3b8', marginBottom: '6px' }}>
                  Default Model
                </label>
                <input
                  type="text"
                  value={defaultModel}
                  onChange={(e) => setDefaultModel(e.target.value)}
                  placeholder="gpt-4o-mini"
                  style={{
                    width: '100%',
                    padding: '9px 12px',
                    borderRadius: '8px',
                    background: 'rgba(15, 23, 42, 0.6)',
                    border: '1px solid rgba(255, 255, 255, 0.12)',
                    color: '#f8fafc',
                    fontSize: '0.875rem',
                  }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.8rem', color: '#94a3b8', marginBottom: '6px' }}>
                  Timeout (s)
                </label>
                <input
                  type="number"
                  min="5"
                  max="120"
                  value={timeoutS}
                  onChange={(e) => setTimeoutS(parseInt(e.target.value, 10) || 30)}
                  style={{
                    width: '100%',
                    padding: '9px 12px',
                    borderRadius: '8px',
                    background: 'rgba(15, 23, 42, 0.6)',
                    border: '1px solid rgba(255, 255, 255, 0.12)',
                    color: '#f8fafc',
                    fontSize: '0.875rem',
                  }}
                />
              </div>
            </div>

            <div style={{ display: 'flex', gap: '10px', marginTop: '8px' }}>
              <button
                type="submit"
                disabled={submitting}
                style={{
                  flex: 1,
                  background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
                  border: 'none',
                  color: '#ffffff',
                  padding: '10px 16px',
                  borderRadius: '8px',
                  fontWeight: 600,
                  fontSize: '0.875rem',
                  cursor: submitting ? 'not-allowed' : 'pointer',
                  boxShadow: '0 4px 14px rgba(99, 102, 241, 0.3)',
                  transition: 'opacity 0.2s',
                  opacity: submitting ? 0.7 : 1,
                }}
              >
                {submitting ? 'Saving...' : editingId ? 'Update Endpoint' : 'Save & Connect'}
              </button>

              {editingId && (
                <button
                  type="button"
                  onClick={resetForm}
                  style={{
                    background: 'rgba(255, 255, 255, 0.08)',
                    border: '1px solid rgba(255, 255, 255, 0.12)',
                    color: '#e2e8f0',
                    padding: '10px 16px',
                    borderRadius: '8px',
                    fontWeight: 500,
                    fontSize: '0.875rem',
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
              )}
            </div>
          </form>

          {/* Security & Architecture Note */}
          <div
            style={{
              marginTop: '20px',
              padding: '12px',
              borderRadius: '8px',
              background: 'rgba(15, 23, 42, 0.4)',
              border: '1px solid rgba(255, 255, 255, 0.05)',
              fontSize: '0.75rem',
              color: '#94a3b8',
              lineHeight: '1.4',
            }}
          >
            🛡️ <strong>Zero-Trust Architecture:</strong> Bots authenticate with the panel gateway via short-lived HMAC tokens. API keys never leave the server or enter bot containers.
          </div>
        </div>
      </div>
      )}

      {/* ── Bot Live Logs Sub-Tab ── */}
      {activeSubTab === 'logs' && (
        <div style={{ background: '#121624', border: '1px solid rgba(255, 255, 255, 0.08)', borderRadius: '12px', padding: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid rgba(255, 255, 255, 0.08)', paddingBottom: '14px', marginBottom: '16px', flexWrap: 'wrap', gap: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span style={{ fontSize: '1.25rem' }}>📜</span>
              <div>
                <h3 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 600, color: '#f8fafc' }}>
                  Live Companion Bot Runner Logs
                </h3>
                <p style={{ margin: '2px 0 0', fontSize: '0.75rem', color: '#94a3b8' }}>
                  Real-time stdout/stderr output from the companion bot container
                </p>
              </div>
              {bot?.containerId && (
                <span style={{ fontFamily: 'monospace', fontSize: '0.75rem', background: 'rgba(255, 255, 255, 0.05)', padding: '2px 8px', borderRadius: '4px', border: '1px solid rgba(255, 255, 255, 0.1)', color: '#cbd5e1' }}>
                  {bot.containerId.slice(0, 12)}
                </span>
              )}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.8rem', color: '#94a3b8', cursor: 'pointer', userSelect: 'none' }}>
                <input
                  type="checkbox"
                  checked={autoScrollLogs}
                  onChange={(e) => setAutoScrollLogs(e.target.checked)}
                  style={{ accentColor: '#6366f1' }}
                />
                Auto-scroll
              </label>
              <button
                type="button"
                onClick={fetchBotLogs}
                disabled={loadingLogs}
                style={{
                  background: 'rgba(99, 102, 241, 0.15)',
                  border: '1px solid rgba(99, 102, 241, 0.3)',
                  color: '#818cf8',
                  padding: '6px 14px',
                  borderRadius: '6px',
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  cursor: loadingLogs ? 'not-allowed' : 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                }}
              >
                <span>🔄</span>
                <span>{loadingLogs ? 'Loading...' : 'Refresh Logs'}</span>
              </button>
            </div>
          </div>

          <div
            ref={botLogsContainerRef}
            style={{
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
              fontSize: '0.75rem',
              background: '#090d16',
              border: '1px solid rgba(255, 255, 255, 0.06)',
              borderRadius: '8px',
              padding: '14px',
              height: '460px',
              overflowY: 'auto',
              color: '#e2e8f0',
              lineHeight: '1.6',
              boxShadow: 'inset 0 2px 4px rgba(0, 0, 0, 0.5)',
              userSelect: 'text',
            }}
          >
            {botLogs.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '60px 20px', color: '#64748b' }}>
                <div style={{ fontSize: '1.5rem', marginBottom: '8px' }}>💬</div>
                <p style={{ margin: 0 }}>No bot logs recorded yet.</p>
                <p style={{ margin: '4px 0 0', fontSize: '0.75rem' }}>
                  Click "Spawn Bot Into Server" in the Controls tab to run the companion container.
                </p>
              </div>
            ) : (
              botLogs.map((line, idx) => {
                const isError = line.toLowerCase().includes('error') || line.includes('Invalid') || line.includes('failed');
                const isWarn = line.toLowerCase().includes('warn');
                const isSuccess = line.includes('successfully spawned') || line.includes('ready') || line.includes('connected');
                const isBot = line.includes('[BotRunner]');

                let color = '#cbd5e1';
                if (isError) color = '#f87171';
                else if (isWarn) color = '#fbbf24';
                else if (isSuccess) color = '#4ade80';
                else if (isBot) color = '#38bdf8';

                return (
                  <div key={idx} style={{ color, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                    {line}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* ── Microsoft Device Code Modal ── */}
      {deviceCodeModal?.open && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.75)',
            backdropFilter: 'blur(8px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
        >
          <div
            style={{
              background: '#0f172a',
              border: '1px solid rgba(255, 255, 255, 0.15)',
              borderRadius: '16px',
              padding: '28px',
              maxWidth: '450px',
              width: '90%',
              display: 'flex',
              flexDirection: 'column',
              gap: '16px',
            }}
          >
            <h3 style={{ margin: 0, color: '#f8fafc', fontSize: '1.2rem', fontWeight: 600 }}>
              Microsoft Account Link
            </h3>
            <p style={{ margin: 0, color: '#94a3b8', fontSize: '0.875rem', lineHeight: '1.5' }}>
              To connect your Minecraft Java account to the companion bot, visit the link below and enter the one-time code:
            </p>

            <div
              style={{
                background: 'rgba(99, 102, 241, 0.1)',
                border: '1px solid rgba(99, 102, 241, 0.3)',
                padding: '16px',
                borderRadius: '12px',
                textAlign: 'center',
              }}
            >
              <div style={{ fontSize: '0.75rem', color: '#94a3b8', textTransform: 'uppercase' }}>One-Time Code</div>
              <div style={{ fontSize: '2rem', fontWeight: 800, color: '#818cf8', letterSpacing: '0.1em', marginTop: '4px' }}>
                {deviceCodeModal.userCode}
              </div>
            </div>

            <div style={{ display: 'flex', gap: '10px' }}>
              <a
                href={deviceCodeModal.verificationUri}
                target="_blank"
                rel="noreferrer"
                style={{
                  flex: 1,
                  textAlign: 'center',
                  background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
                  color: '#ffffff',
                  padding: '10px',
                  borderRadius: '8px',
                  fontWeight: 600,
                  fontSize: '0.875rem',
                  textDecoration: 'none',
                }}
              >
                Open Microsoft Link ↗
              </a>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(deviceCodeModal.userCode || '');
                  addToast({ type: 'success', title: 'Code copied to clipboard!' });
                }}
                style={{
                  background: 'rgba(255, 255, 255, 0.08)',
                  border: '1px solid rgba(255, 255, 255, 0.12)',
                  color: '#f8fafc',
                  padding: '10px 16px',
                  borderRadius: '8px',
                  fontWeight: 500,
                  fontSize: '0.875rem',
                  cursor: 'pointer',
                }}
              >
                Copy Code
              </button>
            </div>

            <button
              type="button"
              onClick={() => setDeviceCodeModal(null)}
              style={{
                background: 'transparent',
                border: 'none',
                color: '#64748b',
                padding: '6px',
                cursor: 'pointer',
                fontSize: '0.85rem',
                textDecoration: 'underline',
              }}
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
