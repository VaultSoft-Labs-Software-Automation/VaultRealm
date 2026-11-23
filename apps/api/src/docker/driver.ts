/**
 * DockerDriver — Abstraction over Docker Engine operations.
 *
 * All Docker access in the panel goes through this interface (AGENTS.md rule).
 * Two implementations: RealDockerDriver (dockerode) and MockDockerDriver (tests).
 */

export interface ContainerCreateOptions {
  name: string;
  image: string;
  env: Record<string, string>;
  labels: Record<string, string>;
  ports: PortBinding[];
  volumes: VolumeBinding[];
  memoryMb: number;
  cpuLimit: number;
  pidsLimit?: number;
  restartPolicy?: 'no' | 'unless-stopped' | 'on-failure';
  networkMode?: string;
  extraHosts?: string[];
  readOnly?: boolean;
  capDrop?: string[];
  capAdd?: string[];
  securityOpt?: string[];
  user?: string;
  logDriver?: string;
  logOpts?: Record<string, string>;
}

export interface PortBinding {
  hostPort: number;
  containerPort: number;
  protocol: 'tcp' | 'udp';
}

export interface VolumeBinding {
  hostPath: string;
  containerPath: string;
  readOnly?: boolean;
}

export interface ContainerInfo {
  id: string;
  name: string;
  state: ContainerState;
  image: string;
  labels: Record<string, string>;
  ports: PortBinding[];
  created: string;
}

export interface ContainerState {
  status: 'created' | 'running' | 'paused' | 'restarting' | 'removing' | 'exited' | 'dead';
  running: boolean;
  exitCode: number;
  oomKilled: boolean;
  startedAt: string;
  finishedAt: string;
  error: string;
}

export interface ContainerInspect {
  id: string;
  name: string;
  state: ContainerState;
  image: string;
  config: {
    env: string[];
    labels: Record<string, string>;
  };
  hostConfig: {
    memory: number;
    nanoCpus: number;
    pidsLimit: number;
    restartPolicy: { name: string; maximumRetryCount: number };
  };
  networkSettings: {
    ports: Record<string, Array<{ HostPort: string }> | null>;
    ipAddress?: string;
    gateway?: string;
  };
  mounts: Array<{
    source: string;
    destination: string;
    rw: boolean;
  }>;
}

export interface ContainerStats {
  cpuPercent: number;
  memoryUsageMb: number;
  memoryLimitMb: number;
  memoryPercent: number;
  networkRxBytes: number;
  networkTxBytes: number;
  pids: number;
  diskUsedMb?: number;
  diskLimitMb?: number;
  diskPercent?: number;
}

export interface PullProgress {
  status: string;
  progress?: string;
  progressPercent?: number;
}

export interface DockerEvent {
  type: string;
  action: string;
  actor: {
    id: string;
    attributes: Record<string, string>;
  };
  time: number;
}

export interface DockerDriver {
  /** Whether this driver is an in-memory simulation / fake */
  readonly isMock?: boolean;
  // ── Container lifecycle ────────────────────────────────────────────────────
  /** Create a container (does not start it). */
  createContainer(opts: ContainerCreateOptions): Promise<string>;

  /** Start a container by ID. */
  startContainer(id: string): Promise<void>;

  /** Stop a container with a timeout. */
  stopContainer(id: string, timeoutSeconds?: number): Promise<void>;

  /** Restart a container. */
  restartContainer(id: string, timeoutSeconds?: number): Promise<void>;

  /** Kill a container immediately. */
  killContainer(id: string, signal?: string): Promise<void>;

  /** Remove a container (must be stopped). */
  removeContainer(id: string, removeVolumes?: boolean): Promise<void>;

  // ── Inspection ─────────────────────────────────────────────────────────────
  /** Get detailed container inspect data. */
  inspectContainer(id: string): Promise<ContainerInspect>;

  /** Get live resource stats (single snapshot). */
  getContainerStats(id: string): Promise<ContainerStats>;

  /** List containers by label filter. */
  listContainers(labelFilter?: Record<string, string>): Promise<ContainerInfo[]>;

  // ── Logs ───────────────────────────────────────────────────────────────────
  /** Get recent log lines. */
  getContainerLogs(id: string, tail?: number): Promise<string[]>;

  /**
   * Stream logs. Returns an async iterable of log lines.
   * The caller is responsible for breaking out of the loop.
   */
  streamContainerLogs(
    id: string,
    tail?: number,
  ): AsyncIterable<string>;

  // ── Images ─────────────────────────────────────────────────────────────────
  /** Pull an image with progress updates. */
  pullImage(
    image: string,
    onProgress?: (progress: PullProgress) => void,
  ): Promise<void>;

  /** Check if an image exists locally. */
  hasImage(image: string): Promise<boolean>;

  // ── Events ─────────────────────────────────────────────────────────────────
  /**
   * Stream Docker events, filtered by labels.
   * Returns an async iterable; break to stop listening.
   */
  streamEvents(
    labelFilter?: Record<string, string>,
  ): AsyncIterable<DockerEvent>;

  // ── Host ───────────────────────────────────────────────────────────────────
  /** Get Docker engine info (version, memory, CPUs). */
  getHostInfo(): Promise<{
    dockerVersion: string;
    totalMemoryMb: number;
    cpus: number;
    operatingSystem: string;
    containersRunning: number;
    containersStopped: number;
  }>;

  // ── Network ────────────────────────────────────────────────────────────────
  /** Create a Docker network if it doesn't exist. */
  ensureNetwork(name: string): Promise<string>;

  /** Connect a container to a network. */
  connectToNetwork(containerId: string, networkId: string): Promise<void>;

  // ── Updates ────────────────────────────────────────────────────────────────
  /** Update container resource limits (RAM, CPU). */
  updateContainer(
    id: string,
    update: { memoryMb?: number; cpuLimit?: number; restartPolicy?: string },
  ): Promise<void>;

  // ── Exec ───────────────────────────────────────────────────────────────────
  /** Execute a command inside a running container. */
  exec(id: string, cmd: string[]): Promise<{ exitCode: number; output: string }>;
}
