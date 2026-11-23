/**
 * Minecraft server.properties management.
 *
 * Implements granular reading, parsing, validating, and updating of server.properties
 * for Minecraft Java and Minecraft Bedrock servers.
 * Syncs corresponding environment variables in the database to prevent container recreation drift.
 */

import fs from 'node:fs';
import { safepath } from '../safepath.js';
import { getServerDataDir } from './volume.js';
import { getServerDetail } from './service.js';
import { getDatabase } from '../db/index.js';
import { servers } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { executeServerCommand } from './console.js';

export type PropertyCategory = 'gameplay' | 'security' | 'world' | 'performance' | 'network' | 'custom';
export type PropertyType = 'boolean' | 'number' | 'string' | 'select';

export interface PropertyMetadata {
  key: string;
  label: string;
  description: string;
  category: PropertyCategory;
  type: PropertyType;
  options?: Array<{ label: string; value: string }>;
  defaultValue: string;
  isSecret?: boolean;
}

export interface ServerPropertyItem extends PropertyMetadata {
  value: string;
  isModified: boolean;
}

export interface ServerPropertiesResponse {
  templateId: string;
  isMinecraft: boolean;
  serverStatus: string;
  properties: ServerPropertyItem[];
  rawContent: string;
}

/**
 * Built-in metadata definitions for Minecraft server.properties.
 */
