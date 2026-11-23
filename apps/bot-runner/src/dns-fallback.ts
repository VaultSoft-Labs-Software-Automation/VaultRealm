/**
 * DNS & Host Gateway Fallback Resolver for Docker Container Networking.
 *
 * Automatically resolves 'host.docker.internal' and 'localhost' to the host
 * gateway IP (e.g. 172.17.0.1) in Linux Docker environments where Docker Engine
 * does not populate host.docker.internal in /etc/hosts by default.
 */

import dns from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';

/**
 * Discovers the Docker bridge gateway IP by inspecting Linux /proc/net/route
 * or checking container environment markers.
 */
export function discoverDockerGateway(): string | null {
  try {
    if (fs.existsSync('/proc/net/route')) {
      const content = fs.readFileSync('/proc/net/route', 'utf8');
      const lines = content.trim().split('\n');
      for (const line of lines.slice(1)) {
        const parts = line.trim().split(/\s+/);
        // Column 1 is Destination ('00000000' is default gateway), Column 2 is Gateway hex
        if (parts[1] === '00000000' && parts[2] && parts[2] !== '00000000') {
          const hex = parts[2];
          if (hex.length === 8) {
            // Hex in /proc/net/route is formatted in little-endian byte order
            const b0 = parseInt(hex.slice(6, 8), 16);
            const b1 = parseInt(hex.slice(4, 6), 16);
            const b2 = parseInt(hex.slice(2, 4), 16);
            const b3 = parseInt(hex.slice(0, 2), 16);
            const ip = `${b0}.${b1}.${b2}.${b3}`;
            if (ip !== '0.0.0.0') {
              return ip;
            }
          }
        }
      }
    }
  } catch {
    // /proc/net/route unavailable or unreadable
  }

  // Fallback: in container environments with default Docker bridge, gateway is 172.17.0.1
  try {
    if (fs.existsSync('/.dockerenv') || (fs.existsSync('/proc/1/cgroup') && fs.readFileSync('/proc/1/cgroup', 'utf8').includes('docker'))) {
      return '172.17.0.1';
    }
  } catch {
    // ignore
  }

  return null;
}

/**
 * Resolves a hostname, with fallback to Docker host gateway IP for 'host.docker.internal'
 * or 'localhost' when DNS lookup fails.
 */
export async function resolveTargetHost(host: string): Promise<string> {
  // If already an IP address, return immediately
  if (net.isIP(host)) {
    return host;
  }

  // Attempt standard DNS resolution
  try {
    const lookup = await dns.lookup(host);
    if (lookup.address) {
      return host;
    }
  } catch (err) {
    console.warn(`[BotRunner] DNS lookup failed for "${host}": ${(err as Error).message}`);
  }

  // If host is host.docker.internal or localhost, attempt gateway fallback
  if (host === 'host.docker.internal' || host === 'localhost') {
    const gateway = discoverDockerGateway();
    if (gateway) {
      console.log(`[BotRunner] Fallback: mapped "${host}" -> Docker host gateway IP ${gateway}`);
      return gateway;
    }
  }

  return host;
}

/**
 * Resolves hostnames within a URL (e.g. PANEL_GATEWAY_URL), replacing unresolvable
 * host.docker.internal or localhost with the Docker host gateway IP.
 */
export async function resolveGatewayUrl(rawUrl: string): Promise<string> {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.hostname === 'host.docker.internal' || parsed.hostname === 'localhost') {
      const resolved = await resolveTargetHost(parsed.hostname);
      if (resolved !== parsed.hostname) {
        parsed.hostname = resolved;
        return parsed.toString().replace(/\/+$/, '');
      }
    }
  } catch {
    // ignore URL parsing error
  }
  return rawUrl.replace(/\/+$/, '');
}
