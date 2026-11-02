/**
 * RealDockerDriver — Production Docker Engine driver via dockerode.
 *
 * Wraps the dockerode library to implement the DockerDriver interface.
 * This is the only file that should import 'dockerode' (AGENTS.md rule).
 */

import Docker from 'dockerode';
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

export class RealDockerDriver implements DockerDriver {
  readonly isMock = false;
  private docker: Docker;

  constructor(socketPath?: string) {
    this.docker = socketPath ? new Docker({ socketPath }) : new Docker();
  }

  async createContainer(opts: ContainerCreateOptions): Promise<string> {
    const envArray = Object.entries(opts.env).map(([k, v]) => `${k}=${v}`);

    const portBindings: Record<string, Array<{ HostPort: string }>> = {};
    const exposedPorts: Record<string, object> = {};

    for (const p of opts.ports) {
      const key = `${p.containerPort}/${p.protocol}`;
      portBindings[key] = [{ HostPort: p.hostPort.toString() }];
      exposedPorts[key] = {};
    }

    const binds = opts.volumes.map(
      (v) => `${v.hostPath}:${v.containerPath}${v.readOnly ? ':ro' : ''}`,
    );

    const container = await this.docker.createContainer({
      name: opts.name,
      Image: opts.image,
      Env: envArray,
      Labels: opts.labels,
      ExposedPorts: exposedPorts,
      HostConfig: {
        PortBindings: portBindings,
        Binds: binds,
        Memory: opts.memoryMb * 1024 * 1024,
        MemorySwap: opts.memoryMb * 1024 * 1024, // No swap
        NanoCpus: opts.cpuLimit * 1e9,
        PidsLimit: opts.pidsLimit ?? 256,
        RestartPolicy: {
          Name: opts.restartPolicy ?? 'no',
          MaximumRetryCount: opts.restartPolicy === 'on-failure' ? 3 : 0,
        },
        NetworkMode: opts.networkMode,
        ExtraHosts:
          opts.extraHosts && opts.extraHosts.length > 0
            ? Array.from(new Set([...opts.extraHosts, 'host.docker.internal:host-gateway']))
            : ['host.docker.internal:host-gateway'],
        ReadonlyRootfs: opts.readOnly ?? false,
        CapDrop: opts.capDrop,
        CapAdd: opts.capAdd,
        SecurityOpt: opts.securityOpt ?? ['no-new-privileges'],
        LogConfig: {
          Type: (opts.logDriver ?? 'json-file') as 'json-file',
          Config: opts.logOpts ?? { 'max-size': '10m', 'max-file': '3' },
        },
      },
      User: opts.user,
    });

    return container.id;
  }

  async startContainer(id: string): Promise<void> {
    const container = this.docker.getContainer(id);
    await container.start();
  }

  async stopContainer(id: string, timeoutSeconds = 30): Promise<void> {
    const container = this.docker.getContainer(id);
    await container.stop({ t: timeoutSeconds });
  }

  async restartContainer(id: string, timeoutSeconds = 30): Promise<void> {
    const container = this.docker.getContainer(id);
    await container.restart({ t: timeoutSeconds });
  }

  async killContainer(id: string, signal = 'SIGKILL'): Promise<void> {
    const container = this.docker.getContainer(id);
    await container.kill({ signal });
  }

  async removeContainer(id: string, removeVolumes = false): Promise<void> {
    const container = this.docker.getContainer(id);
    await container.remove({ v: removeVolumes });
  }