export const MINECRAFT_PROPERTIES_METADATA: Record<string, Omit<PropertyMetadata, 'key'>> = {
  'online-mode': {
    label: 'Online Mode (Mojang Authentication)',
    description: 'Validates players against Mojang servers. Set to false (Offline Mode) to allow custom or offline launchers.',
    category: 'security',
    type: 'boolean',
    defaultValue: 'true',
  },
  'spawn-protection': {
    label: 'Spawn Protection Radius',
    description: 'Radius in blocks around world spawn point protected from non-operator modifications (0 disables).',
    category: 'world',
    type: 'number',
    defaultValue: '16',
  },
  'gamemode': {
    label: 'Default Game Mode',
    description: 'Default game mode assigned to new players joining the server.',
    category: 'gameplay',
    type: 'select',
    options: [
      { label: 'Survival', value: 'survival' },
      { label: 'Creative', value: 'creative' },
      { label: 'Adventure', value: 'adventure' },
      { label: 'Spectator', value: 'spectator' },
    ],
    defaultValue: 'survival',
  },
  'difficulty': {
    label: 'World Difficulty',
    description: 'Controls mob attack strength, hunger mechanics, and hostile mob spawning behavior.',
    category: 'gameplay',
    type: 'select',
    options: [
      { label: 'Peaceful', value: 'peaceful' },
      { label: 'Easy', value: 'easy' },
      { label: 'Normal', value: 'normal' },
      { label: 'Hard', value: 'hard' },
    ],
    defaultValue: 'normal',
  },
  'pvp': {
    label: 'Player vs Player (PvP)',
    description: 'Allows players to attack and damage one another.',
    category: 'gameplay',
    type: 'boolean',
    defaultValue: 'true',
  },
  'hardcore': {
    label: 'Hardcore Mode',
    description: 'Locks difficulty to Hard and permanently bans/spectates players upon death.',
    category: 'gameplay',
    type: 'boolean',
    defaultValue: 'false',
  },
  'allow-flight': {
    label: 'Allow Flying',
    description: 'Permits flight in Survival mode without kicking the player for floating or flying mods.',
    category: 'gameplay',
    type: 'boolean',
    defaultValue: 'false',
  },
  'enable-command-block': {
    label: 'Enable Command Blocks',
    description: 'Enables execution of command blocks in-game.',
    category: 'gameplay',
    type: 'boolean',
    defaultValue: 'false',
  },
  'force-gamemode': {
    label: 'Force Game Mode',
    description: 'Forces players to rejoin in the server default game mode, resetting custom player modes.',
    category: 'gameplay',
    type: 'boolean',
    defaultValue: 'false',
  },
  'player-idle-timeout': {
    label: 'Player Idle Timeout (Minutes)',
    description: 'Automatically kicks players who are AFK/idle for this many minutes (0 disables).',
    category: 'gameplay',
    type: 'number',
    defaultValue: '0',
  },
  'white-list': {
    label: 'Enable Whitelist',
    description: 'Only players listed in whitelist.json can join the server when enabled.',
    category: 'security',
    type: 'boolean',
    defaultValue: 'false',
  },
  'enforce-whitelist': {
    label: 'Enforce Whitelist',
    description: 'Immediately kicks connected players when they are removed from the whitelist.',
    category: 'security',
    type: 'boolean',
    defaultValue: 'false',
  },
  'op-permission-level': {
    label: 'Operator Permission Level',
    description: 'Default permission level given to server operators (1 to 4).',
    category: 'security',
    type: 'select',
    options: [
      { label: '1 - Bypass spawn protection', value: '1' },
      { label: '2 - Basic cheat commands (/clear, /give)', value: '2' },
      { label: '3 - Moderation commands (/ban, /kick, /op)', value: '3' },
      { label: '4 - Full Admin (/stop, reload, all commands)', value: '4' },
    ],
    defaultValue: '4',
  },
  'enforce-secure-profile': {
    label: 'Enforce Secure Profile (Chat Signing)',
    description: 'Requires cryptographic chat signatures from Mojang. Turn off if using offline accounts or chat mods.',
    category: 'security',
    type: 'boolean',
    defaultValue: 'true',
  },
  'prevent-proxy-connections': {
    label: 'Prevent Proxy Connections',
    description: 'Blocks VPNs and proxy connections via Mojang authentication servers.',
    category: 'security',
    type: 'boolean',
    defaultValue: 'false',
  },
  'hide-online-players': {
    label: 'Hide Online Players',
    description: 'Hides the online player list from server status queries in the multiplayer menu.',
    category: 'security',
    type: 'boolean',
    defaultValue: 'false',
  },
  'spawn-animals': {
    label: 'Spawn Animals',
    description: 'Permits passive animals (cows, sheep, pigs, chickens) to spawn in the world.',
    category: 'world',
    type: 'boolean',
    defaultValue: 'true',
  },
  'spawn-monsters': {
    label: 'Spawn Monsters',
    description: 'Permits hostile monsters (zombies, creepers, skeletons) to spawn in the world.',
    category: 'world',
    type: 'boolean',
    defaultValue: 'true',
  },
  'spawn-npcs': {
    label: 'Spawn Villagers / NPCs',
    description: 'Permits villagers and wandering traders to spawn in villages.',
    category: 'world',
    type: 'boolean',
    defaultValue: 'true',
  },
  'allow-nether': {
    label: 'Allow Nether Dimension',
    description: 'Allows portal travel and Nether world dimension generation.',
    category: 'world',
    type: 'boolean',
    defaultValue: 'true',
  },
  'level-name': {
    label: 'World Directory Name',
    description: 'Directory folder name on disk containing world chunk data.',
    category: 'world',
    type: 'string',
    defaultValue: 'world',
  },
  'level-seed': {
    label: 'World Generation Seed',
    description: 'Numerical or alphanumeric seed used for procedural world chunk generation.',
    category: 'world',
    type: 'string',
    defaultValue: '',
  },
  'level-type': {
    label: 'World Terrain Type',
    description: 'Preset generator world type.',
    category: 'world',
    type: 'select',
    options: [
      { label: 'Default Normal', value: 'minecraft:normal' },
      { label: 'Superflat', value: 'minecraft:flat' },
      { label: 'Large Biomes', value: 'minecraft:large_biomes' },
      { label: 'Amplified', value: 'minecraft:amplified' },
      { label: 'Single Biome', value: 'minecraft:single_biome_surface' },
    ],
    defaultValue: 'minecraft:normal',
  },
  'generate-structures': {
    label: 'Generate Structures',
    description: 'Generates structures like villages, temples, fortresses, and dungeons.',
    category: 'world',
    type: 'boolean',
    defaultValue: 'true',
  },
  'max-world-size': {
    label: 'Max World Size (Blocks)',
    description: 'Maximum radius in blocks from world center where blocks can be placed (up to 29,999,984).',
    category: 'world',
    type: 'number',
    defaultValue: '29999984',
  },
  'view-distance': {
    label: 'View Distance (Chunks)',
    description: 'Maximum distance in chunks sent to player clients (3 to 32 chunks).',
    category: 'performance',
    type: 'number',
    defaultValue: '10',
  },
  'simulation-distance': {
    label: 'Simulation Distance (Chunks)',
    description: 'Distance in chunks around players where entities and crops tick (3 to 32 chunks).',
    category: 'performance',
    type: 'number',
    defaultValue: '10',
  },
  'max-players': {
    label: 'Maximum Players',
    description: 'Maximum concurrent players allowed to connect.',
    category: 'performance',
    type: 'number',
    defaultValue: '20',
  },
  'max-tick-time': {
    label: 'Watchdog Max Tick Time (ms)',
    description: 'Maximum milliseconds a server tick may take before watchdog terminates (-1 to disable).',
    category: 'performance',
    type: 'number',
    defaultValue: '60000',
  },
  'network-compression-threshold': {
    label: 'Network Compression Threshold (Bytes)',
    description: 'Packet size threshold for compression. -1 disables, 256 is default.',
    category: 'performance',
    type: 'number',
    defaultValue: '256',
  },
  'entity-broadcast-range-percentage': {
    label: 'Entity Broadcast Range %',
    description: 'Percentage multiplier of render distance for entity data broadcast (10% to 1000%).',
    category: 'performance',
    type: 'number',
    defaultValue: '100',
  },
  'sync-chunk-writes': {
    label: 'Synchronous Chunk Writes',
    description: 'Performs synchronous file writes for chunk saves to prevent corruption on abrupt shutdowns.',
    category: 'performance',
    type: 'boolean',
    defaultValue: 'true',
  },
  'motd': {
    label: 'Message of the Day (MOTD)',
    description: 'Server description and tagline shown in player multiplayer server lists.',
    category: 'network',
    type: 'string',
    defaultValue: 'A VaultRealm Minecraft Server',
  },
  'server-port': {
    label: 'Server Game Port',
    description: 'Port that the Minecraft server listens on inside its network container.',
    category: 'network',
    type: 'number',
    defaultValue: '25565',
  },
  'enable-rcon': {
    label: 'Enable RCON Protocol',
    description: 'Enables remote console protocol for administrative commands and web console.',
    category: 'network',
    type: 'boolean',
    defaultValue: 'true',
  },
  'rate-limit': {
    label: 'Chat Packet Rate Limit',
    description: 'Kicks players who send packets faster than this rate limit (0 disables).',
    category: 'network',
    type: 'number',
    defaultValue: '0',
  },
  'rcon.password': {
    label: 'RCON Password',
    description: 'Administrative password used to connect to the server remote console.',
    category: 'security',
    type: 'string',
    defaultValue: '',
    isSecret: true,
  },
};

