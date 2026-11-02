/**
 * MockDockerDriver — In-memory fake for testing.
 *
 * Simulates container lifecycle, image pulls, log streaming, and events.
 * Supports injecting failures and custom behaviors for integration tests.
 */

import type {
  DockerDriver,
  ContainerCreateOptions,
  ContainerInfo,
  ContainerInspect,
  ContainerState,
  ContainerStats,
  PullProgress,
  DockerEvent,
} from './driver.js';

interface MockContainer {
  id: string;
  name: string;
  image: string;
  state: ContainerState;
  config: ContainerCreateOptions;
  logs: string[];
  createdAt: string;
}

export class MockDockerDriver implements DockerDriver {
  readonly isMock = true;
  /** All containers managed by this mock. */
  readonly containers = new Map<string, MockContainer>();

  /** Images considered "available" locally. */
  readonly images = new Set<string>();

  /** Networks created. */
  readonly networks = new Map<string, string>();

  /** Event listeners for streamEvents. */
  private eventListeners: Array<(event: DockerEvent) => void> = [];

  /** Counter for generating unique IDs. */
  private idCounter = 0;

  /** Periodic log generator intervals per container. */
  private readonly _logIntervals = new Map<string, ReturnType<typeof setInterval>>();

  /** Optional hook: throw from this to simulate failures. */
  onCreateContainer?: (opts: ContainerCreateOptions) => void;
  onStartContainer?: (id: string) => void;
  onStopContainer?: (id: string) => void;
  onPullImage?: (image: string) => void;

  private nextId(): string {
    this.idCounter++;
    return `mock-${this.idCounter.toString().padStart(12, '0')}`;
  }

  async createContainer(opts: ContainerCreateOptions): Promise<string> {
    this.onCreateContainer?.(opts);

    const id = this.nextId();
    const container: MockContainer = {
      id,
      name: opts.name,
      image: opts.image,
      state: {
        status: 'created',
        running: false,
        exitCode: 0,
        oomKilled: false,
        startedAt: '',
        finishedAt: '',
        error: '',
      },
      config: opts,
      logs: [],
      createdAt: new Date().toISOString(),
    };

    this.containers.set(id, container);
    this.emitEvent('container', 'create', id, opts.labels);
    return id;
  }

  async startContainer(id: string): Promise<void> {
    const container = this.getOrThrow(id);
    this.onStartContainer?.(id);

    container.state = {
      ...container.state,
      status: 'running',
      running: true,
      startedAt: new Date().toISOString(),
      finishedAt: '',
    };

    // Generate realistic startup logs for the live console
    const ts = () => new Date().toISOString().split('T')[1]?.slice(0, 8) ?? '00:00:00';
    const startupLogs = [
      `[${ts()}] [Server] Starting ${container.config.image}...`,
      `[${ts()}] [Server] Loading configuration from /data/server.properties`,
      `[${ts()}] [Server] Environment: EULA=TRUE, MEMORY=${container.config.env?.MEMORY ?? '2048M'}`,
      `[${ts()}] [Server] Preparing level "world"`,
      `[${ts()}] [Server] Generating keypair`,
      `[${ts()}] [Server] Starting Minecraft server on 0.0.0.0:25565`,
      `[${ts()}] [Server] Preparing spawn area: 0%`,
      `[${ts()}] [Server] Preparing spawn area: 50%`,
      `[${ts()}] [Server] Preparing spawn area: 100%`,
      `[${ts()}] [Server] Done! Server is now accepting connections.`,
      `[${ts()}] [Server] For help, type "help" or "?"`,
    ];
    container.logs.push(...startupLogs);

    // Emit periodic heartbeat logs while the container is running
    const logInterval = setInterval(() => {
      if (!container.state.running) {
        clearInterval(logInterval);
        return;
      }
      const tickMessages = [
        `[${ts()}] [Server] Tick rate: 20.0 TPS`,
        `[${ts()}] [Server] Memory: ${Math.floor(Math.random() * 512) + 256}MB / ${container.config.env?.MEMORY ?? '2048M'}`,
        `[${ts()}] [Server] Players online: 0`,
      ];
      const line = tickMessages[Math.floor(Math.random() * tickMessages.length)]!;
      container.logs.push(line);
      // Keep log buffer bounded
      if (container.logs.length > 500) {
        container.logs.splice(0, container.logs.length - 500);
      }
    }, 5000);

    // Store the interval so it can be cleaned up on stop
    this._logIntervals.set(id, logInterval);

    this.emitEvent('container', 'start', id, container.config.labels);
  }

  async stopContainer(id: string, _timeoutSeconds?: number): Promise<void> {
    const container = this.getOrThrow(id);
    this.onStopContainer?.(id);

    // Clean up periodic log generator
    const interval = this._logIntervals.get(id);
    if (interval) {
      clearInterval(interval);
      this._logIntervals.delete(id);
    }

    const ts = () => new Date().toISOString().split('T')[1]?.slice(0, 8) ?? '00:00:00';
    container.logs.push(
      `[${ts()}] [Server] Stopping server...`,
      `[${ts()}] [Server] Saving world data...`,
      `[${ts()}] [Server] Server stopped gracefully.`,
    );

    container.state = {
      ...container.state,
      status: 'exited',
      running: false,
      exitCode: 0,
      finishedAt: new Date().toISOString(),
    };

    this.emitEvent('container', 'stop', id, container.config.labels);
    this.emitEvent('container', 'die', id, {
      ...container.config.labels,
      exitCode: '0',
    });
  }

