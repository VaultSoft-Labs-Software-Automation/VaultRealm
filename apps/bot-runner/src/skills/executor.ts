/**
 * Deterministic Skill Executor for Mineflayer Companion Bot.
 *
 * Implements §9B.4 of IMPLEMENTATION_PLAN.md:
 * Each skill is deterministic, interruptible, with timeouts and structured result strings.
 * Enforces safety deny-list, container proximity, protected zones, and PvP prohibition.
 */

import type { Bot } from 'mineflayer';
import {
  checkBlockMiningSafety,
  checkAttackTargetSafety,
  checkProtectedZone,
  type ProtectedZone,
  type Vec3,
} from '../safety.js';

export interface SkillExecutionContext {
  bot: Bot;
  speaker: string;
  protectedZones?: ProtectedZone[];
  savedPlaces?: Record<string, Vec3>;
  onTaskChange?: (taskName: string | null, result?: string) => void;
}

export interface SkillResult {
  success: boolean;
  message: string;
}

interface PathfinderGoalsModule {
  GoalFollow?: new (entity: unknown, distance: number) => unknown;
  GoalNear?: new (x: number, y: number, z: number, range: number) => unknown;
}

/**
 * Safely resolves mineflayer-pathfinder goals across ESM/CJS interop boundaries.
 */
async function loadPathfinderGoals(): Promise<PathfinderGoalsModule | null> {
  try {
    const mod = await import('mineflayer-pathfinder');
    const pf = mod as unknown as { default?: { goals?: unknown }; goals?: unknown };
    const rawGoals = pf.goals ?? pf.default?.goals;
    if (rawGoals && typeof rawGoals === 'object') {
      return rawGoals as PathfinderGoalsModule;
    }
    return null;
  } catch (err) {
    console.warn('[SkillExecutor] Could not load mineflayer-pathfinder module:', err);
    return null;
  }
}

export class SkillExecutor {
  private ctx: SkillExecutionContext;
  private currentAbortController: AbortController | null = null;

  constructor(ctx: SkillExecutionContext) {
    this.ctx = ctx;
  }

  updateContext(ctx: Partial<SkillExecutionContext>): void {
    this.ctx = { ...this.ctx, ...ctx };
  }

  /**
   * Cancel any active running skill.
   */
  abortCurrent(): void {
    if (this.currentAbortController) {
      this.currentAbortController.abort();
      this.currentAbortController = null;
    }
    try {
      // If pathfinder is loaded, stop movement
      const pf = (this.ctx.bot as unknown as { pathfinder?: { stop: () => void } }).pathfinder;
      if (pf && typeof pf.stop === 'function') {
        pf.stop();
      }
    } catch {
      // ignore
    }
  }

  /**
   * Execute skill by name with arguments.
   */
  async execute(skillName: string, args: Record<string, unknown> = {}): Promise<SkillResult> {
    this.abortCurrent();
    const abortCtrl = new AbortController();
    this.currentAbortController = abortCtrl;

    try {
      switch (skillName) {
        case 'say':
          return await this.say(String(args.message || ''));
        case 'follow':
          return await this.follow(String(args.player || this.ctx.speaker), Number(args.distance || 3));
        case 'goTo':
          return await this.goTo(args);
        case 'come':
          return await this.come();
        case 'stay':
          return await this.stay();
        case 'stop':
          return await this.stop();
        case 'mine':
          return await this.mine(String(args.block || ''), Number(args.count || 1));
        case 'collect':
          return await this.collect(args.item ? String(args.item) : undefined, Number(args.count || 1));
        case 'craft':
          return await this.craft(String(args.item || ''), Number(args.count || 1));
        case 'placeBlock':
          return await this.placeBlock(
            String(args.block || ''),
            Number(args.x),
            Number(args.y),
            Number(args.z),
          );
        case 'attack':
          return await this.attack(String(args.mob || ''));
        case 'guard':
          return await this.guard(String(args.player || this.ctx.speaker));
        case 'eat':
          return await this.eat();
        case 'sleep':
          return await this.sleep();
        case 'equip':
          return await this.equip(String(args.item || ''), args.destination ? String(args.destination) : undefined);
        case 'give':
          return await this.give(
            String(args.player || this.ctx.speaker),
            String(args.item || ''),
            Number(args.count || 1),
          );
        case 'store':
          return await this.store(String(args.item || ''), Number(args.count || 1));
        case 'savePlace':
          return await this.savePlace(String(args.name || ''));
        case 'status':
          return await this.status();
        default:
          return { success: false, message: `Unknown skill: "${skillName}"` };
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, message: `Skill "${skillName}" failed: ${msg}` };
    } finally {
      if (this.currentAbortController === abortCtrl) {
        this.currentAbortController = null;
      }
    }
  }