/**
 * Maps Minecraft server.properties keys to itzg/minecraft-server container environment variables.
 */
export const PROPERTY_TO_ENV_MAP: Record<string, string> = {
  'online-mode': 'ONLINE_MODE',
  'motd': 'MOTD',
  'difficulty': 'DIFFICULTY',
  'gamemode': 'MODE',
  'max-players': 'MAX_PLAYERS',
  'pvp': 'PVP',
  'spawn-protection': 'SPAWN_PROTECTION',
  'view-distance': 'VIEW_DISTANCE',
  'level-seed': 'SEED',
  'allow-nether': 'ALLOW_NETHER',
  'allow-flight': 'ALLOW_FLIGHT',
  'enable-command-block': 'ENABLE_COMMAND_BLOCK',
  'hardcore': 'HARDCORE',
  'spawn-animals': 'SPAWN_ANIMALS',
  'spawn-monsters': 'SPAWN_MONSTERS',
  'spawn-npcs': 'SPAWN_NPCS',
  'force-gamemode': 'FORCE_GAMEMODE',
  'player-idle-timeout': 'PLAYER_IDLE_TIMEOUT',
  'simulation-distance': 'SIMULATION_DISTANCE',
  'enforce-whitelist': 'ENFORCE_WHITELIST',
  'white-list': 'WHITE_LIST',
};

/**
 * Parses raw .properties file content into an ordered Map of key -> value.
 */
export function parsePropertiesFile(content: string): Map<string, string> {
  const result = new Map<string, string>();
  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) {
      continue;
    }

    const separatorIndex = line.search(/[=:]/);
    if (separatorIndex === -1) {
      // Key with empty value
      result.set(trimmed, '');
    } else {
      const key = line.slice(0, separatorIndex).trim();
      const rawValue = line.slice(separatorIndex + 1).trim();
      result.set(key, rawValue);
    }
  }

  return result;
}

