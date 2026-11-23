import { useState, useEffect } from 'react';
import { api, type ServerDetail, type InstalledMod, type InstalledModpackInfo } from '../api/client';
import { useToast } from './Toast';

interface ServerModsTabProps {
  server: ServerDetail;
  onRestartServer?: () => void;
}

interface ModrinthHit {
  project_id: string;
  project_type?: 'mod' | 'modpack' | 'plugin';
  slug: string;
  title: string;
  description: string;
  author: string;
  icon_url: string | null;
  downloads: number;
  categories: string[];
}

interface ModrinthSearchResponse {
  hits: ModrinthHit[];
  total_hits: number;
}

interface ModrinthVersionFile {
  url: string;
  filename: string;
  primary: boolean;
  size: number;
}

interface ModrinthDependency {
  version_id: string | null;
  project_id: string | null;
  file_name?: string | null;
  dependency_type: 'required' | 'optional' | 'incompatible' | 'embedded';
}

interface ModrinthVersion {
  id: string;
  name: string;
  version_type?: string;
  game_versions: string[];
  loaders: string[];
  files: ModrinthVersionFile[];
  dependencies?: ModrinthDependency[];
}

export function ServerModsTab({ server, onRestartServer }: ServerModsTabProps) {
  const [subtab, setSubtab] = useState<'installed' | 'browse'>('browse');
  const [installedMods, setInstalledMods] = useState<InstalledMod[]>([]);
  const [installedModpack, setInstalledModpack] = useState<InstalledModpackInfo | null>(null);
  const [addonsFolder, setAddonsFolder] = useState<'mods' | 'plugins'>('mods');
  const [runningGameVersion, setRunningGameVersion] = useState<string | null>(null);
  const [loadingInstalled, setLoadingInstalled] = useState(false);

  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [projectTypeFilter, setProjectTypeFilter] = useState<'all' | 'mod' | 'modpack'>('all');
  const [searchResults, setSearchResults] = useState<ModrinthHit[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [installingId, setInstallingId] = useState<string | null>(null);

  // Upload state
  const [isUploading, setIsUploading] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);

  const { addToast } = useToast();

  const loader = (server.serverType || 'fabric').toLowerCase();
  const activeGameVersion =
    runningGameVersion ||
    (server.version && server.version !== 'LATEST' ? server.version.replace(/^v/, '') : null);

  const getLoaderFacet = () => {
    if (loader.includes('forge') && !loader.includes('neo')) return 'forge';
    if (loader.includes('neo')) return 'neoforge';
    if (loader.includes('quilt')) return 'quilt';
    if (loader.includes('paper') || loader.includes('purpur') || loader.includes('spigot')) return 'spigot';
    return 'fabric';
  };

  const loadInstalled = async () => {
    setLoadingInstalled(true);
    try {
      const res = await api.listServerMods(server.id);
      setInstalledMods(res.mods);
      setInstalledModpack(res.modpack ?? null);
      setAddonsFolder(res.folder === 'plugins' ? 'plugins' : 'mods');
      if (res.detectedGameVersion) {
        setRunningGameVersion(res.detectedGameVersion);
      }
    } catch {
      // not available or error
    } finally {
      setLoadingInstalled(false);
    }
  };

  useEffect(() => {
    loadInstalled();
  }, [server.id]);

  // Search Modrinth API with exact loader, version, and type filtering
  const searchModrinth = async (query = searchQuery) => {
    setIsSearching(true);
    try {
      const loaderFacet = getLoaderFacet();
      const url = new URL('https://api.modrinth.com/v2/search');
      url.searchParams.set('query', query);
      url.searchParams.set('limit', '12');

      const facets: string[][] = [[`categories:${loaderFacet}`]];
      if (activeGameVersion) {
        facets.push([`versions:${activeGameVersion}`]);
      }
      if (projectTypeFilter !== 'all') {
        facets.push([`project_type:${projectTypeFilter}`]);
      }
      url.searchParams.set('facets', JSON.stringify(facets));

      const res = await fetch(url.toString(), {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'VaultRealm-Panel/0.5 (https://vaultsoftlabs.tech)',
        },
      });

      if (!res.ok) throw new Error(`Modrinth returned ${res.status}`);
      const data = (await res.json()) as ModrinthSearchResponse;
      setSearchResults(data.hits || []);
    } catch (err) {
      console.warn('Modrinth search failed, falling back without version constraint', err);
      // Fallback search without strict version facet
      try {
        const loaderFacet = getLoaderFacet();
        const fallbackFacets: string[][] = [[`categories:${loaderFacet}`]];
        if (projectTypeFilter !== 'all') {
          fallbackFacets.push([`project_type:${projectTypeFilter}`]);
        }
        const fallbackUrl = `https://api.modrinth.com/v2/search?query=${encodeURIComponent(query)}&limit=12&facets=${encodeURIComponent(JSON.stringify(fallbackFacets))}`;
        const res = await fetch(fallbackUrl);
        const data = (await res.json()) as ModrinthSearchResponse;
        setSearchResults(data.hits || []);
      } catch {
        setSearchResults([]);
      }
    } finally {
      setIsSearching(false);
    }
  };

  useEffect(() => {
    if (subtab === 'browse') {
      searchModrinth(searchQuery);
    }
  }, [subtab, projectTypeFilter]);

  // Install a mod directly from Modrinth with compatible version check and dependency resolution
  const handleInstallMod = async (hit: ModrinthHit) => {
    setInstallingId(hit.project_id);
    try {
      const loaderFacet = getLoaderFacet();

      // 1. Fetch available versions for this project matching loader & active game version
      const params = new URLSearchParams();
      params.set('loaders', JSON.stringify([loaderFacet]));
      if (activeGameVersion) {
        params.set('game_versions', JSON.stringify([activeGameVersion]));
      }

      const vRes = await fetch(
        `https://api.modrinth.com/v2/project/${hit.project_id}/version?${params.toString()}`,
        {
          headers: {
            'User-Agent': 'VaultRealm-Panel/0.5 (https://vaultsoftlabs.tech)',
          },
        },
      );
      let versions: ModrinthVersion[] = vRes.ok ? await vRes.json() : [];

      // If strict game_versions returned empty, fallback to loader-only and find best match
      if (!versions || versions.length === 0) {
        const fallbackRes = await fetch(
          `https://api.modrinth.com/v2/project/${hit.project_id}/version?loaders=["${loaderFacet}"]`,
          {
            headers: {
              'User-Agent': 'VaultRealm-Panel/0.5 (https://vaultsoftlabs.tech)',
            },
          },
        );
        if (fallbackRes.ok) {
          versions = await fallbackRes.json();
        }
      }

      if (!versions || versions.length === 0) {
        throw new Error(`No compatible versions found for ${loaderFacet} on Modrinth.`);
      }

      // 2. Pick best matching version
      let matchedVersion: ModrinthVersion | null = null;
      if (activeGameVersion) {
        matchedVersion =
          versions.find(
            (v) => v.game_versions.includes(activeGameVersion) && v.version_type === 'release',
          ) ||
          versions.find((v) => v.game_versions.includes(activeGameVersion)) ||
          versions.find((v) =>
            v.game_versions.some(
              (gv) => gv.startsWith(activeGameVersion) || activeGameVersion.startsWith(gv),
            ),
          ) ||
          null;
      }

      if (!matchedVersion) {
        matchedVersion = versions.find((v) => v.version_type === 'release') || versions[0];
      }

      const primaryFile = matchedVersion?.files?.find((f) => f.primary) || matchedVersion?.files?.[0];
      if (!primaryFile) {
        throw new Error('No download file found for this mod version.');
      }

      // 3. Auto-install required dependencies
      const requiredDeps = (matchedVersion?.dependencies || []).filter(
        (d) => d.dependency_type === 'required' && (d.project_id || d.version_id),
      );

      const installedDepsList: string[] = [];

      for (const dep of requiredDeps) {
        if (dep.project_id) {
          // Check if already installed
          const isDepInstalled = installedMods.some((m) =>
            m.filename.toLowerCase().includes(dep.project_id!.toLowerCase()),
          );
          if (isDepInstalled) continue;

          try {
            const depParams = new URLSearchParams();
            depParams.set('loaders', JSON.stringify([loaderFacet]));
            if (activeGameVersion) {
              depParams.set('game_versions', JSON.stringify([activeGameVersion]));
            }
            const depRes = await fetch(
              `https://api.modrinth.com/v2/project/${dep.project_id}/version?${depParams.toString()}`,
              { headers: { 'User-Agent': 'VaultRealm-Panel/0.5 (https://vaultsoftlabs.tech)' } },
            );
            if (depRes.ok) {
              const depVersions = (await depRes.json()) as ModrinthVersion[];
              const depMatch =
                (activeGameVersion
                  ? depVersions.find(
                      (v) =>
                        v.game_versions.includes(activeGameVersion) &&
                        v.version_type === 'release',
                    ) || depVersions.find((v) => v.game_versions.includes(activeGameVersion))
                  : null) ||
                depVersions.find((v) => v.version_type === 'release') ||
                depVersions[0];

              const depFile = depMatch?.files?.find((f) => f.primary) || depMatch?.files?.[0];
              if (depFile) {
                await api.installServerMod(server.id, {
                  downloadUrl: depFile.url,
                  filename: depFile.filename,
                  projectId: dep.project_id,
                });
                installedDepsList.push(depFile.filename);
              }
            }
          } catch {
            // best-effort dependency install
          }
        }
      }

      // 4. Request panel backend to safely download .jar or extract .mrpack modpack
      const installRes = await api.installServerMod(server.id, {
        downloadUrl: primaryFile.url,
        filename: primaryFile.filename,
        projectId: hit.slug,
        title: hit.title,
      });

      if (installRes.isMrpack) {
        addToast({
          type: 'success',
          title: `Modpack Installed: ${installRes.modpackName || hit.title}`,
          message: `Installed modpack: ${installRes.installedModsCount ?? 0} server mods downloaded, ${installRes.installedFilesCount ?? 0} config files extracted (${installRes.skippedClientModsCount ?? 0} client mods excluded). Restart server to activate.`,
        });
      } else {
        addToast({
          type: 'success',
          title: `Installed ${hit.title}`,
          message:
            installedDepsList.length > 0
              ? `Installed ${hit.title} and auto-resolved dependencies (${installedDepsList.join(', ')}). Restart server to load.`
              : `Installed into /${addonsFolder} (compatible with MC ${activeGameVersion || 'game'}). Restart server to activate.`,
        });
      }

      await loadInstalled();
    } catch (err) {
      addToast({
        type: 'error',
        title: `Installation failed`,
        message: err instanceof Error ? err.message : 'Could not install mod.',
      });
    } finally {
      setInstallingId(null);
    }
  };

  // Upload mod or modpack file handler
  const processUploadFiles = async (files: FileList | File[]) => {
    setIsUploading(true);
    let uploadedCount = 0;
    let modpacksInstalled = 0;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file) continue;

      const isJar = file.name.endsWith('.jar') || file.name.endsWith('.jar.disabled');
      const isMrpack = file.name.endsWith('.mrpack');

      if (!isJar && !isMrpack) {
        addToast({
          type: 'error',
          title: 'Invalid File',
          message: `${file.name} is not a valid .jar mod or .mrpack modpack file.`,
        });
        continue;
      }

      try {
        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const res = reader.result as string;
            const b64 = res.includes(',') ? res.split(',')[1] : res;
            resolve(b64 || '');
          };
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });

        const uploadRes = await api.uploadServerMod(server.id, {
          filename: file.name,
          contentBase64: base64,
        });

        if (uploadRes.isMrpack) {
          modpacksInstalled++;
          addToast({
            type: 'success',
            title: `Modpack Installed: ${uploadRes.modpackName || file.name}`,
            message: `Extracted modpack: installed ${uploadRes.installedModsCount ?? 0} server mods and ${uploadRes.installedFilesCount ?? 0} config files (${uploadRes.skippedClientModsCount ?? 0} client mods excluded). Restart server to activate.`,
          });
        } else {
          uploadedCount++;
        }
      } catch (err) {
        addToast({
          type: 'error',
          title: `Upload Failed: ${file.name}`,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    setIsUploading(false);
    if (uploadedCount > 0) {
      addToast({
        type: 'success',
        title: 'Upload Successful',
        message: `Uploaded ${uploadedCount} file(s) into /${addonsFolder}. Restart server to apply.`,
      });
    }
    if (uploadedCount > 0 || modpacksInstalled > 0) {
      await loadInstalled();
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      processUploadFiles(e.target.files);
      e.target.value = '';
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files) {
      processUploadFiles(e.dataTransfer.files);
    }
  };

  const handleToggle = async (mod: InstalledMod) => {
    try {
      const res = await api.toggleServerMod(server.id, mod.filename, !mod.enabled);
      addToast({
        type: 'info',
        title: res.enabled ? 'Mod Enabled' : 'Mod Disabled',
        message: `${res.newFilename}. Restart server to apply.`,
      });
      await loadInstalled();
    } catch (err) {
      addToast({
        type: 'error',
        title: 'Failed to toggle mod',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleDelete = async (filename: string) => {
    if (!confirm(`Are you sure you want to delete ${filename}?`)) return;
    try {
      await api.deleteServerMod(server.id, filename);
      addToast({ type: 'success', title: 'Mod removed', message: filename });
      await loadInstalled();
    } catch (err) {
      addToast({
        type: 'error',
        title: 'Delete failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header Strip with Controls */}
      <div className="card p-3.5 sm:p-5 border border-border/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-bold text-base text-foreground flex items-center gap-2">
              <span>🧩</span> {addonsFolder === 'plugins' ? 'Plugins & Extensions' : 'Mods & Addons'}
            </h3>
            <span className="badge badge-info text-[10px] font-mono uppercase">
              ⚡ {server.serverType || 'Standard'}
            </span>
            <span className="badge badge-neutral text-[10px] font-mono text-violet-300 border-violet-500/30 bg-violet-950/30">
              🏷️ {runningGameVersion ? `MC ${runningGameVersion}` : (server.version || 'LATEST')}
            </span>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Browse compatible open-source community mods from{' '}
            <a
              href="https://modrinth.com"
              target="_blank"
              rel="noreferrer"
              className="text-primary hover:underline font-mono"
            >
              Modrinth ↗
            </a>{' '}
            or upload custom <span className="font-mono text-foreground">.jar</span> files directly into <span className="font-mono text-foreground">/{addonsFolder}</span>.
          </p>
        </div>

        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
          {/* Subtabs */}
          <div className="flex bg-card-subtle p-1 rounded-lg border border-border">
            <button
              onClick={() => setSubtab('browse')}
              className={`flex-1 sm:flex-none px-3 py-1.5 text-xs font-semibold rounded-md transition-all ${
                subtab === 'browse'
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              🌐 Browse Modrinth
            </button>
            <button
              onClick={() => {
                setSubtab('installed');
                loadInstalled();
              }}
              className={`flex-1 sm:flex-none px-3 py-1.5 text-xs font-semibold rounded-md transition-all flex items-center justify-center gap-1.5 ${
                subtab === 'installed'
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <span>📂 Installed</span>
              <span className="badge badge-neutral text-[9px] py-0 px-1">
                {installedMods.length}
              </span>
            </button>
          </div>

          {onRestartServer && (
            <button
              onClick={onRestartServer}
              className="btn btn-secondary text-xs py-1.5 px-3 flex items-center justify-center gap-1 text-amber-400 hover:text-amber-300 border-amber-500/30"
              title="Restart server to load new mods"
            >
              🔄 Restart Server
            </button>
          )}
        </div>
      </div>

      {/* ── Subtab 1: Browse Open Source Mods ──────────────────────────────── */}
      {subtab === 'browse' && (
        <div className="space-y-4">
          {/* Search bar & Type Filter */}
          <div className="flex flex-col sm:flex-row gap-2">
            <div className="relative flex-1">
              <input
                type="text"
                placeholder={`Search ${server.serverType || 'Fabric'} ${projectTypeFilter === 'modpack' ? 'modpacks' : 'mods'} for MC ${activeGameVersion || 'game'}...`}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && searchModrinth(searchQuery)}
                className="input w-full text-xs pl-8 font-mono"
              />
              <span className="absolute left-2.5 top-2.5 text-xs text-muted-foreground">🔍</span>
            </div>
            <div className="flex gap-2">
              <select
                value={projectTypeFilter}
                onChange={(e) => setProjectTypeFilter(e.target.value as 'all' | 'mod' | 'modpack')}
                className="input text-xs py-1.5 px-2 font-mono bg-card cursor-pointer border border-border"
              >
                <option value="all">All Addons</option>
                <option value="mod">Mods Only</option>
                <option value="modpack">Modpacks (.mrpack)</option>
              </select>
              <button
                onClick={() => searchModrinth(searchQuery)}
                disabled={isSearching}
                className="btn btn-primary text-xs px-4 font-semibold"
              >
                {isSearching ? 'Searching...' : 'Search'}
              </button>
            </div>
          </div>

          {/* Quick-Picks Pills for Popular Server Mods */}
          <div className="flex items-center gap-1.5 flex-wrap text-xs">
            <span className="text-[11px] text-muted-foreground font-mono">Popular Addons:</span>
            {['Fabric API', 'Lithium', 'FerriteCore', 'Simple Voice Chat', 'Chunky', 'Spark'].map((preset) => (
              <button
                key={preset}
                onClick={() => {
                  setSearchQuery(preset);
                  searchModrinth(preset);
                }}
                className="bg-card-subtle hover:bg-muted text-foreground/80 hover:text-primary px-2 py-0.5 rounded text-[11px] border border-border/60 transition-colors font-mono"
              >
                + {preset}
              </button>
            ))}
          </div>

          {/* Results Grid */}
          {isSearching ? (
            <div className="card p-12 text-center text-muted-foreground flex flex-col items-center justify-center">
              <span className="inline-block animate-spin text-2xl text-primary mb-2">⟳</span>
              <span className="text-xs font-mono">Querying Modrinth community catalog for MC {activeGameVersion || 'compatible'}...</span>
            </div>
          ) : searchResults.length === 0 ? (
            <div className="card p-12 text-center text-muted-foreground">
              <span className="text-2xl mb-2 block">🔍</span>
              <p className="text-sm font-semibold text-foreground">No matching mods found</p>
              <p className="text-xs text-muted-foreground mt-1">
                Try searching for broader keywords or verify compatibility with {server.serverType}.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {searchResults.map((hit) => {
                const isInstalled = installedMods.some(
                  (m) => m.filename.toLowerCase().includes(hit.slug.toLowerCase()),
                );

                return (
                  <div
                    key={hit.project_id}
                    className="card p-4 border border-border flex flex-col justify-between hover:border-primary/40 transition-all group"
                  >
                    <div>
                      <div className="flex items-start gap-3">
                        {hit.icon_url ? (
                          <img
                            src={hit.icon_url}
                            alt={hit.title}
                            className="w-10 h-10 rounded-lg object-contain bg-muted/40 p-0.5 border border-border/50 shrink-0"
                            loading="lazy"
                          />
                        ) : (
                          <div className="w-10 h-10 rounded-lg bg-primary/20 border border-primary/30 flex items-center justify-center text-lg shrink-0">
                            🧩
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <h4 className="font-bold text-sm text-foreground group-hover:text-primary transition-colors truncate">
                            {hit.title}
                          </h4>
                          <div className="flex items-center gap-1.5 mt-0.5">
                            <span className="text-[10px] text-muted-foreground font-mono block truncate">
                              by {hit.author}
                            </span>
                            {hit.project_type === 'modpack' && (
                              <span className="badge badge-primary text-[9px] py-0 px-1 font-mono uppercase">
                                Modpack
                              </span>
                            )}
                          </div>
                        </div>
                      </div>

                      <p className="text-xs text-muted-foreground mt-2 line-clamp-2 leading-relaxed">
                        {hit.description}
                      </p>
                    </div>

                    <div className="mt-4 pt-3 border-t border-border/40 flex items-center justify-between">
                      <span className="text-[10px] text-muted-foreground font-mono flex items-center gap-1">
                        <span>⬇</span> {hit.downloads.toLocaleString()}
                      </span>

                      <button
                        onClick={() => handleInstallMod(hit)}
                        disabled={installingId === hit.project_id}
                        className={`btn btn-sm ${
                          isInstalled
                            ? 'btn-secondary text-[10px] opacity-80'
                            : 'btn-primary text-xs font-bold shadow glow-primary'
                        }`}
                      >
                        {installingId === hit.project_id ? (
                          <span className="flex items-center gap-1">
                            <span className="animate-spin text-[10px]">⟳</span> Installing...
                          </span>
                        ) : isInstalled ? (
                          '✓ Installed (Reinstall)'
                        ) : hit.project_type === 'modpack' ? (
                          '📦 Install Modpack'
                        ) : (
                          '⬇ Install Mod'
                        )}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Subtab 2: Installed Mods ───────────────────────────────────────── */}
      {subtab === 'installed' && (
        <div className="space-y-4">
          {/* Active Installed Modpack Banner */}
          {installedModpack && (
            <div className="card p-4 border border-primary/40 bg-gradient-to-r from-primary/10 via-card to-card glow-primary">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="flex items-start gap-3">
                  <span className="text-3xl p-2 rounded-xl bg-primary/20 border border-primary/30">📦</span>
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <h4 className="font-bold text-sm text-foreground">
                        {installedModpack.name}
                      </h4>
                      <span className="badge badge-primary text-[10px] font-mono">
                        MODPACK
                      </span>
                      {installedModpack.versionId && (
                        <span className="badge badge-neutral text-[10px] font-mono text-violet-300 border-violet-500/30">
                          {installedModpack.versionId}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      Active modpack extracted into server with{' '}
                      <span className="text-foreground font-semibold">{installedModpack.installedModsCount} mods</span> and{' '}
                      <span className="text-foreground font-semibold">{installedModpack.installedFilesCount} config/override files</span>.
                    </p>
                    <div className="flex items-center gap-3 text-[10px] text-muted-foreground font-mono mt-1.5 flex-wrap">
                      <span>Installed: {new Date(installedModpack.installedAt).toLocaleString()}</span>
                      {installedModpack.dependencies && Object.keys(installedModpack.dependencies).length > 0 && (
                        <span>• Requires: {Object.entries(installedModpack.dependencies).map(([k, v]) => `${k} ${v}`).join(', ')}</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Upload Mod (.jar) or Modpack (.mrpack) Drag and Drop Zone */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragOver(true);
            }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={handleDrop}
            className={`card p-4 border-2 border-dashed transition-all ${
              isDragOver
                ? 'border-primary bg-primary/10 shadow-lg glow-primary'
                : 'border-border/80 bg-muted/10 hover:border-primary/50'
            }`}
          >
            <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <span className="text-2xl">{isUploading ? '⏳' : '📤'}</span>
                <div>
                  <h4 className="text-xs font-bold text-foreground">
                    {isUploading ? 'Installing custom mod or modpack...' : 'Upload Custom Mod (.jar) or Modpack (.mrpack)'}
                  </h4>
                  <p className="text-[11px] text-muted-foreground">
                    Drag & drop custom <span className="font-mono text-foreground">.jar</span> mods or Modrinth <span className="font-mono text-foreground">.mrpack</span> modpacks to install into your server
                  </p>
                </div>
              </div>

              <label className="btn btn-primary text-xs py-1.5 px-3 font-semibold cursor-pointer shrink-0">
                <span>{isUploading ? 'Installing...' : '📁 Browse .jar / .mrpack'}</span>
                <input
                  type="file"
                  accept=".jar,.disabled,.mrpack"
                  multiple
                  disabled={isUploading}
                  className="hidden"
                  onChange={handleFileUpload}
                />
              </label>
            </div>
          </div>

          {loadingInstalled ? (
            <div className="card p-12 text-center text-muted-foreground">
              <span className="animate-spin text-2xl text-primary inline-block mb-2">⟳</span>
              <p className="text-xs font-mono">Reading storage volume /{addonsFolder}...</p>
            </div>
          ) : installedMods.length === 0 ? (
            <div className="card p-12 text-center border border-dashed border-border/80">
              <span className="text-3xl mb-3 block">📦</span>
              <h4 className="font-bold text-base text-foreground">No mods installed yet</h4>
              <p className="text-xs text-muted-foreground mt-1 max-w-md mx-auto">
                Your server’s <span className="font-mono text-foreground">/{addonsFolder}</span> folder is currently empty.
                Browse Modrinth for community mods or drag & drop custom .jar files above.
              </p>
              <button
                onClick={() => setSubtab('browse')}
                className="btn btn-primary text-xs font-bold py-2 px-4 mt-4"
              >
                Browse Open-Source Mods 🚀
              </button>
            </div>
          ) : (
            <div className="card overflow-hidden border border-border">
              <div className="p-3.5 bg-card-subtle border-b border-border flex items-center justify-between text-xs font-semibold">
                <span className="text-foreground">
                  Installed Addons in /{addonsFolder} ({installedMods.length})
                </span>
                <span className="text-[11px] text-muted-foreground font-mono">
                  Changes take effect after server restart
                </span>
              </div>

              <div className="divide-y divide-border/40">
                {installedMods.map((mod) => (
                  <div
                    key={mod.filename}
                    className="p-3.5 flex items-center justify-between hover:bg-muted/10 transition-colors gap-3"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="text-base">{mod.enabled ? '🟢' : '⚪'}</span>
                      <div className="min-w-0">
                        <span
                          className={`font-mono text-xs font-semibold block truncate ${
                            mod.enabled ? 'text-foreground' : 'text-muted-foreground line-through'
                          }`}
                        >
                          {mod.filename}
                        </span>
                        <div className="flex items-center gap-2 text-[10px] text-muted-foreground font-mono mt-0.5">
                          <span>{formatFileSize(mod.sizeBytes)}</span>
                          <span>•</span>
                          <span>
                            {mod.enabled ? (
                              <span className="text-emerald-400 font-bold">ACTIVE</span>
                            ) : (
                              <span className="text-amber-400 font-bold">DISABLED</span>
                            )}
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() => handleToggle(mod)}
                        className="btn btn-secondary text-xs py-1 px-2.5 font-mono"
                        title={mod.enabled ? 'Disable mod (adds .disabled)' : 'Enable mod'}
                      >
                        {mod.enabled ? 'Disable' : 'Enable'}
                      </button>
                      <button
                        onClick={() => handleDelete(mod.filename)}
                        className="btn btn-secondary text-xs py-1 px-2.5 text-red-400 hover:text-red-300 border-red-500/20"
                        title="Delete mod file"
                      >
                        🗑️ Remove
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
