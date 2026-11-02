/**
 * Mineflayer Bot Lifecycle and Event Loop.
 *
 * Implements §9B.4 & §9B.5 of IMPLEMENTATION_PLAN.md:
 * - Bot connection & lifecycle
 * - Pathfinder plugin loading (if available)
 * - Addressing check (unaddressed chat produces 0 LLM calls)
 * - Fast commands (!help, !stop, !come, !stay, !status)
 * - Multi-step agent loop with skill execution, world safety, and code-enforced permissions
 * - Death & respawn handling
 */

import mineflayer from 'mineflayer';
import type { BotConfig } from './types.js';
import {
  isAddressedToBot,
  handleFastCommand,
  checkPlayerRateLimit,
} from './chat.js';
import { GatewayClient } from './gateway-client.js';
import { SkillExecutor } from './skills/executor.js';
import { runAgentTurn } from './agent-loop.js';
import {
  buildPerceptionSnapshot,
  type EntitySummary,
  type BlockSummary,
} from './perception.js';
import { resolveTargetHost } from './dns-fallback.js';
import { getPlayerRole, canPlayerExecuteSkill } from './permissions.js';

export class CompanionBotRunner {
  private config: BotConfig;
  private bot: mineflayer.Bot | null = null;
  private gatewayClient: GatewayClient;
  private executor: SkillExecutor | null = null;
  private isRunning = false;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private currentTask: string | null = null;
  private lastActionResult: string | null = null;
  private recentChat: Array<{ username: string; message: string }> = [];

  constructor(config: BotConfig) {
    this.config = config;
    this.gatewayClient = new GatewayClient(config.panelGatewayUrl, config.botToken);
  }