/**
 * Serializes an ordered Map or record of key-values into standard .properties format.
 */
export function serializePropertiesFile(properties: Map<string, string>): string {
  const lines: string[] = [
    '# Minecraft server properties',
    '# Managed by VaultRealm Control Panel',
    `# Updated ${new Date().toISOString()}`,
    '',
  ];

  for (const [key, value] of properties.entries()) {
    lines.push(`${key}=${value}`);
  }

  return lines.join('\n') + '\n';
}

/**
 * Resolves the server.properties file path strictly within the server storage directory.
 */
export function getServerPropertiesPath(serverId: string): string {
  const serverDir = getServerDataDir(serverId);
  return safepath.resolve(serverDir, 'server.properties');
}

/**
 * Gets all properties for a server, creating default properties if the file does not exist yet.
 */
export async function getServerPropertiesData(serverId: string): Promise<ServerPropertiesResponse> {
  const detail = await getServerDetail(serverId);
  const isMinecraft = detail.templateId.startsWith('minecraft');
  const filePath = getServerPropertiesPath(serverId);

  let propertiesMap = new Map<string, string>();
  let rawContent = '';

  if (fs.existsSync(filePath)) {
    rawContent = fs.readFileSync(filePath, 'utf8');
    propertiesMap = parsePropertiesFile(rawContent);
  } else {
    // File not yet generated by container: seed with default Minecraft properties
    for (const [key, meta] of Object.entries(MINECRAFT_PROPERTIES_METADATA)) {
      propertiesMap.set(key, meta.defaultValue);
    }
    rawContent = serializePropertiesFile(propertiesMap);
  }

  // Ensure all known metadata keys are present or represented
  const items: ServerPropertyItem[] = [];

  // 1. Process known keys first in metadata order
  for (const [key, meta] of Object.entries(MINECRAFT_PROPERTIES_METADATA)) {
    const value = propertiesMap.get(key) ?? meta.defaultValue;
    const isModified = value !== meta.defaultValue;

    items.push({
      key,
      label: meta.label,
      description: meta.description,
      category: meta.category,
      type: meta.type,
      options: meta.options,
      defaultValue: meta.defaultValue,
      isSecret: meta.isSecret,
      value: meta.isSecret && value ? '••••••••' : value,
      isModified,
    });
  }

  // 2. Append any extra / custom / mod properties found in the file
  for (const [key, value] of propertiesMap.entries()) {
    if (!MINECRAFT_PROPERTIES_METADATA[key]) {
      items.push({
        key,
        label: key,
        description: 'Custom or addon-specific property in server.properties',
        category: 'custom',
        type: 'string',
        defaultValue: '',
        value,
        isModified: true,
      });
    }
  }

  return {
    templateId: detail.templateId,
    isMinecraft,
    serverStatus: detail.status,
    properties: items,
    rawContent,
  };
}

/**
 * Updates a single server property by key and synchronizes container environment if mapped.
 */
export async function updateServerProperty(
  serverId: string,
  key: string,
  value: string,
): Promise<{ success: boolean; key: string; value: string; requiresRestart: boolean }> {
  // Enforce safe property key name
  if (!/^[a-zA-Z0-9_.-]+$/.test(key)) {
    const error = new Error(`Invalid property key format: ${key}`) as Error & { statusCode: number; code: string };
    error.statusCode = 400;
    error.code = 'INVALID_PROPERTY_KEY';
    throw error;
  }

  const detail = await getServerDetail(serverId);
  const filePath = getServerPropertiesPath(serverId);

  let propertiesMap = new Map<string, string>();
  if (fs.existsSync(filePath)) {
    propertiesMap = parsePropertiesFile(fs.readFileSync(filePath, 'utf8'));
  } else {
    for (const [k, meta] of Object.entries(MINECRAFT_PROPERTIES_METADATA)) {
      propertiesMap.set(k, meta.defaultValue);
    }
  }

  // Update property in map
  propertiesMap.set(key, value);

  // Write updated properties to disk
  fs.writeFileSync(filePath, serializePropertiesFile(propertiesMap), 'utf8');

  // Synchronize matching environment variable in the database
  const mappedEnvKey = PROPERTY_TO_ENV_MAP[key];
  if (mappedEnvKey) {
    const db = getDatabase();
    const serverRecord = db.select({ envJson: servers.envJson }).from(servers).where(eq(servers.id, serverId)).all()[0];
    if (serverRecord) {
      try {
        const env = JSON.parse(serverRecord.envJson) as Record<string, string>;
        // Map boolean true/false to uppercase if standard in itzg
        env[mappedEnvKey] = value;
        db.update(servers)
          .set({ envJson: JSON.stringify(env) })
          .where(eq(servers.id, serverId))
          .run();
      } catch {
        // ignore JSON parse error
      }
    }
  }

  return {
    success: true,
    key,
    value,
    requiresRestart: detail.status === 'running',
  };
}