  async inspectContainer(id: string): Promise<ContainerInspect> {
    const container = this.docker.getContainer(id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dockerode inspect returns an untyped object
    const data: any = await container.inspect();

    const state: ContainerState = {
      status: data.State.Status,
      running: data.State.Running,
      exitCode: data.State.ExitCode,
      oomKilled: data.State.OOMKilled,
      startedAt: data.State.StartedAt,
      finishedAt: data.State.FinishedAt,
      error: data.State.Error ?? '',
    };

    return {
      id: data.Id,
      name: data.Name,
      state,
      image: data.Config.Image,
      config: {
        env: data.Config.Env ?? [],
        labels: data.Config.Labels ?? {},
      },
      hostConfig: {
        memory: data.HostConfig.Memory,
        nanoCpus: data.HostConfig.NanoCpus,
        pidsLimit: data.HostConfig.PidsLimit,
        restartPolicy: data.HostConfig.RestartPolicy,
      },
      networkSettings: {
        ports: data.NetworkSettings.Ports ?? {},
        ipAddress:
          data.NetworkSettings.IPAddress ||
          (data.NetworkSettings.Networks
            ? Object.values(data.NetworkSettings.Networks as Record<string, { IPAddress?: string }>)[0]?.IPAddress
            : undefined) ||
          undefined,
        gateway:
          data.NetworkSettings.Gateway ||
          (data.NetworkSettings.Networks
            ? Object.values(data.NetworkSettings.Networks as Record<string, { Gateway?: string }>)[0]?.Gateway
            : undefined) ||
          undefined,
      },
      mounts: (data.Mounts ?? []).map(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dockerode mount type
        (m: any) => ({
          source: m.Source,
          destination: m.Destination,
          rw: m.RW,
        }),
      ),
    };
  }

  async getContainerStats(id: string): Promise<ContainerStats> {
    const container = this.docker.getContainer(id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dockerode stats type
    const stats: any = await container.stats({ stream: false });

    // Calculate CPU percentage
    const cpuDelta =
      stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
    const systemDelta =
      stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
    const numCpus = stats.cpu_stats.online_cpus ?? 1;
    const cpuPercent = systemDelta > 0 ? (cpuDelta / systemDelta) * numCpus * 100 : 0;

    const memUsage = stats.memory_stats.usage - (stats.memory_stats.stats?.cache ?? 0);
    const memLimit = stats.memory_stats.limit;

    // Sum network stats across all interfaces
    let rxBytes = 0;
    let txBytes = 0;
    if (stats.networks) {
      for (const iface of Object.values(stats.networks)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dockerode network stats
        rxBytes += (iface as any).rx_bytes ?? 0;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dockerode network stats
        txBytes += (iface as any).tx_bytes ?? 0;
      }
    }

    return {
      cpuPercent,
      memoryUsageMb: memUsage / (1024 * 1024),
      memoryLimitMb: memLimit / (1024 * 1024),
      memoryPercent: memLimit > 0 ? (memUsage / memLimit) * 100 : 0,
      networkRxBytes: rxBytes,
      networkTxBytes: txBytes,
      pids: stats.pids_stats?.current ?? 0,
    };
  }

  async listContainers(labelFilter?: Record<string, string>): Promise<ContainerInfo[]> {
    const filters: Record<string, string[]> = {};
    if (labelFilter) {
      filters['label'] = Object.entries(labelFilter).map(([k, v]) => `${k}=${v}`);
    }

    const containers = await this.docker.listContainers({
      all: true,
      filters,
    });

    return containers.map((c) => ({
      id: c.Id,
      name: (c.Names[0] ?? '').replace(/^\//, ''),
      state: {
        status: c.State as ContainerState['status'],
        running: c.State === 'running',
        exitCode: 0,
        oomKilled: false,
        startedAt: '',
        finishedAt: '',
        error: '',
      },
      image: c.Image,
      labels: c.Labels,
      ports: (c.Ports ?? []).map((p) => ({
        hostPort: p.PublicPort ?? 0,
        containerPort: p.PrivatePort,
        protocol: (p.Type ?? 'tcp') as 'tcp' | 'udp',
      })),
      created: new Date(c.Created * 1000).toISOString(),
    }));
  }

  async getContainerLogs(id: string, tail = 500): Promise<string[]> {
    const container = this.docker.getContainer(id);
    const buffer = await container.logs({
      stdout: true,
      stderr: true,
      tail,
      timestamps: false,
    });

    // Docker log API prepends an 8-byte header per frame. Strip them.
    return this.parseLogBuffer(buffer as unknown as Buffer);
  }

  async *streamContainerLogs(id: string, tail = 100): AsyncIterable<string> {
    const container = this.docker.getContainer(id);
    const stream = await container.logs({
      stdout: true,
      stderr: true,
      follow: true,
      tail,
      timestamps: false,
    });

    // The stream is a Node.js readable stream
    const readable = stream as unknown as NodeJS.ReadableStream;
    for await (const chunk of readable) {
      const lines = this.parseLogBuffer(chunk as Buffer);
      for (const line of lines) {
        yield line;
      }
    }
  }

  async pullImage(
    image: string,
    onProgress?: (progress: PullProgress) => void,
  ): Promise<void> {
    const stream = await this.docker.pull(image);

    await new Promise<void>((resolve, reject) => {
      const layers = new Map<string, { current: number; total: number; status: string }>();

      this.docker.modem.followProgress(
        stream,
        (err: Error | null) => {
          if (err) reject(err);
          else resolve();
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dockerode progress event type
        (event: any) => {
          if (onProgress) {
            const id = event.id ? String(event.id) : null;
            const status = event.status ? String(event.status) : '';
            const current = event.progressDetail?.current ?? 0;
            const total = event.progressDetail?.total ?? 0;

            if (id) {
              const layer = layers.get(id) ?? { current: 0, total: 0, status: '' };
              if (total > 0) layer.total = total;
              if (current > 0) layer.current = current;
              if (status.includes('complete') || status.includes('Already exists')) {
                layer.current = layer.total;
              }
              layer.status = status;
              layers.set(id, layer);
            }

            let totalCurrent = 0;
            let totalBytes = 0;
            for (const l of layers.values()) {
              totalCurrent += l.current;
              totalBytes += l.total;
            }

            let progressPercent: number | undefined;
            if (totalBytes > 0 && totalCurrent > 0) {
              progressPercent = Math.min(99, Math.round((totalCurrent / totalBytes) * 100));
            } else if (event.progressDetail?.total && event.progressDetail?.current) {
              progressPercent = Math.round(
                (event.progressDetail.current / event.progressDetail.total) * 100,
              );
            }

            onProgress({
              status: status || 'Pulling',
              progress: event.progress,
              progressPercent,
            });
          }
        },
      );
    });
  }

  async hasImage(image: string): Promise<boolean> {
    try {
      await this.docker.getImage(image).inspect();
      return true;
    } catch {
      return false;
    }
  }

  async *streamEvents(
    labelFilter?: Record<string, string>,
  ): AsyncIterable<DockerEvent> {
    const filters: Record<string, string[]> = {
      type: ['container'],
    };
    if (labelFilter) {
      filters['label'] = Object.entries(labelFilter).map(([k, v]) => `${k}=${v}`);
    }

    const stream = await this.docker.getEvents({ filters });
    const readable = stream as unknown as NodeJS.ReadableStream;

    for await (const chunk of readable) {
      const text = chunk.toString();
      for (const line of text.split('\n').filter(Boolean)) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw Docker event JSON
          const raw: any = JSON.parse(line);
          yield {
            type: raw.Type ?? raw.type ?? '',
            action: raw.Action ?? raw.action ?? '',
            actor: {
              id: raw.Actor?.ID ?? raw.id ?? '',
              attributes: raw.Actor?.Attributes ?? {},
            },
            time: raw.time ?? raw.timeNano ? Math.floor(raw.timeNano / 1e9) : Date.now() / 1000,
          };
        } catch {
          // Skip malformed lines
        }
      }
    }
  }

  async getHostInfo() {
    const info = await this.docker.info();
    return {
      dockerVersion: info.ServerVersion ?? 'unknown',
      totalMemoryMb: Math.round((info.MemTotal ?? 0) / (1024 * 1024)),
      cpus: info.NCPU ?? 1,
      operatingSystem: info.OperatingSystem ?? 'unknown',
      containersRunning: info.ContainersRunning ?? 0,
      containersStopped: info.ContainersStopped ?? 0,
    };
  }

  async ensureNetwork(name: string): Promise<string> {
    const networks = await this.docker.listNetworks({
      filters: { name: [name] },
    });

    const existing = networks.find((n) => n.Name === name);
    if (existing) return existing.Id;

    const network = await this.docker.createNetwork({
      Name: name,
      Driver: 'bridge',
      Internal: false,
    });

    return network.id;
  }

  async connectToNetwork(containerId: string, networkId: string): Promise<void> {
    const network = this.docker.getNetwork(networkId);
    await network.connect({ Container: containerId });
  }

  async updateContainer(
    id: string,
    update: { memoryMb?: number; cpuLimit?: number; restartPolicy?: string },
  ): Promise<void> {
    const container = this.docker.getContainer(id);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dockerode update accepts partial host config
    const updateConfig: any = {};

    if (update.memoryMb !== undefined) {
      updateConfig.Memory = update.memoryMb * 1024 * 1024;
      updateConfig.MemorySwap = update.memoryMb * 1024 * 1024;
    }
    if (update.cpuLimit !== undefined) {
      updateConfig.NanoCpus = update.cpuLimit * 1e9;
    }
    if (update.restartPolicy !== undefined) {
      updateConfig.RestartPolicy = {
        Name: update.restartPolicy,
        MaximumRetryCount: update.restartPolicy === 'on-failure' ? 3 : 0,
      };
    }

    await container.update(updateConfig);
  }

  async exec(id: string, cmd: string[]): Promise<{ exitCode: number; output: string }> {
    const container = this.docker.getContainer(id);
    const execInstance = await container.exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
    });

    const stream = await execInstance.start({ Tty: false });
    const chunks: Buffer[] = [];

    await new Promise<void>((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => resolve());
      stream.on('error', reject);
    });

    const inspect = await execInstance.inspect();
    const rawBuffer = Buffer.concat(chunks);
    const lines = this.parseLogBuffer(rawBuffer);
    const output = lines.join('\n').trim() || rawBuffer.toString('utf-8').trim();

    return {
      exitCode: inspect.ExitCode ?? 0,
      output,
    };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private parseLogBuffer(buffer: Buffer): string[] {
    const lines: string[] = [];
    let offset = 0;

    while (offset < buffer.length) {
      // Docker log frames: 8-byte header then payload
      if (offset + 8 > buffer.length) break;

      const size = buffer.readUInt32BE(offset + 4);
      offset += 8;

      if (offset + size > buffer.length) break;

      const line = buffer.subarray(offset, offset + size).toString('utf-8').trimEnd();
      if (line) lines.push(line);
      offset += size;
    }

    // If parsing frames fails (e.g., TTY mode), fall back to line splitting
    if (lines.length === 0 && buffer.length > 0) {
      return buffer
        .toString('utf-8')
        .split('\n')
        .filter(Boolean);
    }

    return lines;
  }
}