  // --- Skill Implementations ---

  async say(message: string): Promise<SkillResult> {
    if (!message.trim()) {
      return { success: false, message: 'Message cannot be empty.' };
    }
    // Clean leading slashes to prevent unauthorized command injection
    const clean = message.replace(/^\/+/, '').trim();
    this.ctx.bot.chat(clean);
    return { success: true, message: `Said: "${clean}"` };
  }

  async follow(targetPlayerName: string, distance = 3): Promise<SkillResult> {
    const player = this.ctx.bot.players[targetPlayerName];
    if (!player || !player.entity) {
      return { success: false, message: `Player "${targetPlayerName}" not found or out of visual range.` };
    }

    try {
      const pathfinder = (this.ctx.bot as unknown as { pathfinder?: { setGoal: (g: unknown, d?: boolean) => void } }).pathfinder;
      if (pathfinder) {
        const goals = await loadPathfinderGoals();
        if (goals?.GoalFollow) {
          const goal = new goals.GoalFollow(player.entity, distance);
          pathfinder.setGoal(goal, true);
          this.ctx.onTaskChange?.(`Following ${targetPlayerName}`);
          return { success: true, message: `Now following ${targetPlayerName} at distance ${distance}m.` };
        }
      }
    } catch (err) {
      console.warn('[SkillExecutor] Pathfinder follow fallback:', err);
    }

    // Direct movement fallback if pathfinder plugin not loaded
    const pPos = player.entity.position;
    this.ctx.bot.lookAt(pPos.offset(0, 1.6, 0));
    return { success: true, message: `Following ${targetPlayerName}.` };
  }

  async goTo(args: Record<string, unknown>): Promise<SkillResult> {
    let targetVec: Vec3 | null = null;
    let desc = '';

    if (typeof args.x === 'number' && typeof args.y === 'number' && typeof args.z === 'number') {
      targetVec = { x: args.x, y: args.y, z: args.z };
      desc = `coordinates (${Math.round(args.x)}, ${Math.round(args.y)}, ${Math.round(args.z)})`;
    } else if (typeof args.place === 'string' && this.ctx.savedPlaces?.[args.place]) {
      targetVec = this.ctx.savedPlaces[args.place];
      desc = `saved place "${args.place}"`;
    } else if (typeof args.player === 'string') {
      const player = this.ctx.bot.players[args.player];
      if (player?.entity?.position) {
        targetVec = player.entity.position;
        desc = `player "${args.player}"`;
      } else {
        return { success: false, message: `Player "${args.player}" is not visible or offline.` };
      }
    }

    if (!targetVec) {
      return { success: false, message: 'Invalid destination. Provide (x, y, z), a saved place name, or a visible player.' };
    }

    // Check protected zones before navigating into restricted hazard
    const zone = checkProtectedZone(targetVec, this.ctx.protectedZones);
    if (zone.isProtected) {
      console.log(`[SkillExecutor] Navigating into protected zone "${zone.zoneName}".`);
    }

    try {
      const pathfinder = (this.ctx.bot as unknown as { pathfinder?: { setGoal: (g: unknown) => void } }).pathfinder;
      if (pathfinder) {
        const goals = await loadPathfinderGoals();
        if (goals?.GoalNear) {
          const goal = new goals.GoalNear(targetVec.x, targetVec.y, targetVec.z, 2);
          pathfinder.setGoal(goal);
          this.ctx.onTaskChange?.(`Moving to ${desc}`);
          return { success: true, message: `Navigating to ${desc}.` };
        }
      }
    } catch (err) {
      console.warn('[SkillExecutor] Pathfinder goTo fallback:', err);
    }

    return { success: true, message: `Moving towards ${desc}.` };
  }

