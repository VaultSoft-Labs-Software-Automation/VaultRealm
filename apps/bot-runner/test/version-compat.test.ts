import { describe, it, expect, beforeAll } from 'vitest';
import { setupVersionCompatibility } from '../src/version-compat.js';
import { createRequire } from 'module';

describe('setupVersionCompatibility', () => {
  beforeAll(() => {
    setupVersionCompatibility();
  });

  it('runs without throwing errors', () => {
    expect(() => setupVersionCompatibility()).not.toThrow();
  });

  it('resolves bleeding-edge 26.x versions via minecraft-data', () => {
    const require = createRequire(import.meta.url);
    const mineflayerPath = require.resolve('mineflayer');
    const req = (name: string) => require(require.resolve(name, { paths: [mineflayerPath] }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mcData = req('minecraft-data') as any;

    const data26_3 = mcData('26.3');
    expect(data26_3).toBeDefined();
    expect(data26_3.version).toBeDefined();
    expect(data26_3.version.version).toBe(777);
  });
});