/**
 * Updates multiple server properties in batch or saves raw content.
 */
export async function updateServerPropertiesBatch(
  serverId: string,
  updates?: Record<string, string>,
  rawContent?: string,
): Promise<{ success: boolean; count: number; requiresRestart: boolean }> {
  const detail = await getServerDetail(serverId);
  const filePath = getServerPropertiesPath(serverId);

  let propertiesMap = new Map<string, string>();

  if (rawContent !== undefined) {
    propertiesMap = parsePropertiesFile(rawContent);
  } else {
    if (fs.existsSync(filePath)) {
      propertiesMap = parsePropertiesFile(fs.readFileSync(filePath, 'utf8'));
    } else {
      for (const [k, meta] of Object.entries(MINECRAFT_PROPERTIES_METADATA)) {
        propertiesMap.set(k, meta.defaultValue);
      }
    }

    if (updates) {
      for (const [key, val] of Object.entries(updates)) {
        if (/^[a-zA-Z0-9_.-]+$/.test(key)) {
          propertiesMap.set(key, val);
        }
      }
    }
  }

  // Write to disk
  fs.writeFileSync(filePath, serializePropertiesFile(propertiesMap), 'utf8');

  // Sync env in DB
  const db = getDatabase();
  const serverRecord = db.select({ envJson: servers.envJson }).from(servers).where(eq(servers.id, serverId)).all()[0];
  if (serverRecord) {
    try {
      const env = JSON.parse(serverRecord.envJson) as Record<string, string>;
      for (const [propKey, envKey] of Object.entries(PROPERTY_TO_ENV_MAP)) {
        if (propertiesMap.has(propKey)) {
          env[envKey] = propertiesMap.get(propKey)!;
        }
      }
      db.update(servers)
        .set({ envJson: JSON.stringify(env) })
        .where(eq(servers.id, serverId))
        .run();
    } catch {
      // ignore
    }
  }

  return {
    success: true,
    count: propertiesMap.size,
    requiresRestart: detail.status === 'running',
  };
}

/**
 * Configures the world spawn point.
 * Updates spawn-protection in server.properties and executes /setworldspawn if server is online.
 */
export async function setServerWorldSpawn(
  serverId: string,
  userId: string,
  x: number,
  y: number,
  z: number,
  angle?: number,
  spawnProtection?: number,
): Promise<{ success: boolean; message: string; commandExecuted: boolean }> {
  const detail = await getServerDetail(serverId);

  // If spawnProtection is provided, update spawn-protection in server.properties
  if (spawnProtection !== undefined) {
    await updateServerProperty(serverId, 'spawn-protection', String(Math.max(0, spawnProtection)));
  }

  const ix = Math.round(x);
  const iy = Math.round(y);
  const iz = Math.round(z);
  const spawnCommand = angle !== undefined
    ? `setworldspawn ${ix} ${iy} ${iz} ${Math.round(angle)}`
    : `setworldspawn ${ix} ${iy} ${iz}`;

  let commandExecuted = false;
  let commandOutput = '';

  if (detail.status === 'running') {
    try {
      const res = await executeServerCommand(serverId, userId, spawnCommand);
      commandExecuted = true;
      commandOutput = res.output;
    } catch (err) {
      console.warn(`[properties] Failed to execute setworldspawn command:`, err);
    }
  }

  return {
    success: true,
    message: commandExecuted
      ? `World spawn set to (${ix}, ${iy}, ${iz})${angle !== undefined ? ` with angle ${Math.round(angle)}°` : ''}. ${commandOutput}`
      : `Spawn configuration saved. When the server is online, run /${spawnCommand} or restart to take effect.`,
    commandExecuted,
  };
}