  async restartContainer(id: string, _timeoutSeconds?: number): Promise<void> {
    await this.stopContainer(id);
    await this.startContainer(id);
  }

  async killContainer(id: string, signal?: string): Promise<void> {
    const container = this.getOrThrow(id);

    // Clean up periodic log generator
    const killInterval = this._logIntervals.get(id);
    if (killInterval) {
      clearInterval(killInterval);
      this._logIntervals.delete(id);
    }

    const exitCode = signal === 'SIGKILL' ? 137 : 143;
    const ts = () => new Date().toISOString().split('T')[1]?.slice(0, 8) ?? '00:00:00';
    container.logs.push(
      `[${ts()}] [Server] WARN: Received ${signal ?? 'SIGTERM'} signal`,
      `[${ts()}] [Server] ERROR: Server process killed (exit code ${exitCode})`,
    );

    container.state = {
      ...container.state,
      status: 'exited',
      running: false,
      exitCode,
      finishedAt: new Date().toISOString(),
    };

    this.emitEvent('container', 'kill', id, container.config.labels);
    this.emitEvent('container', 'die', id, {
      ...container.config.labels,
      exitCode: container.state.exitCode.toString(),
    });
  }

  async removeContainer(id: string, _removeVolumes?: boolean): Promise<void> {
    const container = this.getOrThrow(id);
    if (container.state.running) {
      throw new Error(`Cannot remove running container ${id}. Stop it first.`);
    }
    // Clean up any lingering log interval
    const interval = this._logIntervals.get(id);
    if (interval) {
      clearInterval(interval);
      this._logIntervals.delete(id);
    }
    this.containers.delete(id);
    this.emitEvent('container', 'destroy', id, container.config.labels);
  }

  async inspectContainer(id: string): Promise<ContainerInspect> {
    const container = this.getOrThrow(id);

    const envArray = Object.entries(container.config.env).map(([k, v]) => `${k}=${v}`);

    const ports: Record<string, Array<{ HostPort: string }> | null> = {};
    for (const p of container.config.ports) {
      const key = `${p.containerPort}/${p.protocol}`;
      ports[key] = [{ HostPort: p.hostPort.toString() }];
    }

    return {
      id: container.id,
      name: `/${container.name}`,
      state: { ...container.state },
      image: container.image,
      config: {
        env: envArray,
        labels: { ...container.config.labels },
      },
      hostConfig: {
        memory: container.config.memoryMb * 1024 * 1024,
        nanoCpus: container.config.cpuLimit * 1e9,
        pidsLimit: container.config.pidsLimit ?? 256,
        restartPolicy: {
          name: container.config.restartPolicy ?? 'no',
          maximumRetryCount: 0,
        },
      },
      networkSettings: {
        ports,
        ipAddress: '172.17.0.2',
        gateway: '172.17.0.1',
      },
      mounts: container.config.volumes.map((v) => ({
        source: v.hostPath,
        destination: v.containerPath,
        rw: !v.readOnly,
      })),
    };
  }

  async getContainerStats(id: string): Promise<ContainerStats> {
    this.getOrThrow(id);

    // Return realistic-looking fake stats
    return {
      cpuPercent: Math.random() * 50,
      memoryUsageMb: 128 + Math.random() * 512,
      memoryLimitMb: 2048,
      memoryPercent: (128 + Math.random() * 512) / 2048 * 100,
      networkRxBytes: Math.floor(Math.random() * 1e6),
      networkTxBytes: Math.floor(Math.random() * 1e6),
      pids: Math.floor(20 + Math.random() * 30),
    };
  }

  async listContainers(labelFilter?: Record<string, string>): Promise<ContainerInfo[]> {
    const results: ContainerInfo[] = [];

    for (const container of this.containers.values()) {
      if (labelFilter) {
        const matches = Object.entries(labelFilter).every(
          ([key, val]) => container.config.labels[key] === val,
        );
        if (!matches) continue;
      }

      results.push({
        id: container.id,
        name: container.name,
        state: { ...container.state },
        image: container.image,
        labels: { ...container.config.labels },
        ports: [...container.config.ports],
        created: container.createdAt,
      });
    }

    return results;
  }

  async getContainerLogs(id: string, tail?: number): Promise<string[]> {
    const container = this.getOrThrow(id);
    if (tail) {
      return container.logs.slice(-tail);
    }
    return [...container.logs];
  }

  async *streamContainerLogs(id: string, tail?: number): AsyncIterable<string> {
    const container = this.getOrThrow(id);
    const startIndex = tail ? Math.max(0, container.logs.length - tail) : 0;

    for (let i = startIndex; i < container.logs.length; i++) {
      yield container.logs[i]!;
    }
  }

