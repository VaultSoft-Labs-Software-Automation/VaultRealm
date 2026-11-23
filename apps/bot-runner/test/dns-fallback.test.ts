import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import dns from 'node:dns/promises';
import {
  discoverDockerGateway,
  resolveTargetHost,
  resolveGatewayUrl,
} from '../src/dns-fallback.js';

describe('DNS & Docker Gateway Fallback Resolver', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('discoverDockerGateway', () => {
    it('parses little-endian gateway hex from /proc/net/route (172.17.0.1)', () => {
      vi.spyOn(fs, 'existsSync').mockImplementation((p) => p === '/proc/net/route');
      vi.spyOn(fs, 'readFileSync').mockImplementation((p) => {
        if (p === '/proc/net/route') {
          return [
            'Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT',
            'eth0\t00000000\t010011AC\t0003\t0\t0\t0\t00000000\t0\t0\t0',
            'eth0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0',
          ].join('\n');
        }
        return '';
      });

      const gateway = discoverDockerGateway();
      expect(gateway).toBe('172.17.0.1');
    });

    it('parses custom subnet gateway hex from /proc/net/route (172.18.0.1)', () => {
      vi.spyOn(fs, 'existsSync').mockImplementation((p) => p === '/proc/net/route');
      vi.spyOn(fs, 'readFileSync').mockImplementation((p) => {
        if (p === '/proc/net/route') {
          return [
            'Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT',
            'eth0\t00000000\t010012AC\t0003\t0\t0\t0\t00000000\t0\t0\t0',
          ].join('\n');
        }
        return '';
      });

      const gateway = discoverDockerGateway();
      expect(gateway).toBe('172.18.0.1');
    });

    it('falls back to 172.17.0.1 if /.dockerenv exists but /proc/net/route is absent', () => {
      vi.spyOn(fs, 'existsSync').mockImplementation((p) => p === '/.dockerenv');

      const gateway = discoverDockerGateway();
      expect(gateway).toBe('172.17.0.1');
    });

    it('returns null when outside container environment', () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);

      const gateway = discoverDockerGateway();
      expect(gateway).toBeNull();
    });
  });

  describe('resolveTargetHost', () => {
    it('returns direct IP addresses without running DNS lookup', async () => {
      const dnsSpy = vi.spyOn(dns, 'lookup');
      const resolved = await resolveTargetHost('172.17.0.2');

      expect(resolved).toBe('172.17.0.2');
      expect(dnsSpy).not.toHaveBeenCalled();
    });

    it('returns hostname directly when DNS lookup succeeds', async () => {
      vi.spyOn(dns, 'lookup').mockResolvedValue({ address: '93.184.216.34', family: 4 });

      const resolved = await resolveTargetHost('example.com');
      expect(resolved).toBe('example.com');
    });

    it('falls back to Docker gateway IP when host.docker.internal fails DNS lookup', async () => {
      vi.spyOn(dns, 'lookup').mockRejectedValue(new Error('getaddrinfo ENOTFOUND host.docker.internal'));
      vi.spyOn(fs, 'existsSync').mockImplementation((p) => p === '/.dockerenv');

      const resolved = await resolveTargetHost('host.docker.internal');
      expect(resolved).toBe('172.17.0.1');
    });

    it('falls back to Docker gateway IP when localhost fails DNS lookup in container', async () => {
      vi.spyOn(dns, 'lookup').mockRejectedValue(new Error('getaddrinfo ENOTFOUND localhost'));
      vi.spyOn(fs, 'existsSync').mockImplementation((p) => p === '/.dockerenv');

      const resolved = await resolveTargetHost('localhost');
      expect(resolved).toBe('172.17.0.1');
    });

    it('returns original hostname if DNS fails and no gateway can be discovered', async () => {
      vi.spyOn(dns, 'lookup').mockRejectedValue(new Error('getaddrinfo ENOTFOUND custom-unknown-host'));
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);

      const resolved = await resolveTargetHost('custom-unknown-host');
      expect(resolved).toBe('custom-unknown-host');
    });
  });

  describe('resolveGatewayUrl', () => {
    it('rewrites host.docker.internal in URL to gateway IP when DNS fails', async () => {
      vi.spyOn(dns, 'lookup').mockRejectedValue(new Error('ENOTFOUND'));
      vi.spyOn(fs, 'existsSync').mockImplementation((p) => p === '/.dockerenv');

      const resolved = await resolveGatewayUrl('http://host.docker.internal:3001');
      expect(resolved).toBe('http://172.17.0.1:3001');
    });

    it('leaves standard URL unchanged when DNS succeeds', async () => {
      vi.spyOn(dns, 'lookup').mockResolvedValue({ address: '127.0.0.1', family: 4 });

      const resolved = await resolveGatewayUrl('https://api.example.com/v1');
      expect(resolved).toBe('https://api.example.com/v1');
    });
  });
});