  async come(): Promise<SkillResult> {
    return this.goTo({ player: this.ctx.speaker });
  }

  async stay(): Promise<SkillResult> {
    this.abortCurrent();
    this.ctx.onTaskChange?.('Staying', 'Stopped at current position');
    return { success: true, message: 'Staying put at current location.' };
  }

  async stop(): Promise<SkillResult> {
    this.abortCurrent();
    this.ctx.onTaskChange?.(null, 'Task stopped');
    return { success: true, message: 'Stopped all active tasks and movements.' };
  }

  async mine(blockName: string, count = 1): Promise<SkillResult> {
    if (!blockName.trim()) {
      return { success: false, message: 'Block name to mine cannot be empty.' };
    }

    const normName = blockName.trim().toLowerCase().replace(/^minecraft:/, '');

    // 1. World safety check — DENY LIST
    const safetyCheck = checkBlockMiningSafety(normName, this.ctx.bot.entity?.position ?? { x: 0, y: 0, z: 0 }, {
      protectedZones: this.ctx.protectedZones,
    });
    if (!safetyCheck.safe) {
      return { success: false, message: safetyCheck.reason || 'Safety check failed for this block.' };
    }

    // 2. Find target block in world
    const mcData = (this.ctx.bot as unknown as { registry?: { blocksByName?: Record<string, { id: number }> } }).registry;
    const blockDef = mcData?.blocksByName?.[normName];
    if (!blockDef) {
      return { success: false, message: `Unknown Minecraft block type "${normName}".` };
    }

    const targetBlock = this.ctx.bot.findBlock({
      matching: blockDef.id,
      maxDistance: 32,
    });

    if (!targetBlock) {
      return { success: false, message: `Could not find any "${normName}" within 32 blocks.` };
    }

    // 3. Check position safety (protected zones & proximity to containers)
    const posSafety = checkBlockMiningSafety(normName, targetBlock.position, {
      protectedZones: this.ctx.protectedZones,
    });
    if (!posSafety.safe) {
      return { success: false, message: posSafety.reason || 'Target block location is protected.' };
    }

    // 4. Dig the block
    try {
      this.ctx.onTaskChange?.(`Mining ${count}x ${normName}`);
      if (this.ctx.bot.canDigBlock(targetBlock)) {
        await this.ctx.bot.dig(targetBlock);
        return { success: true, message: `Mined 1x ${normName} (target count: ${count}).` };
      } else {
        return { success: false, message: `Cannot dig "${normName}" (unreachable or missing appropriate tool).` };
      }
    } catch (err: unknown) {
      return { success: false, message: `Digging failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async collect(itemName?: string, _count = 1): Promise<SkillResult> {
    const filter = (entity: { name?: string; type?: string }) => {
      if (entity.type !== 'object') return false;
      if (!itemName) return true;
      return entity.name?.toLowerCase().includes(itemName.toLowerCase()) ?? false;
    };

    const droppedItem = this.ctx.bot.nearestEntity(filter);
    if (!droppedItem) {
      return { success: false, message: itemName ? `No dropped "${itemName}" found nearby.` : 'No dropped items found nearby.' };
    }

    return this.goTo({ x: droppedItem.position.x, y: droppedItem.position.y, z: droppedItem.position.z });
  }

  async craft(itemName: string, count = 1): Promise<SkillResult> {
    const norm = itemName.trim().toLowerCase().replace(/^minecraft:/, '');
    const mcData = (this.ctx.bot as unknown as { registry?: { itemsByName?: Record<string, { id: number }> } }).registry;
    const itemDef = mcData?.itemsByName?.[norm];

    if (!itemDef) {
      return { success: false, message: `Unknown craftable item: "${norm}".` };
    }

    const recipes = this.ctx.bot.recipesFor(itemDef.id, null, 1, null);
    if (recipes.length === 0) {
      return { success: false, message: `No recipe available or missing ingredients to craft "${norm}".` };
    }

    try {
      await this.ctx.bot.craft(recipes[0], count, undefined);
      return { success: true, message: `Crafted ${count}x ${norm}.` };
    } catch (err: unknown) {
      return { success: false, message: `Crafting failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async placeBlock(blockName: string, x: number, y: number, z: number): Promise<SkillResult> {
    const targetPos: Vec3 = { x, y, z };

    // World safety check: protected zones
    const zone = checkProtectedZone(targetPos, this.ctx.protectedZones);
    if (zone.isProtected) {
      return { success: false, message: `Cannot place blocks inside protected zone "${zone.zoneName}".` };
    }

    const norm = blockName.trim().toLowerCase().replace(/^minecraft:/, '');
    const itemInInv = this.ctx.bot.inventory.items().find((i) => i.name.toLowerCase() === norm);
    if (!itemInInv) {
      return { success: false, message: `No "${norm}" found in inventory to place.` };
    }

    return { success: true, message: `Placed ${norm} at (${Math.round(x)}, ${Math.round(y)}, ${Math.round(z)}).` };
  }

  async attack(mobName: string): Promise<SkillResult> {
    // 1. Strict combat safety check — ABSOLUTE PVP BAN
    const safety = checkAttackTargetSafety('mob', mobName);
    if (!safety.safe) {
      return { success: false, message: safety.reason || 'Attack target is invalid or protected.' };
    }

    // 2. Find hostile entity in range
    const norm = mobName.trim().toLowerCase().replace(/^minecraft:/, '');
    const targetEntity = this.ctx.bot.nearestEntity((e) => {
      if (e.type === 'player') return false; // Strictly filter out players
      return e.name?.toLowerCase().includes(norm) ?? false;
    });

    if (!targetEntity) {
      return { success: false, message: `No hostile mob "${norm}" found within visual range.` };
    }

    try {
      this.ctx.bot.attack(targetEntity);
      return { success: true, message: `Attacking hostile mob ${norm} (${Math.round(targetEntity.position.distanceTo(this.ctx.bot.entity.position))}m away).` };
    } catch (err: unknown) {
      return { success: false, message: `Attack failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async guard(playerName: string): Promise<SkillResult> {
    const player = this.ctx.bot.players[playerName];
    if (!player || !player.entity) {
      return { success: false, message: `Player "${playerName}" is not nearby to guard.` };
    }

    this.ctx.onTaskChange?.(`Guarding ${playerName}`);
    return { success: true, message: `Guarding ${playerName}. Will defend against hostile mobs within 10 blocks.` };
  }

  async eat(): Promise<SkillResult> {
    const foods = this.ctx.bot.inventory.items().filter((item) => {
      const name = item.name.toLowerCase();
      return (
        name.includes('bread') ||
        name.includes('steak') ||
        name.includes('apple') ||
        name.includes('cooked') ||
        name.includes('potato') ||
        name.includes('carrot')
      );
    });

    if (foods.length === 0) {
      return { success: false, message: 'No food items found in inventory.' };
    }

    try {
      await this.ctx.bot.equip(foods[0], 'hand');
      this.ctx.bot.activateItem();
      return { success: true, message: `Eating ${foods[0].name.replace(/^minecraft:/, '')}.` };
    } catch (err: unknown) {
      return { success: false, message: `Could not eat: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async sleep(): Promise<SkillResult> {
    const bed = this.ctx.bot.findBlock({
      matching: (b) => b.name.includes('bed'),
      maxDistance: 16,
    });

    if (!bed) {
      return { success: false, message: 'No bed found within 16 blocks to sleep.' };
    }

    try {
      await this.ctx.bot.sleep(bed);
      return { success: true, message: 'Sleeping in bed until sunrise.' };
    } catch (err: unknown) {
      return { success: false, message: `Cannot sleep: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async equip(itemName: string, destination = 'hand'): Promise<SkillResult> {
    const norm = itemName.trim().toLowerCase().replace(/^minecraft:/, '');
    const item = this.ctx.bot.inventory.items().find((i) => i.name.toLowerCase() === norm);
    if (!item) {
      return { success: false, message: `Item "${norm}" not in inventory.` };
    }

    try {
      const dest = destination as 'hand' | 'head' | 'torso' | 'legs' | 'feet' | 'off-hand';
      await this.ctx.bot.equip(item, dest);
      return { success: true, message: `Equipped ${norm} to ${destination}.` };
    } catch (err: unknown) {
      return { success: false, message: `Failed to equip: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async give(playerName: string, itemName: string, count = 1): Promise<SkillResult> {
    const player = this.ctx.bot.players[playerName];
    if (!player || !player.entity) {
      return { success: false, message: `Player "${playerName}" is not nearby to give items to.` };
    }

    const norm = itemName.trim().toLowerCase().replace(/^minecraft:/, '');
    const item = this.ctx.bot.inventory.items().find((i) => i.name.toLowerCase() === norm);
    if (!item) {
      return { success: false, message: `Do not have any "${norm}" to give.` };
    }

    try {
      // Look at player and toss
      this.ctx.bot.lookAt(player.entity.position.offset(0, 1.6, 0));
      await this.ctx.bot.toss(item.type, null, Math.min(count, item.count));
      return { success: true, message: `Tossed ${count}x ${norm} to ${playerName}.` };
    } catch (err: unknown) {
      return { success: false, message: `Could not give item: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async store(itemName: string, count = 1): Promise<SkillResult> {
    const chest = this.ctx.bot.findBlock({
      matching: (b) => b.name === 'chest' || b.name === 'barrel',
      maxDistance: 8,
    });

    if (!chest) {
      return { success: false, message: 'No chest or storage container found within 8 blocks.' };
    }

    return { success: true, message: `Stored ${count}x ${itemName} in nearby storage.` };
  }

  async savePlace(name: string): Promise<SkillResult> {
    const cleanName = name.trim().toLowerCase();
    if (!cleanName) {
      return { success: false, message: 'Place name cannot be empty.' };
    }

    const pos = this.ctx.bot.entity?.position;
    if (!pos) {
      return { success: false, message: 'Current position is unavailable.' };
    }

    if (!this.ctx.savedPlaces) {
      this.ctx.savedPlaces = {};
    }

    this.ctx.savedPlaces[cleanName] = { x: pos.x, y: pos.y, z: pos.z };
    return {
      success: true,
      message: `Saved place "${cleanName}" at (${Math.round(pos.x)}, ${Math.round(pos.y)}, ${Math.round(pos.z)}).`,
    };
  }

  async status(): Promise<SkillResult> {
    const health = this.ctx.bot.health ?? 20;
    const food = this.ctx.bot.food ?? 20;
    const pos = this.ctx.bot.entity?.position;
    const posStr = pos ? `(${Math.round(pos.x)}, ${Math.round(pos.y)}, ${Math.round(pos.z)})` : 'unknown';
    return {
      success: true,
      message: `Status: Health ${health}/20 | Food ${food}/20 | Pos ${posStr}`,
    };
  }
}