  /**
   * Start the bot and initiate connection.
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.connect();
  }

  /**
   * Stop the bot and disconnect cleanly.
   */
  stop(): void {
    this.isRunning = false;
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.executor) {
      this.executor.abortCurrent();
      this.executor = null;
    }
    if (this.bot) {
      this.bot.quit();
      this.bot = null;
    }
    console.log(`[BotRunner] Bot "${this.config.botName}" stopped.`);
  }

  private async connect(): Promise<void> {
    if (!this.isRunning) return;

    let targetHost = this.config.serverHost;
    try {
      targetHost = await resolveTargetHost(this.config.serverHost);
    } catch (err) {
      console.warn(`[BotRunner] Error resolving target host "${this.config.serverHost}":`, err);
    }

    console.log(
      `[BotRunner] Connecting to ${targetHost}:${this.config.serverPort} as "${this.config.botName}" (auth: ${this.config.authMode})...`,
    );

    try {
      this.bot = mineflayer.createBot({
        host: targetHost,
        port: this.config.serverPort,
        username: this.config.botName,
        auth: this.config.authMode === 'offline' ? 'offline' : 'microsoft',
        version: this.config.minecraftVersion || undefined,
      });

      this.setupEventHandlers(this.bot);
    } catch (err) {
      console.error('[BotRunner] Failed to initialize mineflayer bot:', err);
      this.scheduleReconnect();
    }
  }

  private setupEventHandlers(bot: mineflayer.Bot): void {
    bot.on('error', (err: Error) => {
      console.error(`[BotRunner] Connection error: ${err.message}`);
    });

    bot.on('spawn', async () => {
      console.log(`[BotRunner] "${this.config.botName}" successfully spawned into the game!`);

      // Initialize pathfinder plugin if available
      try {
        const pfMod = await import('mineflayer-pathfinder');
        const pf = pfMod as unknown as { default?: { pathfinder?: unknown }; pathfinder?: unknown };
        const pathfinderPlugin = pf.pathfinder ?? pf.default?.pathfinder ?? pf.default;
        if (typeof bot.loadPlugin === 'function' && typeof pathfinderPlugin === 'function') {
          bot.loadPlugin(pathfinderPlugin as unknown as mineflayer.Plugin);
        }
      } catch (err) {
        console.warn('[BotRunner] Could not load mineflayer-pathfinder plugin:', err);
      }

      // Initialize skill executor
      this.executor = new SkillExecutor({
        bot,
        speaker: this.config.ownerName ?? 'admin',
        protectedZones: this.config.protectedZones,
        savedPlaces: this.config.savedPlaces,
        onTaskChange: (task, result) => {
          this.currentTask = task;
          if (result) this.lastActionResult = result;
        },
      });

      // Announce spawn (§9B.6: "Buddy here! Say 'Buddy, help'")
      setTimeout(() => {
        try {
          bot.chat(`${this.config.botName} here! Say "${this.config.botName}, help" or talk to me directly.`);
        } catch {
          // ignore chat error on initial spawn
        }
      }, 1500);
    });

    // Public chat listener
    bot.on('chat', (username: string, message: string) => {
      this.recordChat(username, message);
      this.handleIncomingChat(username, message, false);
    });

    // Private whisper listener
    bot.on('whisper', (username: string, message: string) => {
      this.recordChat(username, message);
      this.handleIncomingChat(username, message, true);
    });

    // Death handler (§9B.4: "on death it respawns and announces it")
    bot.on('death', () => {
      console.warn(`[BotRunner] "${this.config.botName}" died.`);
      this.currentTask = null;
      this.lastActionResult = 'Died in combat or hazard';
      setTimeout(() => {
        try {
          bot.chat(`I died! Respawning now...`);
        } catch {
          // ignore
        }
      }, 1000);
    });

    bot.on('kicked', (reason: unknown) => {
      const reasonStr = typeof reason === 'object' ? JSON.stringify(reason) : String(reason);
      console.warn(`[BotRunner] Bot was kicked: ${reasonStr}`);
      if (reasonStr.includes('unverified_username')) {
        console.warn(
          '[BotRunner] ⚠️ Authentication Error: The server has "online-mode=true". ' +
            'Because Buddy is in offline mode, set "online-mode = false" in the server "Properties" tab and restart the server, or switch Buddy to Microsoft authentication.',
        );
      }
      this.scheduleReconnect();
    });

    bot.on('end', (reason?: unknown) => {
      const reasonStr = reason ? ` (${typeof reason === 'object' ? JSON.stringify(reason) : String(reason)})` : '';
      console.log(`[BotRunner] Connection ended${reasonStr}.`);
      if (this.isRunning) {
        this.scheduleReconnect();
      }
    });
  }

  private recordChat(username: string, message: string): void {
    this.recentChat.push({ username, message });
    if (this.recentChat.length > 20) {
      this.recentChat.shift();
    }
  }

  private async handleIncomingChat(
    username: string,
    message: string,
    isWhisper: boolean,
  ): Promise<void> {
    if (!this.bot || !this.executor) return;

    // Never respond to own messages
    if (username === this.config.botName || username === this.bot.username) {
      return;
    }

    // 1. Addressing Check (§9B.5): Unaddressed messages produce ZERO LLM calls
    const { addressed, content } = isAddressedToBot(message, this.config.botName, isWhisper);
    if (!addressed) {
      return;
    }

    console.log(`[BotRunner] Addressed chat from "${username}": "${content}"`);

    // 2. Fast Commands (instant, zero LLM, work even if LLM is offline)
    const statusSnapshot = this.getStatusSnapshot();
    const fastCmd = handleFastCommand(content, this.config.botName, statusSnapshot);
    if (fastCmd.isFastCommand) {
      if (fastCmd.command && fastCmd.command !== 'help') {
        const role = getPlayerRole(
          username,
          this.config.ownerName ?? 'admin',
          this.config.trustedPlayers ?? [],
        );
        const policy = this.config.whoCanCommand ?? 'everyone';
        const auth = canPlayerExecuteSkill(role, policy, fastCmd.command);
        if (!auth.allowed) {
          this.bot.chat(`[${this.config.botName}] ${auth.reason || 'Sorry, you do not have permission to use that command.'}`);
          return;
        }
      }

      this.executor.updateContext({
        speaker: username,
        protectedZones: this.config.protectedZones,
        savedPlaces: this.config.savedPlaces,
      });

      if (fastCmd.command === 'stop') {
        this.executor.abortCurrent();
      } else if (fastCmd.command === 'come') {
        void this.executor.come();
      } else if (fastCmd.command === 'follow') {
        void this.executor.follow(username);
      } else if (fastCmd.command === 'stay') {
        void this.executor.stay();
      }

      if (fastCmd.reply) {
        this.bot.chat(fastCmd.reply);
      }
      return;
    }

    // 3. Player Rate Limit (1 message per 2 seconds per player)
    if (!checkPlayerRateLimit(username)) {
      this.bot.chat(`[${this.config.botName}] Please wait a moment before sending another message.`);
      return;
    }

    // 4. Update executor context with current speaker
    this.executor.updateContext({
      speaker: username,
      protectedZones: this.config.protectedZones,
      savedPlaces: this.config.savedPlaces,
    });

    // 5. Build rich perception snapshot
    const perception = this.generatePerceptionSnapshot();

    // 6. Execute multi-step Agent Loop with code-enforced permissions & safety
    try {
      await runAgentTurn({
        speaker: username,
        userMessage: content,
        config: this.config,
        perceptionSnapshot: perception,
        gatewayClient: this.gatewayClient,
        executor: this.executor,
        onSay: (reply) => {
          if (this.bot) {
            this.bot.chat(reply);
          }
        },
      });
    } catch (err: unknown) {
      let errMsg = err instanceof Error ? err.message : 'Error communicating with AI gateway';
      if (errMsg.includes('Could not decrypt API key') || errMsg.includes('KEY_DECRYPT_ERROR')) {
        errMsg = 'My API key could not be decrypted. Please re-enter the API key in the Companion settings.';
      }
      console.error('[BotRunner] Agent loop error:', errMsg);
      this.bot.chat(`[${this.config.botName}] Sorry, I encountered an error: ${errMsg}`);
    }
  }

  private generatePerceptionSnapshot(): string {
    if (!this.bot) return 'Bot is offline.';

    const pos = this.bot.entity?.position ?? { x: 0, y: 0, z: 0 };
    const health = this.bot.health ?? 20;
    const food = this.bot.food ?? 20;

    // Scan nearby players (≤16 blocks)
    const nearbyPlayers: EntitySummary[] = [];
    if (this.bot.players) {
      for (const [pName, pData] of Object.entries(this.bot.players)) {
        if (pName !== this.bot.username && pData?.entity?.position) {
          const dist = pData.entity.position.distanceTo(this.bot.entity.position);
          if (dist <= 16) {
            nearbyPlayers.push({
              name: pName,
              type: 'player',
              distance: dist,
              heldItem: pData.entity.heldItem?.name,
            });
          }
        }
      }
    }

    // Scan nearby entities/mobs (≤16 blocks)
    const nearbyMobs: EntitySummary[] = [];
    if (this.bot.entities) {
      for (const entity of Object.values(this.bot.entities)) {
        if (
          entity &&
          entity !== this.bot.entity &&
          entity.type === 'mob' &&
          entity.position
        ) {
          const dist = entity.position.distanceTo(this.bot.entity.position);
          if (dist <= 16) {
            nearbyMobs.push({
              name: entity.name ?? 'unknown_mob',
              type: 'mob',
              distance: dist,
            });
          }
        }
      }
    }

    // Scan inventory items
    const inventory = (this.bot.inventory?.items() ?? []).map((item) => ({
      name: item.name,
      count: item.count,
    }));

    // Notable blocks (stub/scan)
    const notableBlocks: BlockSummary[] = [];

    return buildPerceptionSnapshot({
      botName: this.config.botName,
      position: { x: pos.x, y: pos.y, z: pos.z },
      health,
      food,
      inventory,
      nearbyPlayers,
      nearbyMobs,
      notableBlocks,
      currentTask: this.currentTask,
      lastActionResult: this.lastActionResult,
      savedPlaces: this.config.savedPlaces,
      recentChat: this.recentChat,
    });
  }

  private getStatusSnapshot(): string {
    if (!this.bot) return 'Offline';
    const health = this.bot.health ?? 20;
    const food = this.bot.food ?? 20;
    const pos = this.bot.entity?.position;
    const coords = pos ? `(${Math.round(pos.x)}, ${Math.round(pos.y)}, ${Math.round(pos.z)})` : 'unknown';
    return `Health: ${health}/20 | Food: ${food}/20 | Pos: ${coords}`;
  }

  private scheduleReconnect(): void {
    if (!this.isRunning || this.reconnectTimeout) return;
    console.log('[BotRunner] Reconnecting in 10 seconds...');
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      if (this.isRunning) {
        this.connect();
      }
    }, 10000);
  }
}
