/**
 * Version Compatibility Shim for bleeding-edge Minecraft releases.
 *
 * When Mojang publishes new minor releases or snapshots (e.g. 26.2, 26.3, 26.4),
 * the protocol version is updated in protocolVersions.json, but PrismarineJS /
 * minecraft-data may not yet have a matching data directory on disk.
 *
 * This shim dynamically supplies protocol and registry definitions for 26.x
 * releases by proxying minecraft-data's internal data.js and dataPaths.json,
 * falling back to the 26.1 / latest 1.21 base definition while preserving the
 * exact protocol version number expected by the Minecraft protocol serializer.
 */

import { createRequire } from 'module';

export function setupVersionCompatibility(): void {
  try {
    const require = createRequire(import.meta.url);
    const mineflayerPath = require.resolve('mineflayer');
    const req = (name: string) => require(require.resolve(name, { paths: [mineflayerPath] }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mcData = req('minecraft-data') as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dataJs = req('minecraft-data/data.js') as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dataPaths = req('minecraft-data/minecraft-data/data/dataPaths.json') as any;

    if (!dataJs?.pc || !mcData?.versionsByMinecraftVersion?.pc) {
      return;
    }

    const baseData = dataJs.pc['26.1'] || dataJs.pc['1.21.4'] || dataJs.pc['1.21.1'];
    const basePaths = dataPaths?.pc ? (dataPaths.pc['26.1'] || dataPaths.pc['1.21.4'] || dataPaths.pc['1.21.1']) : null;

    if (!baseData) return;

    const pcVersions = mcData.versionsByMinecraftVersion.pc;

    // Dynamically patch Proxy over dataJs.pc
    const origDataPc = dataJs.pc;
    dataJs.pc = new Proxy(origDataPc, {
      get(target: Record<string, unknown>, prop: string | symbol) {
        if (typeof prop === 'string' && !target[prop]) {
          if (prop.startsWith('26.') || prop.startsWith('1.21.')) {
            const vInfo = pcVersions[prop];
            const protoVer = vInfo?.version ?? (baseData.version?.version ?? 777);

            return {
              ...baseData,
              get version() {
                return {
                  ...(baseData.version || {}),
                  version: protoVer,
                  minecraftVersion: prop,
                  majorVersion: prop,
                };
              },
            };
          }
        }
        return target[prop as string];
      },
    });

    // Dynamically patch Proxy over dataPaths.pc
    if (dataPaths?.pc && basePaths) {
      const origPathsPc = dataPaths.pc;
      dataPaths.pc = new Proxy(origPathsPc, {
        get(target: Record<string, unknown>, prop: string | symbol) {
          if (typeof prop === 'string' && !target[prop]) {
            if (prop.startsWith('26.') || prop.startsWith('1.21.')) {
              return basePaths;
            }
          }
          return target[prop as string];
        },
      });
    }

    // Ensure known 26.x versions are registered in pcVersions & supportedVersions
    const extraVersions = ['26.2', '26.3', '26.4', '26.5', '26.6'];
    for (const v of extraVersions) {
      if (!pcVersions[v]) {
        pcVersions[v] = {
          minecraftVersion: v,
          version: 777,
          dataVersion: 5023,
          usesNetty: true,
          majorVersion: v,
          releaseType: 'release',
        };
      }
      if (Array.isArray(mcData.supportedVersions?.pc) && !mcData.supportedVersions.pc.includes(v)) {
        mcData.supportedVersions.pc.push(v);
      }
    }

    console.log('[BotRunner] Minecraft version compatibility shim initialized (dynamic 26.x fallback active).');
  } catch (err) {
    console.warn(
      '[BotRunner] Note: minecraft-data version shim skipped:',
      err instanceof Error ? err.message : String(err),
    );
  }
}
