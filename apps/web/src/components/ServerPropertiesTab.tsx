import { useState, useEffect, useMemo } from 'react';
import {
  api,
  type ServerDetail,
  type ServerPropertyItem,
  type PropertyCategory,
  type ApiError,
} from '../api/client';
import { useToast } from './Toast';

interface ServerPropertiesTabProps {
  server: ServerDetail;
  onRestartServer: () => void;
}

const CATEGORIES: Array<{ id: PropertyCategory | 'all'; label: string; icon: string }> = [
  { id: 'all', label: 'All Properties', icon: '📋' },
  { id: 'gameplay', label: 'Gameplay', icon: '🎮' },
  { id: 'security', label: 'Security & Auth', icon: '🛡️' },
  { id: 'world', label: 'World & Spawn', icon: '🌍' },
  { id: 'performance', label: 'Performance', icon: '⚡' },
  { id: 'network', label: 'Network & MOTD', icon: '🌐' },
  { id: 'custom', label: 'Custom / Other', icon: '🔧' },
];

export function ServerPropertiesTab({ server, onRestartServer }: ServerPropertiesTabProps) {
  const [properties, setProperties] = useState<ServerPropertyItem[]>([]);
  const [editedValues, setEditedValues] = useState<Record<string, string>>({});
  const [savedKeys, setSavedKeys] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [savingBatch, setSavingBatch] = useState(false);
  const [hasPendingRestart, setHasPendingRestart] = useState(false);
  const [activeCategory, setActiveCategory] = useState<PropertyCategory | 'all'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [onlyModified, setOnlyModified] = useState(false);

  // Raw mode state
  const [rawMode, setRawMode] = useState(false);
  const [rawText, setRawText] = useState('');

  // Add custom property modal
  const [showAddModal, setShowAddModal] = useState(false);
  const [customKey, setCustomKey] = useState('');
  const [customValue, setCustomValue] = useState('');

  // World spawn point manager state
  const [spawnX, setSpawnX] = useState<number>(0);
  const [spawnY, setSpawnY] = useState<number>(64);
  const [spawnZ, setSpawnZ] = useState<number>(0);
  const [spawnAngle, setSpawnAngle] = useState<number | undefined>(undefined);
  const [spawnProtectionVal, setSpawnProtectionVal] = useState<number>(16);
  const [settingSpawn, setSettingSpawn] = useState(false);
  const [spawnFeedback, setSpawnFeedback] = useState<string | null>(null);

  const { addToast } = useToast();

  const fetchProperties = async () => {
    setLoading(true);
    try {
      const res = await api.getServerProperties(server.id);
      setProperties(res.properties);
      setRawText(res.rawContent);

      const initialMap: Record<string, string> = {};
      for (const p of res.properties) {
        initialMap[p.key] = p.value;
      }
      setEditedValues(initialMap);

      // Initialize spawn protection value
      const prot = res.properties.find((p) => p.key === 'spawn-protection');
      if (prot && !isNaN(Number(prot.value))) {
        setSpawnProtectionVal(Number(prot.value));
      }
    } catch (err) {
      const error = err as ApiError;
      addToast({ type: 'error', title: 'Failed to load properties', message: error.message });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProperties();
  }, [server.id]);

  const handleValueChange = (key: string, val: string) => {
    setEditedValues((prev) => ({ ...prev, [key]: val }));
    setSavedKeys((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  };

  const handleSaveOne = async (key: string) => {
    const value = editedValues[key];
    if (value === undefined) return;

    setSavingKey(key);
    try {
      const res = await api.updateServerProperty(server.id, key, value);
      if (res.requiresRestart) {
        setHasPendingRestart(true);
      }
      setSavedKeys((prev) => new Set(prev).add(key));

      // Update in property list
      setProperties((prev) =>
        prev.map((item) => {
          if (item.key === key) {
            return {
              ...item,
              value,
              isModified: value !== item.defaultValue,
            };
          }
          return item;
        }),
      );

      addToast({
        type: 'success',
        title: 'Property Saved',
        message: `${key} updated to ${value.length > 30 ? value.substring(0, 30) + '...' : value}`,
      });

      // Clear saved highlight after 3 seconds
      setTimeout(() => {
        setSavedKeys((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }, 3000);
    } catch (err) {
      const error = err as ApiError;
      addToast({ type: 'error', title: `Failed to save ${key}`, message: error.message });
    } finally {
      setSavingKey(null);
    }
  };

  const handleResetToDefault = (key: string, defVal: string) => {
    handleValueChange(key, defVal);
  };

  const handleAddCustomProperty = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanKey = customKey.trim().toLowerCase().replace(/\s+/g, '-');
    if (!cleanKey) return;

    try {
      await api.updateServerProperty(server.id, cleanKey, customValue.trim());
      addToast({ type: 'success', title: 'Custom Property Added', message: `${cleanKey}=${customValue}` });
      setShowAddModal(false);
      setCustomKey('');
      setCustomValue('');
      await fetchProperties();
    } catch (err) {
      const error = err as ApiError;
      addToast({ type: 'error', title: 'Failed to add property', message: error.message });
    }
  };

  const handleSaveRaw = async () => {
    setSavingBatch(true);
    try {
      const res = await api.updateServerProperties(server.id, { rawContent: rawText });
      if (res.requiresRestart) {
        setHasPendingRestart(true);
      }
      addToast({ type: 'success', title: 'Raw server.properties saved successfully.' });
      await fetchProperties();
    } catch (err) {
      const error = err as ApiError;
      addToast({ type: 'error', title: 'Failed to save server.properties', message: error.message });
    } finally {
      setSavingBatch(false);
    }
  };

  const handleSetWorldSpawn = async () => {
    setSettingSpawn(true);
    setSpawnFeedback(null);
    try {
      const res = await api.setServerSpawnPoint(server.id, {
        x: spawnX,
        y: spawnY,
        z: spawnZ,
        angle: spawnAngle,
        spawnProtection: spawnProtectionVal,
      });

      setSpawnFeedback(res.message);
      addToast({
        type: 'success',
        title: 'World Spawn Configured',
        message: res.message,
      });

      // Update spawn protection in property map
      handleValueChange('spawn-protection', String(spawnProtectionVal));
      setProperties((prev) =>
        prev.map((p) => (p.key === 'spawn-protection' ? { ...p, value: String(spawnProtectionVal) } : p)),
      );
    } catch (err) {
      const error = err as ApiError;
      addToast({ type: 'error', title: 'Could not set world spawn', message: error.message });
    } finally {
      setSettingSpawn(false);
    }
  };

  // Filter properties
  const filteredProperties = useMemo(() => {
    return properties.filter((p) => {
      // Category filter
      if (activeCategory !== 'all' && p.category !== activeCategory) {
        return false;
      }

      // Modified filter
      if (onlyModified) {
        const curVal = editedValues[p.key] ?? p.value;
        if (curVal === p.defaultValue) return false;
      }

      // Search query
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const matchKey = p.key.toLowerCase().includes(q);
        const matchLabel = p.label.toLowerCase().includes(q);
        const matchDesc = p.description.toLowerCase().includes(q);
        const matchVal = (editedValues[p.key] ?? p.value).toLowerCase().includes(q);
        return matchKey || matchLabel || matchDesc || matchVal;
      }

      return true;
    });
  }, [properties, activeCategory, onlyModified, searchQuery, editedValues]);

  const modifiedCount = useMemo(() => {
    return properties.filter((p) => {
      const curVal = editedValues[p.key] ?? p.value;
      return curVal !== p.defaultValue;
    }).length;
  }, [properties, editedValues]);

  if (loading) {
    return (
      <div className="flex items-center justify-center p-16">
        <div className="text-center">
          <div className="inline-block animate-spin text-3xl text-primary mb-3">⟳</div>
          <p className="text-xs text-muted-foreground font-medium">Loading server.properties...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Restart Notice Banner */}
      {hasPendingRestart && (
        <div className="card p-4 border border-amber-500/50 bg-amber-500/10 flex flex-col sm:flex-row items-center justify-between gap-3 shadow-lg">
          <div className="flex items-center gap-3">
            <span className="text-2xl">⚠️</span>
            <div>
              <h4 className="font-bold text-sm text-foreground">Restart Required to Apply Changes</h4>
              <p className="text-xs text-muted-foreground">
                Minecraft reads <code>server.properties</code> on startup. Restart the server now to activate updated rules.
              </p>
            </div>
          </div>
          <button
            onClick={() => {
              setHasPendingRestart(false);
              onRestartServer();
            }}
            className="btn btn-primary text-xs py-2 px-4 shrink-0 font-bold flex items-center gap-1.5 shadow glow-primary"
          >
            <span>🔄</span> Restart Server Now
          </button>
        </div>
      )}

      {/* Header & Controls Strip */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-border pb-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-bold text-foreground">Server Properties</h2>
            <span className="badge badge-primary text-[10px] font-mono py-0.5 px-2">server.properties</span>
            {modifiedCount > 0 && (
              <span className="badge badge-warning text-[10px] py-0.5 px-2">
                {modifiedCount} modified
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Fine-tune game rules, Mojang auth, spawn boundaries, view distances, and performance settings one by one.
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setRawMode(!rawMode)}
            className={`btn btn-sm text-xs font-semibold ${rawMode ? 'btn-primary' : 'btn-secondary'}`}
            title="Toggle between friendly cards and raw text editor"
          >
            {rawMode ? '📋 Switch to Card View' : '📝 Raw .properties Editor'}
          </button>
          {!rawMode && (
            <button
              onClick={() => setShowAddModal(true)}
              className="btn btn-secondary btn-sm text-xs font-semibold flex items-center gap-1.5"
            >
              <span>➕</span> Add Property
            </button>
          )}
        </div>
      </div>

      {rawMode ? (
        /* Raw Editor Mode */
        <div className="card p-5 border border-border/80 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-bold text-sm text-foreground">Raw server.properties File</h3>
              <p className="text-xs text-muted-foreground">
                Edit the configuration directly in standard Java properties format (key=value).
              </p>
            </div>
            <button
              onClick={handleSaveRaw}
              disabled={savingBatch}
              className="btn btn-primary btn-sm text-xs px-4 font-bold flex items-center gap-1.5 shadow glow-primary"
            >
              {savingBatch ? <span className="animate-spin">⟳</span> : <span>💾</span>}
              Save All Changes
            </button>
          </div>
          <textarea
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
            rows={22}
            className="w-full bg-black/90 text-emerald-400 font-mono text-xs p-4 rounded-lg border border-border focus:outline-none focus:border-primary resize-y leading-relaxed"
            placeholder="# Minecraft server properties..."
          />
        </div>
      ) : (
        /* Friendly Card Mode */
        <div className="space-y-6">
          {/* Search & Category Filter Strip */}
          <div className="space-y-3">
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="relative flex-1">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-xs">🔍</span>
                <input
                  type="text"
                  placeholder="Search properties (e.g. online-mode, spawn, pvp, difficulty, motd)..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="input pl-8 pr-8 text-xs w-full font-mono"
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery('')}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground text-xs"
                  >
                    ✕
                  </button>
                )}
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => setOnlyModified(!onlyModified)}
                  className={`btn btn-sm text-xs font-semibold flex items-center gap-1.5 ${
                    onlyModified
                      ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                      : 'btn-secondary text-muted-foreground'
                  }`}
                >
                  <span>{onlyModified ? '✓' : '○'}</span>
                  <span>Only Modified</span>
                </button>
              </div>
            </div>

            {/* Category Pills */}
            <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-thin">
              {CATEGORIES.map((cat) => {
                const count =
                  cat.id === 'all'
                    ? properties.length
                    : properties.filter((p) => p.category === cat.id).length;
                return (
                  <button
                    key={cat.id}
                    onClick={() => setActiveCategory(cat.id)}
                    className={`py-1.5 px-3 rounded-full text-xs font-medium whitespace-nowrap transition-all flex items-center gap-1.5 cursor-pointer border ${
                      activeCategory === cat.id
                        ? 'bg-primary text-primary-foreground border-primary shadow-sm'
                        : 'bg-card border-border/70 text-muted-foreground hover:text-foreground hover:bg-card-subtle'
                    }`}
                  >
                    <span>{cat.icon}</span>
                    <span>{cat.label}</span>
                    <span className="text-[10px] opacity-70">({count})</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* World Spawn Point Manager Box (Featured on 'world' or 'all' or when searching spawn) */}
          {(activeCategory === 'world' || activeCategory === 'all' || searchQuery.toLowerCase().includes('spawn')) && (
            <div className="card p-5 border border-primary/40 bg-gradient-to-r from-primary/10 via-primary/5 to-transparent relative overflow-hidden shadow-md">
              <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 mb-4">
                <div className="flex items-start gap-3">
                  <span className="text-3xl p-2 bg-primary/20 rounded-xl">📍</span>
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="font-bold text-sm text-foreground">World Spawn Point & Protection Zone</h3>
                      <span className="badge badge-primary text-[10px] py-0 px-1.5">Live Command & Config</span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Configure spawn coordinates (X, Y, Z) and protection perimeter. Updates <code>spawn-protection</code> and runs <code>/setworldspawn</code> live if server is running.
                    </p>
                  </div>
                </div>

                {/* Quick Presets */}
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[11px] text-muted-foreground">Presets:</span>
                  <button
                    type="button"
                    onClick={() => {
                      setSpawnX(0);
                      setSpawnY(64);
                      setSpawnZ(0);
                    }}
                    className="btn btn-secondary text-[11px] py-1 px-2 font-mono"
                  >
                    (0, 64, 0)
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setSpawnX(100);
                      setSpawnY(70);
                      setSpawnZ(100);
                    }}
                    className="btn btn-secondary text-[11px] py-1 px-2 font-mono"
                  >
                    (100, 70, 100)
                  </button>
                </div>
              </div>

              {/* Coordinates Inputs Row */}
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-3 bg-black/30 p-3.5 rounded-lg border border-border/50 text-xs">
                <div>
                  <label className="text-[11px] font-semibold text-muted-foreground block mb-1">X Coordinate</label>
                  <input
                    type="number"
                    value={spawnX}
                    onChange={(e) => setSpawnX(Number(e.target.value))}
                    className="input font-mono text-xs w-full py-1.5"
                    placeholder="0"
                  />
                </div>
                <div>
                  <label className="text-[11px] font-semibold text-muted-foreground block mb-1">Y Coordinate (Height)</label>
                  <input
                    type="number"
                    value={spawnY}
                    onChange={(e) => setSpawnY(Number(e.target.value))}
                    className="input font-mono text-xs w-full py-1.5"
                    placeholder="64"
                  />
                </div>
                <div>
                  <label className="text-[11px] font-semibold text-muted-foreground block mb-1">Z Coordinate</label>
                  <input
                    type="number"
                    value={spawnZ}
                    onChange={(e) => setSpawnZ(Number(e.target.value))}
                    className="input font-mono text-xs w-full py-1.5"
                    placeholder="0"
                  />
                </div>
                <div>
                  <label className="text-[11px] font-semibold text-muted-foreground block mb-1">Angle (Optional °)</label>
                  <input
                    type="number"
                    value={spawnAngle ?? ''}
                    onChange={(e) => setSpawnAngle(e.target.value === '' ? undefined : Number(e.target.value))}
                    className="input font-mono text-xs w-full py-1.5"
                    placeholder="0-360"
                  />
                </div>
                <div className="col-span-2 sm:col-span-4 lg:col-span-1">
                  <label className="text-[11px] font-semibold text-muted-foreground block mb-1">
                    Protection Radius (blocks)
                  </label>
                  <input
                    type="number"
                    min="0"
                    max="10000"
                    value={spawnProtectionVal}
                    onChange={(e) => setSpawnProtectionVal(Math.max(0, Number(e.target.value)))}
                    className="input font-mono text-xs w-full py-1.5"
                    placeholder="16"
                  />
                </div>
              </div>

              <div className="flex flex-col sm:flex-row items-center justify-between gap-3 mt-3.5">
                <div className="text-xs text-muted-foreground">
                  {spawnProtectionVal === 0 ? (
                    <span className="text-amber-400 font-medium">⚠️ Spawn protection disabled (0 blocks). Any player can build at spawn.</span>
                  ) : (
                    <span>
                      Protected box extends <strong className="text-foreground">{spawnProtectionVal} blocks</strong> in every direction from ({spawnX}, {spawnZ}).
                    </span>
                  )}
                </div>

                <button
                  type="button"
                  onClick={handleSetWorldSpawn}
                  disabled={settingSpawn}
                  className="btn btn-primary text-xs py-2 px-4 font-bold flex items-center gap-1.5 shadow glow-primary shrink-0"
                >
                  {settingSpawn ? <span className="animate-spin">⟳</span> : <span>📌</span>}
                  Save & Apply World Spawn
                </button>
              </div>

              {spawnFeedback && (
                <div className="mt-3 p-2.5 rounded bg-emerald-950/40 border border-emerald-500/40 text-xs text-emerald-300 font-mono flex items-center gap-2">
                  <span>✓</span>
                  <span>{spawnFeedback}</span>
                </div>
              )}
            </div>
          )}

          {/* Properties Grid: Editing One by One */}
          {filteredProperties.length === 0 ? (
            <div className="card p-12 text-center border border-border/60">
              <span className="text-2xl mb-2 block">🔍</span>
              <h4 className="font-bold text-sm text-foreground">No matching server properties found</h4>
              <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">
                Try searching with different terms or reset your filters.
              </p>
              <button
                onClick={() => {
                  setSearchQuery('');
                  setActiveCategory('all');
                  setOnlyModified(false);
                }}
                className="btn btn-secondary text-xs mt-3 py-1.5 px-3"
              >
                Reset Filters
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {filteredProperties.map((p) => {
                const currentValue = editedValues[p.key] ?? p.value;
                const isSaved = savedKeys.has(p.key);
                const isDifferentFromSaved = currentValue !== p.value;
                const isDifferentFromDefault = currentValue !== p.defaultValue;
                const isCurrentlySaving = savingKey === p.key;

                return (
                  <div
                    key={p.key}
                    className={`card p-4 border transition-all ${
                      isSaved
                        ? 'border-emerald-500/60 bg-emerald-950/15 shadow-sm'
                        : isDifferentFromSaved
                          ? 'border-primary/50 bg-primary/5'
                          : 'border-border/70 hover:border-border'
                    }`}
                  >
                    <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                      {/* Left: Property Info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                          <h4 className="font-bold text-sm text-foreground">{p.label}</h4>
                          <span className="font-mono text-[11px] text-muted-foreground bg-black/40 px-2 py-0.5 rounded border border-border/40">
                            {p.key}
                          </span>
                          <span className="badge badge-neutral text-[10px] uppercase font-bold py-0 px-1.5 text-zinc-400">
                            {p.category}
                          </span>
                          {isDifferentFromDefault && (
                            <span className="badge badge-warning text-[10px] py-0 px-1.5 font-bold">
                              Modified
                            </span>
                          )}
                          {isSaved && (
                            <span className="badge badge-success text-[10px] py-0 px-1.5 font-bold animate-pulse">
                              Saved ✓
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground leading-relaxed">{p.description}</p>
                        {p.defaultValue && (
                          <div className="text-[10px] text-muted-foreground mt-1 font-mono">
                            Default: <span className="text-zinc-400">{p.defaultValue}</span>
                          </div>
                        )}
                      </div>

                      {/* Right: Interactive Input & Save Button */}
                      <div className="flex items-center gap-2.5 shrink-0 self-start lg:self-center">
                        {/* Control based on type */}
                        {p.type === 'boolean' ? (
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                const nextVal = currentValue === 'true' ? 'false' : 'true';
                                handleValueChange(p.key, nextVal);
                              }}
                              className={`relative inline-flex h-6 w-12 items-center rounded-full transition-colors cursor-pointer border ${
                                currentValue === 'true'
                                  ? 'bg-emerald-600 border-emerald-500'
                                  : 'bg-zinc-800 border-zinc-700'
                              }`}
                              title={`Toggle ${p.key}`}
                            >
                              <span
                                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                                  currentValue === 'true' ? 'translate-x-7' : 'translate-x-1'
                                }`}
                              />
                            </button>
                            <span className={`text-xs font-mono font-bold w-12 ${currentValue === 'true' ? 'text-emerald-400' : 'text-zinc-400'}`}>
                              {currentValue === 'true' ? 'ON' : 'OFF'}
                            </span>
                          </div>
                        ) : p.type === 'select' && p.options ? (
                          <select
                            value={currentValue}
                            onChange={(e) => handleValueChange(p.key, e.target.value)}
                            className="input text-xs py-1 px-3 bg-black/60 font-semibold text-foreground min-w-[150px]"
                          >
                            {p.options.map((opt) => (
                              <option key={opt.value} value={opt.value}>
                                {opt.label}
                              </option>
                            ))}
                          </select>
                        ) : p.type === 'number' ? (
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => {
                                const num = Number(currentValue) || 0;
                                handleValueChange(p.key, String(Math.max(0, num - 1)));
                              }}
                              className="btn btn-secondary text-xs px-2 py-1 font-bold"
                              title="Decrease"
                            >
                              -
                            </button>
                            <input
                              type="number"
                              value={currentValue}
                              onChange={(e) => handleValueChange(p.key, e.target.value)}
                              className="input text-xs py-1 px-2.5 font-mono text-center w-24"
                            />
                            <button
                              type="button"
                              onClick={() => {
                                const num = Number(currentValue) || 0;
                                handleValueChange(p.key, String(num + 1));
                              }}
                              className="btn btn-secondary text-xs px-2 py-1 font-bold"
                              title="Increase"
                            >
                              +
                            </button>
                          </div>
                        ) : (
                          <input
                            type={p.isSecret ? 'password' : 'text'}
                            value={currentValue}
                            onChange={(e) => handleValueChange(p.key, e.target.value)}
                            className="input text-xs py-1 px-3 font-mono min-w-[180px] max-w-[280px]"
                            placeholder={`Enter ${p.key}...`}
                          />
                        )}

                        {/* Reset to Default Button */}
                        {p.defaultValue && currentValue !== p.defaultValue && (
                          <button
                            type="button"
                            onClick={() => handleResetToDefault(p.key, p.defaultValue)}
                            className="btn btn-secondary text-[11px] py-1 px-2 text-muted-foreground hover:text-foreground"
                            title="Reset to default value"
                          >
                            ↺ Reset
                          </button>
                        )}

                        {/* Individual Save Button */}
                        <button
                          type="button"
                          onClick={() => handleSaveOne(p.key)}
                          disabled={isCurrentlySaving || !isDifferentFromSaved}
                          className={`btn btn-sm text-xs py-1 px-3.5 font-bold transition-all flex items-center gap-1 ${
                            isDifferentFromSaved
                              ? 'btn-primary shadow glow-primary animate-pulse'
                              : isSaved
                                ? 'bg-emerald-600/20 text-emerald-300 border border-emerald-500/40'
                                : 'btn-secondary text-muted-foreground opacity-60'
                          }`}
                        >
                          {isCurrentlySaving ? (
                            <span className="inline-block animate-spin text-xs">⟳</span>
                          ) : isSaved ? (
                            <span>✓</span>
                          ) : (
                            <span>💾</span>
                          )}
                          <span>{isSaved ? 'Saved' : 'Save'}</span>
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Add Custom Property Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-fade-in">
          <div className="card p-6 border border-border/80 max-w-md w-full space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-border pb-3">
              <h3 className="font-bold text-base text-foreground flex items-center gap-2">
                <span>➕</span> Add Custom Server Property
              </h3>
              <button
                onClick={() => setShowAddModal(false)}
                className="text-muted-foreground hover:text-foreground text-sm"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleAddCustomProperty} className="space-y-4">
              <div>
                <label className="text-xs font-semibold text-foreground block mb-1">
                  Property Key <span className="text-destructive">*</span>
                </label>
                <input
                  type="text"
                  required
                  pattern="^[a-zA-Z0-9_.-]+$"
                  placeholder="e.g. view-distance, level-seed, my-custom-plugin-key"
                  value={customKey}
                  onChange={(e) => setCustomKey(e.target.value)}
                  className="input text-xs w-full font-mono"
                />
                <p className="text-[10px] text-muted-foreground mt-1">
                  Alphanumeric characters, dashes, and dots only.
                </p>
              </div>

              <div>
                <label className="text-xs font-semibold text-foreground block mb-1">
                  Value <span className="text-destructive">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. 12, true, survival, custom string"
                  value={customValue}
                  onChange={(e) => setCustomValue(e.target.value)}
                  className="input text-xs w-full font-mono"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-border">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="btn btn-secondary text-xs py-2 px-4"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary text-xs py-2 px-4 font-bold"
                >
                  Add Property
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

