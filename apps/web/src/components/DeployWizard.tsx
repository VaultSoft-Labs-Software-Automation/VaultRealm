import { useState, useEffect } from 'react';
import { api, type GameTemplate, type CapacityStatus, type ApiError } from '../api/client';
import { useToast } from './Toast';

interface DeployWizardProps {
  onClose: () => void;
  onSuccess: (serverId: string) => void;
}

interface StepEvent {
  step: number;
  stepName: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  message: string;
  percent?: number;
}

export function DeployWizard({ onClose, onSuccess }: DeployWizardProps) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [templates, setTemplates] = useState<GameTemplate[]>([]);
  const [capacity, setCapacity] = useState<CapacityStatus | null>(null);
  const [selectedTemplate, setSelectedTemplate] = useState<GameTemplate | null>(null);
  const [serverName, setServerName] = useState('');
  const [ramMb, setRamMb] = useState(2048);
  const [envValues, setEnvValues] = useState<Record<string, string>>({});
  const [availableVersions, setAvailableVersions] = useState<string[]>(['LATEST']);
  const [loadingVersions, setLoadingVersions] = useState(false);
  const [versionSource, setVersionSource] = useState<string>('');
  const [isCustomType, setIsCustomType] = useState(false);
  const [isCustomVersion, setIsCustomVersion] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [loading, setLoading] = useState(false);
  const [deployEvents, setDeployEvents] = useState<StepEvent[]>([
    { step: 1, stepName: 'validate', status: 'pending', message: 'Validate template & input parameters' },
    { step: 2, stepName: 'quota', status: 'pending', message: 'Verify user quota & host capacity' },
    { step: 3, stepName: 'ports', status: 'pending', message: 'Allocate host ports from range' },
    { step: 4, stepName: 'volume', status: 'pending', message: 'Prepare persistent storage volume' },
    { step: 5, stepName: 'pull', status: 'pending', message: 'Pull Docker image' },
    { step: 6, stepName: 'create', status: 'pending', message: 'Create hardened Docker container' },
    { step: 7, stepName: 'start', status: 'pending', message: 'Start container process' },
    { step: 8, stepName: 'verify', status: 'pending', message: 'Verify container readiness' },
    { step: 9, stepName: 'done', status: 'pending', message: 'Server deployment complete' },
  ]);

  const { addToast } = useToast();

  useEffect(() => {
    api.listTemplates().then(setTemplates).catch(console.error);
    api.getCapacity().then(setCapacity).catch(console.error);
  }, []);

  const handleSelectTemplate = (t: GameTemplate) => {
    setSelectedTemplate(t);
    setServerName(`My ${t.name} Server`);
    setRamMb(t.defaultRamMb);
    setIsCustomType(false);
    setIsCustomVersion(false);
    setShowAdvanced(false);

    // Default envs
    const defaults: Record<string, string> = {};
    for (const e of t.env) {
      if (e.default !== undefined) {
        defaults[e.key] = e.default;
      }
    }
    setEnvValues(defaults);
    setStep(2);

    // Pull open-source versions for Minecraft or versioned games
    const hasVersionKey = t.env.some((e) => e.key === 'VERSION');
    if (hasVersionKey) {
      setLoadingVersions(true);
      api
        .getTemplateVersions(t.id)
        .then((res) => {
          setAvailableVersions(res.versions);
          setVersionSource(res.source);
        })
        .catch(() => {
          // Direct client-side fetch fallback to official Mojang manifest
          fetch('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json')
            .then((r) => r.json())
            .then((data: { versions?: Array<{ id: string; type: string }> }) => {
              const releases = (data.versions || [])
                .filter((v) => v.type === 'release')
                .map((v) => v.id);
              setAvailableVersions(['LATEST', ...releases]);
              setVersionSource('Mojang Web API (Direct)');
            })
            .catch(() => {
              setAvailableVersions([
                'LATEST',
                '1.21.4',
                '1.21.3',
                '1.21.1',
                '1.20.6',
                '1.20.4',
                '1.20.1',
                '1.19.4',
                '1.18.2',
                '1.16.5',
                '1.12.2',
              ]);
              setVersionSource('Built-in Manifest');
            });
        })
        .finally(() => {
          setLoadingVersions(false);
        });
    } else {
      setAvailableVersions(['LATEST']);
      setVersionSource('');
    }
  };

  const toggleModPreset = (presetSlug: string) => {
    const raw = envValues['MODRINTH_PROJECTS'] || '';
    const current = raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    let next: string[];
    if (current.includes(presetSlug.toLowerCase())) {
      next = current.filter((s) => s !== presetSlug.toLowerCase());
    } else {
      next = [...current, presetSlug.toLowerCase()];
    }
    setEnvValues((prev) => ({ ...prev, MODRINTH_PROJECTS: next.join(', ') }));
  };

  const handleStartDeploy = async () => {
    if (!selectedTemplate) return;
    setLoading(true);
    setStep(3);

    try {
      const res = await api.deployServer({
        name: serverName,
        templateId: selectedTemplate.id,
        ramMb,
        env: envValues,
      });

      const serverId = res.id;

      // Subscribe to Server-Sent Events (SSE) for 9-step progress
      // withCredentials is required so the browser sends the session cookie
      const token = api.getToken();
      const tokenParam = token ? `?token=${encodeURIComponent(token)}` : '';
      const eventSource = new EventSource(`/api/servers/${serverId}/deploy-stream${tokenParam}`, {
        withCredentials: true,
      });

      eventSource.onmessage = (event) => {
        try {
          const data: StepEvent = JSON.parse(event.data);
          setDeployEvents((prev) =>
            prev.map((item) =>
              item.step === data.step
                ? { ...item, status: data.status, message: data.message, percent: data.percent }
                : item,
            ),
          );

          if (data.step === 9 && data.status === 'completed') {
            eventSource.close();
            addToast({ type: 'success', title: 'Server deployed successfully!' });
            setTimeout(() => onSuccess(serverId), 1200);
          } else if (data.status === 'failed') {
            eventSource.close();
            addToast({ type: 'error', title: 'Deployment encountered an issue', message: data.message });
          }
        } catch {
          // ignore parse error
        }
      };

      eventSource.onerror = () => {
        // SSE closed or finished
        eventSource.close();
      };
    } catch (err) {
      const error = err as ApiError;
      addToast({ type: 'error', title: 'Deployment Blocked', message: error.message, details: error.details });
      setStep(2);
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-2 sm:p-4 animate-fade-in">
      <div className="card max-w-2xl w-full p-4 sm:p-6 md:p-8 border border-border shadow-2xl relative max-h-[94vh] sm:max-h-[90vh] flex flex-col glow-primary">
        {/* Header */}
        <div className="flex items-center justify-between pb-3 sm:pb-4 border-b border-border mb-4 sm:mb-6 shrink-0">
          <div>
            <h2 className="text-lg sm:text-xl font-bold gradient-text">One-Click Deploy Wizard</h2>
            <p className="text-[11px] sm:text-xs text-muted-foreground mt-0.5">
              {step === 1 && 'Step 1: Choose a game template to deploy'}
              {step === 2 && `Step 2: Configure ${selectedTemplate?.name} specifications`}
              {step === 3 && 'Step 3: Tracking deployment state machine'}
            </p>
          </div>
          <button
            onClick={() => {
              if (step === 3) {
                addToast({ type: 'info', title: 'Deployment continuing in background.' });
              }
              onClose();
            }}
            className="btn btn-ghost btn-sm p-1.5 text-base leading-none"
            title="Close"
          >
            ✕
          </button>
        </div>

        {/* Step 1: Template Selection */}
        {step === 1 && (
          <div className="flex-1 overflow-y-auto space-y-3 pr-1 touch-scroll">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 sm:gap-3">
              {templates.map((t) => (
                <div
                  key={t.id}
                  onClick={() => handleSelectTemplate(t)}
                  className="p-4 rounded-xl border border-border bg-card/60 hover:bg-card hover:border-primary/50 cursor-pointer transition-all duration-200 group flex flex-col justify-between"
                >
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-primary/20 text-primary">
                        {t.category}
                      </span>
                      <span className="text-xs text-muted-foreground font-mono">
                        Min {Math.round(t.minRamMb / 1024)} GB RAM
                      </span>
                    </div>
                    <h3 className="font-bold text-base text-foreground group-hover:text-primary transition-colors">
                      {t.name}
                    </h3>
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                      {t.description}
                    </p>
                  </div>
                  <div className="mt-4 pt-3 border-t border-border/40 flex items-center justify-between text-xs text-muted-foreground">
                    <span>{t.ports.map((p) => `${p.containerPort}/${p.protocol}`).join(', ')}</span>
                    <span className="text-primary font-medium group-hover:translate-x-1 transition-transform">
                      Select →
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Step 2: Configuration */}
        {step === 2 && selectedTemplate && (
          <div className="flex-1 overflow-y-auto space-y-5 pr-1">
            <div>
              <label className="block text-xs font-semibold text-muted-foreground mb-1 uppercase tracking-wider">
                Server Name
              </label>
              <input
                type="text"
                value={serverName}
                onChange={(e) => setServerName(e.target.value)}
                className="input w-full"
                placeholder="My Server"
              />
            </div>

            {/* RAM Slider */}
            <div className="card p-4 border border-border/60 bg-muted/20">
              <div className="flex justify-between items-center mb-2">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  RAM Allocation
                </span>
                <span className="text-sm font-bold text-primary font-mono">
                  {ramMb} MB ({Math.round(ramMb / 1024)} GB)
                </span>
              </div>
              <input
                type="range"
                min={selectedTemplate.minRamMb}
                max={Math.min(16384, capacity?.host.availableBudgetRamMb ?? 16384)}
                step={512}
                value={ramMb}
                onChange={(e) => setRamMb(Number(e.target.value))}
                className="w-full accent-primary cursor-pointer"
              />
              <div className="flex justify-between text-[10px] text-muted-foreground mt-1 font-mono">
                <span>Min: {selectedTemplate.minRamMb} MB</span>
                <span>Rec: {selectedTemplate.defaultRamMb} MB</span>
                <span>Max: {capacity ? `${capacity.host.availableBudgetRamMb} MB` : '16 GB'}</span>
              </div>
            </div>

            {/* Template Environment Variables */}
            <div className="space-y-3">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider block">
                Server Settings
              </span>

              {(() => {
                const isMinecraft = selectedTemplate.id === 'minecraft-java';
                const currentType = (envValues['TYPE'] || 'PAPER').toUpperCase();
                const isModLoader = ['FABRIC', 'FORGE', 'NEOFORGE', 'QUILT'].includes(currentType);
                const isPluginLoader = ['PAPER', 'PURPUR', 'SPIGOT'].includes(currentType);
                const currentProjectsList = (envValues['MODRINTH_PROJECTS'] || '')
                  .split(',')
                  .map((s) => s.trim().toLowerCase())
                  .filter(Boolean);

                const envList = selectedTemplate.env.filter(
                  (e) =>
                    e.key !== 'MEMORY' &&
                    e.key !== 'EULA' &&
                    e.key !== 'MODRINTH_PROJECTS' &&
                    e.key !== 'MODRINTH_MODPACK'
                );

                return (
                  <>
                    {/* Primary Settings (TYPE, VERSION, MOTD) */}
                    {envList.slice(0, 3).map((env) => {
                  // 1. VERSION dropdown (pulls from open-source web APIs)
                  if (env.key === 'VERSION') {
                    const currentVersion = envValues[env.key] ?? env.default ?? 'LATEST';
                    return (
                      <div key={env.key}>
                        <div className="flex items-center justify-between mb-1">
                          <label className="block text-xs font-semibold text-foreground">
                            {env.label}{' '}
                            <span className="text-[10px] text-muted-foreground font-mono">({env.key})</span>
                          </label>
                          <span
                            className="text-[10px] text-emerald-400 font-mono flex items-center gap-1.5 bg-emerald-950/40 border border-emerald-500/20 px-2 py-0.5 rounded"
                            title={versionSource}
                          >
                            <span
                              className={`h-1.5 w-1.5 rounded-full bg-emerald-400 ${
                                loadingVersions ? 'animate-ping' : 'animate-pulse'
                              }`}
                            ></span>
                            {loadingVersions ? 'Pulling from web...' : (versionSource || 'Mojang Manifest')}
                          </span>
                        </div>

                        <select
                          value={isCustomVersion ? 'CUSTOM' : currentVersion}
                          onChange={(e) => {
                            if (e.target.value === 'CUSTOM') {
                              setIsCustomVersion(true);
                              setEnvValues({ ...envValues, [env.key]: '' });
                            } else {
                              setIsCustomVersion(false);
                              setEnvValues({ ...envValues, [env.key]: e.target.value });
                            }
                          }}
                          className="input w-full text-xs font-mono bg-card"
                        >
                          <option value="LATEST">LATEST (Auto-update to newest official release)</option>
                          {availableVersions
                            .filter((v) => v !== 'LATEST')
                            .map((v) => (
                              <option key={v} value={v}>
                                {v}
                              </option>
                            ))}
                          <option value="CUSTOM">✏️ Custom / Snapshot Version...</option>
                        </select>

                        {isCustomVersion && (
                          <div className="mt-1.5 flex items-center gap-2">
                            <input
                              type="text"
                              placeholder="Enter version or snapshot (e.g. 1.21.4 or 24w45a)"
                              value={envValues[env.key] ?? ''}
                              onChange={(e) => setEnvValues({ ...envValues, [env.key]: e.target.value })}
                              className="input w-full text-xs font-mono"
                              autoFocus
                            />
                            <button
                              type="button"
                              onClick={() => {
                                setIsCustomVersion(false);
                                setEnvValues({ ...envValues, [env.key]: 'LATEST' });
                              }}
                              className="btn btn-secondary text-xs px-2.5 py-1.5 shrink-0"
                            >
                              Reset
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  }

                  // 2. TYPE dropdown (Engine / Mod Loader)
                  if (env.key === 'TYPE') {
                    const currentType = envValues[env.key] ?? env.default ?? 'PAPER';
                    const typeOptions = env.options ?? [
                      { label: 'Paper (Recommended - High Performance & Plugins)', value: 'PAPER' },
                      { label: 'Purpur (Paper fork with extra customization)', value: 'PURPUR' },
                      { label: 'Fabric (Lightweight & Modern Modding)', value: 'FABRIC' },
                      { label: 'Forge (Traditional Modding)', value: 'FORGE' },
                      { label: 'NeoForge (Modern Forge fork)', value: 'NEOFORGE' },
                      { label: 'Spigot (Classic Plugins)', value: 'SPIGOT' },
                      { label: 'Vanilla (Official Mojang Server)', value: 'VANILLA' },
                      { label: 'Folia (Multithreaded Paper for high player count)', value: 'FOLIA' },
                      { label: 'Quilt (QuiltMC Mod Loader)', value: 'QUILT' },
                    ];

                    return (
                      <div key={env.key}>
                        <label className="block text-xs font-semibold text-foreground mb-1">
                          {env.label}{' '}
                          <span className="text-[10px] text-muted-foreground font-mono">({env.key})</span>
                        </label>

                        <select
                          value={isCustomType ? 'CUSTOM' : currentType}
                          onChange={(e) => {
                            if (e.target.value === 'CUSTOM') {
                              setIsCustomType(true);
                              setEnvValues({ ...envValues, [env.key]: '' });
                            } else {
                              setIsCustomType(false);
                              setEnvValues({ ...envValues, [env.key]: e.target.value });
                            }
                          }}
                          className="input w-full text-xs bg-card"
                        >
                          {typeOptions.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                              {opt.label}
                            </option>
                          ))}
                          <option value="CUSTOM">✏️ Custom / Other Type...</option>
                        </select>

                        {isCustomType && (
                          <div className="mt-1.5 flex items-center gap-2">
                            <input
                              type="text"
                              placeholder="Enter custom server type (e.g. MOHIST, MAGMA)"
                              value={envValues[env.key] ?? ''}
                              onChange={(e) => setEnvValues({ ...envValues, [env.key]: e.target.value })}
                              className="input w-full text-xs"
                              autoFocus
                            />
                            <button
                              type="button"
                              onClick={() => {
                                setIsCustomType(false);
                                setEnvValues({ ...envValues, [env.key]: env.default ?? 'PAPER' });
                              }}
                              className="btn btn-secondary text-xs px-2.5 py-1.5 shrink-0"
                            >
                              Reset
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  }

                  // 3. Dropdown for any env with options (e.g. DIFFICULTY, MODE, etc.)
                  if (env.options && env.options.length > 0) {
                    const currentValue = envValues[env.key] ?? env.default ?? env.options[0]?.value;
                    return (
                      <div key={env.key}>
                        <label className="block text-xs font-semibold text-foreground mb-1">
                          {env.label}{' '}
                          <span className="text-[10px] text-muted-foreground font-mono">({env.key})</span>
                        </label>
                        <select
                          value={currentValue}
                          onChange={(e) => setEnvValues({ ...envValues, [env.key]: e.target.value })}
                          className="input w-full text-xs bg-card"
                        >
                          {env.options.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    );
                  }

                  // 4. Default text input (e.g. MOTD)
                  return (
                    <div key={env.key}>
                      <label className="block text-xs font-semibold text-foreground mb-1">
                        {env.label}{' '}
                        <span className="text-[10px] text-muted-foreground font-mono">({env.key})</span>
                      </label>
                      <input
                        type="text"
                        value={envValues[env.key] ?? ''}
                        onChange={(e) => setEnvValues({ ...envValues, [env.key]: e.target.value })}
                        className="input w-full text-xs"
                      />
                    </div>
                  );
                })}

                    {/* Advanced Settings Toggle */}
                    {envList.length > 3 && (
                      <div className="pt-1">
                        <button
                          type="button"
                          onClick={() => setShowAdvanced(!showAdvanced)}
                          className="text-xs text-primary/90 hover:text-primary transition-colors flex items-center gap-1 font-mono"
                        >
                          <span>{showAdvanced ? '▾' : '▸'}</span>
                          <span>
                            {showAdvanced
                              ? 'Hide Advanced Options'
                              : '⚙️ Show Advanced Options (Difficulty, Mode, Players)'}
                          </span>
                        </button>

                        {showAdvanced && (
                          <div className="mt-3 space-y-3 pl-3 border-l-2 border-primary/20">
                            {envList.slice(3).map((env) => {
                              if (env.options && env.options.length > 0) {
                                const val = envValues[env.key] ?? env.default ?? env.options[0]?.value;
                                return (
                                  <div key={env.key}>
                                    <label className="block text-xs font-semibold text-foreground mb-1">
                                      {env.label}{' '}
                                      <span className="text-[10px] text-muted-foreground font-mono">({env.key})</span>
                                    </label>
                                    <select
                                      value={val}
                                      onChange={(e) => setEnvValues({ ...envValues, [env.key]: e.target.value })}
                                      className="input w-full text-xs bg-card"
                                    >
                                      {env.options.map((opt) => (
                                        <option key={opt.value} value={opt.value}>
                                          {opt.label}
                                        </option>
                                      ))}
                                    </select>
                                  </div>
                                );
                              }
                              return (
                                <div key={env.key}>
                                  <label className="block text-xs font-semibold text-foreground mb-1">
                                    {env.label}{' '}
                                    <span className="text-[10px] text-muted-foreground font-mono">({env.key})</span>
                                  </label>
                                  <input
                                    type="text"
                                    value={envValues[env.key] ?? ''}
                                    onChange={(e) => setEnvValues({ ...envValues, [env.key]: e.target.value })}
                                    className="input w-full text-xs"
                                  />
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Open-Source Modding / Community Addons (Minecraft Java) */}
                    {isMinecraft && (isModLoader || isPluginLoader) && (
                      <div className="card p-4 border border-violet-500/30 bg-violet-950/20 rounded-lg space-y-3 mt-4">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className="text-base">🧩</span>
                            <div>
                              <h4 className="text-xs font-bold text-foreground">
                                {isModLoader
                                  ? `Open-Source Modding (${currentType})`
                                  : `Community Plugins (${currentType})`}
                              </h4>
                              <p className="text-[11px] text-muted-foreground">
                                Auto-download open-source community {isModLoader ? 'mods' : 'plugins'} from Modrinth on startup
                              </p>
                            </div>
                          </div>
                          <span className="badge badge-info text-[10px] py-0 px-2 font-mono">
                            Modrinth API
                          </span>
                        </div>

                        {/* Preset Pills */}
                        <div>
                          <span className="text-[11px] font-semibold text-muted-foreground block mb-1.5">
                            Popular {isModLoader ? 'Mods' : 'Plugins'} (Click to toggle):
                          </span>
                          <div className="flex flex-wrap gap-1.5">
                            {(isModLoader
                              ? [
                                  { id: 'fabric-api', name: 'Fabric API' },
                                  { id: 'lithium', name: 'Lithium' },
                                  { id: 'ferrite-core', name: 'FerriteCore' },
                                  { id: 'simple-voice-chat', name: 'Voice Chat' },
                                  { id: 'chunky', name: 'Chunky' },
                                  { id: 'spark', name: 'Spark' },
                                ]
                              : [
                                  { id: 'viaversion', name: 'ViaVersion' },
                                  { id: 'geysermc', name: 'Geyser' },
                                  { id: 'floodgate', name: 'Floodgate' },
                                  { id: 'chunky', name: 'Chunky' },
                                  { id: 'luckperms', name: 'LuckPerms' },
                                  { id: 'spark', name: 'Spark' },
                                ]
                            ).map((preset) => {
                              const isSelected = currentProjectsList.includes(preset.id);
                              return (
                                <button
                                  key={preset.id}
                                  type="button"
                                  onClick={() => toggleModPreset(preset.id)}
                                  className={`px-2 py-0.5 rounded text-[11px] font-mono border transition-all cursor-pointer ${
                                    isSelected
                                      ? 'bg-primary text-primary-foreground border-primary font-bold shadow-sm'
                                      : 'bg-card border-border/60 text-muted-foreground hover:text-foreground hover:border-primary/40'
                                  }`}
                                >
                                  {isSelected ? '✓ ' : '+ '}
                                  {preset.name}
                                </button>
                              );
                            })}
                          </div>
                        </div>

                        {/* MODRINTH_PROJECTS */}
                        <div>
                          <label className="block text-xs font-semibold text-foreground mb-1">
                            Modrinth Slugs / IDs{' '}
                            <span className="text-[10px] text-muted-foreground font-mono">(MODRINTH_PROJECTS)</span>
                          </label>
                          <input
                            type="text"
                            placeholder={
                              isModLoader
                                ? 'e.g. fabric-api, lithium, ferrite-core'
                                : 'e.g. viaversion, geysermc, chunky'
                            }
                            value={envValues['MODRINTH_PROJECTS'] ?? ''}
                            onChange={(e) =>
                              setEnvValues({ ...envValues, MODRINTH_PROJECTS: e.target.value })
                            }
                            className="input w-full text-xs font-mono"
                          />
                          <p className="text-[10px] text-muted-foreground mt-0.5">
                            Placed into{' '}
                            <code className="text-primary font-mono">
                              {isPluginLoader ? '/data/plugins' : '/data/mods'}
                            </code>{' '}
                            during container bootstrap
                          </p>
                        </div>

                        {/* MODRINTH_MODPACK (Mod loaders only) */}
                        {isModLoader && (
                          <div>
                            <label className="block text-xs font-semibold text-foreground mb-1">
                              Or Modpack Slug / URL{' '}
                              <span className="text-[10px] text-muted-foreground font-mono">(MODRINTH_MODPACK)</span>
                            </label>
                            <input
                              type="text"
                              placeholder="e.g. fabulously-optimized or https://cdn.modrinth.com/...mrpack"
                              value={envValues['MODRINTH_MODPACK'] ?? ''}
                              onChange={(e) =>
                                setEnvValues({ ...envValues, MODRINTH_MODPACK: e.target.value })
                              }
                              className="input w-full text-xs font-mono"
                            />
                          </div>
                        )}
                      </div>
                    )}
                  </>
                );
              })()}
            </div>

            <div className="pt-4 flex gap-3">
              <button
                type="button"
                onClick={() => setStep(1)}
                className="btn btn-secondary flex-1 py-2 font-medium"
              >
                ← Back
              </button>
              <button
                type="button"
                onClick={handleStartDeploy}
                disabled={loading || !serverName}
                className="btn btn-primary flex-[2] py-2 font-bold"
              >
                Deploy Server Now 🚀
              </button>
            </div>
          </div>
        )}

        {/* Step 3: Deployment Progress */}
        {step === 3 && (
          <div className="flex-1 overflow-y-auto space-y-3 py-2 pr-1">
            <div className="space-y-2">
              {deployEvents.map((item) => (
                <div
                  key={item.step}
                  className={`p-3 rounded-lg border text-xs flex items-center justify-between transition-all duration-300 ${
                    item.status === 'completed'
                      ? 'bg-emerald-950/20 border-emerald-500/30 text-emerald-300'
                      : item.status === 'running'
                        ? 'bg-primary/10 border-primary text-primary animate-pulse'
                        : item.status === 'failed'
                          ? 'bg-destructive/20 border-destructive text-destructive'
                          : 'bg-muted/20 border-border/40 text-muted-foreground opacity-60'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <span className="font-mono font-bold w-4">{item.step}.</span>
                    <span>{item.message}</span>
                  </div>
                  <div>
                    {item.status === 'completed' && <span>✓</span>}
                    {item.status === 'running' && (
                      <span className="animate-spin inline-block">⟳</span>
                    )}
                    {item.status === 'failed' && <span>✗</span>}
                  </div>
                </div>
              ))}
            </div>

            <div className="pt-4 border-t border-border mt-4 flex items-center justify-between text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <span className="inline-block animate-spin text-primary">⟳</span>
                <span>Deploying server in background...</span>
              </span>
              <button
                type="button"
                onClick={() => {
                  addToast({ type: 'info', title: 'Deployment continuing in background.' });
                  onClose();
                }}
                className="btn btn-secondary btn-sm text-xs py-1 px-3"
              >
                Continue in Background
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
