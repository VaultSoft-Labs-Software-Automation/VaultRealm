import { describe, it, expect, vi } from 'vitest';
import { SkillExecutor } from '../src/skills/executor.js';

describe('SkillExecutor — Movement & Pathfinder Interop', () => {
  it('correctly sets GoalFollow using mineflayer-pathfinder goals', async () => {
    const mockSetGoal = vi.fn();
    const mockBot = {
      players: {
        BugFire: {
          entity: {
            position: {
              x: 10,
              y: 64,
              z: 20,
              offset: (dx: number, dy: number, dz: number) => ({ x: 10 + dx, y: 64 + dy, z: 20 + dz }),
            },
          },
        },
      },
      lookAt: vi.fn(),
      chat: vi.fn(),
      pathfinder: {
        setGoal: mockSetGoal,
        stop: vi.fn(),
      },
    };

    const executor = new SkillExecutor({
      bot: mockBot as any,
      speaker: 'BugFire',
    });

    const result = await executor.execute('follow', { player: 'BugFire', distance: 3 });

    expect(result.success).toBe(true);
    expect(result.message).toContain('Now following BugFire');
    expect(mockSetGoal).toHaveBeenCalledTimes(1);
    const goalArg = mockSetGoal.mock.calls[0][0];
    expect(goalArg).toBeDefined();
    // GoalFollow has entity and rangeSq properties
    expect(goalArg.entity).toBeDefined();
    expect(goalArg.rangeSq).toBe(9);
  });

  it('correctly sets GoalNear for come and goTo skills', async () => {
    const mockSetGoal = vi.fn();
    const mockBot = {
      players: {
        BugFire: {
          entity: {
            position: {
              x: 15,
              y: 65,
              z: 25,
            },
          },
        },
      },
      lookAt: vi.fn(),
      chat: vi.fn(),
      pathfinder: {
        setGoal: mockSetGoal,
        stop: vi.fn(),
      },
    };

    const executor = new SkillExecutor({
      bot: mockBot as any,
      speaker: 'BugFire',
    });

    const result = await executor.execute('come');

    expect(result.success).toBe(true);
    expect(result.message).toContain('Navigating to player "BugFire"');
    expect(mockSetGoal).toHaveBeenCalledTimes(1);
    const goalArg = mockSetGoal.mock.calls[0][0];
    expect(goalArg).toBeDefined();
    expect(goalArg.x).toBe(15);
    expect(goalArg.y).toBe(65);
    expect(goalArg.z).toBe(25);
  });
});