  async pullImage(
    image: string,
    onProgress?: (progress: PullProgress) => void,
  ): Promise<void> {
    this.onPullImage?.(image);

    // Simulate pull progress
    const steps = [0, 25, 50, 75, 100];
    for (const pct of steps) {
      onProgress?.({
        status: pct === 100 ? 'Pull complete' : 'Downloading',
        progress: `${pct}%`,
        progressPercent: pct,
      });
    }

    this.images.add(image);
  }

  async hasImage(image: string): Promise<boolean> {
    return this.images.has(image);
  }

  async *streamEvents(
    _labelFilter?: Record<string, string>,
  ): AsyncIterable<DockerEvent> {
    // In the mock, events are emitted synchronously via emitEvent.
    // For tests, add logs to a container then iterate.
    // This is a simplified implementation.
    yield* [];
  }

  async getHostInfo() {
    return {
      dockerVersion: '27.0.0-mock',
      totalMemoryMb: 16384,
      cpus: 4,
      operatingSystem: 'Mock Linux',
      containersRunning: [...this.containers.values()].filter((c) => c.state.running).length,
      containersStopped: [...this.containers.values()].filter((c) => !c.state.running).length,
    };
  }

  async ensureNetwork(name: string): Promise<string> {
    if (this.networks.has(name)) {
      return this.networks.get(name)!;
    }
    const id = `net-${name}`;
    this.networks.set(name, id);
    return id;
  }

  async connectToNetwork(_containerId: string, _networkId: string): Promise<void> {
    // No-op in mock
  }

  async updateContainer(
    id: string,
    update: { memoryMb?: number; cpuLimit?: number; restartPolicy?: string },
  ): Promise<void> {
    const container = this.getOrThrow(id);
    if (update.memoryMb !== undefined) {
      container.config.memoryMb = update.memoryMb;
    }
    if (update.cpuLimit !== undefined) {
      container.config.cpuLimit = update.cpuLimit;
    }
    if (update.restartPolicy !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock flexibility for restart policy string
      container.config.restartPolicy = update.restartPolicy as any;
    }
  }

  // ── Mock-specific helpers ──────────────────────────────────────────────────

  /** Add log lines to a container (for testing log streaming / diagnosis). */
  addLogs(id: string, lines: string[]): void {
    const container = this.getOrThrow(id);
    container.logs.push(...lines);
  }

  /** Simulate an OOM kill on a container. */
  simulateOomKill(id: string): void {
    const container = this.getOrThrow(id);
    container.state = {
      ...container.state,
      status: 'exited',
      running: false,
      exitCode: 137,
      oomKilled: true,
      finishedAt: new Date().toISOString(),
    };
    this.emitEvent('container', 'oom', id, container.config.labels);
    this.emitEvent('container', 'die', id, {
      ...container.config.labels,
      exitCode: '137',
    });
  }

  /** Simulate a crash (non-zero exit). */
  simulateCrash(id: string, exitCode = 1): void {
    const container = this.getOrThrow(id);
    container.state = {
      ...container.state,
      status: 'exited',
      running: false,
      exitCode,
      finishedAt: new Date().toISOString(),
    };
    this.emitEvent('container', 'die', id, {
      ...container.config.labels,
      exitCode: exitCode.toString(),
    });
  }

  /** Reset all state (for test cleanup). */
  reset(): void {
    this.containers.clear();
    this.images.clear();
    this.networks.clear();
    this.eventListeners = [];
    this.idCounter = 0;
    this.onCreateContainer = undefined;
    this.onStartContainer = undefined;
    this.onStopContainer = undefined;
    this.onPullImage = undefined;
  }

  async exec(id: string, cmd: string[]): Promise<{ exitCode: number; output: string }> {
    const c = this.getOrThrow(id);
    if (!c.state.running) {
      throw new Error(`Container ${id} is not running`);
    }
    const fullCmd = cmd.join(' ');
    // Handle mock responses for Minecraft rcon-cli
    if (fullCmd.includes('rcon-cli list')) {
      return {
        exitCode: 0,
        output: 'There are 1 of a max of 20 players online: TestPlayer',
      };
    }
    if (fullCmd.includes('ban-ip')) {
      return {
        exitCode: 0,
        output: `Banned IP successfully.`,
      };
    }
    if (fullCmd.includes('kick')) {
      return {
        exitCode: 0,
        output: `Kicked player.`,
      };
    }
    return {
      exitCode: 0,
      output: `[Mock exec] Output for ${fullCmd}`,
    };
  }

  private getOrThrow(id: string): MockContainer {
    const container = this.containers.get(id);
    if (!container) {
      throw new Error(`Container ${id} not found`);
    }
    return container;
  }

  private emitEvent(
    type: string,
    action: string,
    actorId: string,
    attributes: Record<string, string>,
  ): void {
    const event: DockerEvent = {
      type,
      action,
      actor: { id: actorId, attributes },
      time: Math.floor(Date.now() / 1000),
    };
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }
}
