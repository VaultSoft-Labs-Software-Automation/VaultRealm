import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import {
  buildTestApp,
  cleanupTestApp,
  registerAdmin,
  registerUser,
  createInvite,
} from './helpers.js';
import {
  encryptApiKey,
  decryptApiKey,
  maskApiKey,
  checkIpBlocked,
  validateEndpointUrl,
  createBotToken,
  verifyBotToken,
  resetGatewayRateLimits,
} from '../src/companion/index.js';
import { getDatabase } from '../src/db/index.js';
import { servers, bots, botUsage, botTraces, llmEndpoints } from '../src/db/schema.js';

describe('Phase 6a — AI Companion LLM Endpoints & Gateway', () => {
  let app: FastifyInstance;
  let adminCookie: string;
  let userCookie: string;
  let userId: string;

  beforeEach(async () => {
    app = await buildTestApp();
    const admin = await registerAdmin(app);
    adminCookie = admin.cookies['vr_session']!;

    const inviteRes = await createInvite(app, adminCookie);
    const inviteCode = inviteRes.json().code;
    const user = await registerUser(app, inviteCode, {
      username: 'companionuser',
      email: 'companion@test.com',
    });
    userCookie = user.cookies['vr_session']!;
    userId = user.response.json().id;
    resetGatewayRateLimits();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanupTestApp();
  });

  // ── 1. Crypto Helpers ────────────────────────────────────────────────────────
  describe('Crypto helpers', () => {
    it('encrypts and decrypts API keys correctly', () => {
      const originalKey = 'sk-proj-1234567890abcdefABCDEF';
      const encrypted = encryptApiKey(originalKey);

      expect(encrypted).not.toBe(originalKey);
      expect(typeof encrypted).toBe('string');

      const decrypted = decryptApiKey(encrypted);
      expect(decrypted).toBe(originalKey);
    });

    it('masks API keys showing only the last 4 characters', () => {
      expect(maskApiKey('sk-12345678')).toBe('****5678');
      expect(maskApiKey('abcd')).toBe('****abcd');
      expect(maskApiKey('')).toBe('****');
      expect(maskApiKey(null)).toBe('****');
      expect(maskApiKey(undefined)).toBe('****');
    });

    it('fails to decrypt tampered data', () => {
      const encrypted = encryptApiKey('secret-key');
      const buf = Buffer.from(encrypted, 'base64');
      buf[buf.length - 1]! ^= 1; // flip last bit of ciphertext/tag
      const tampered = buf.toString('base64');

      expect(() => decryptApiKey(tampered)).toThrow();
    });
  });

  // ── 2. SSRF Guard ────────────────────────────────────────────────────────────
  describe('SSRF Guard', () => {
    it('blocks known dangerous IPs', () => {
      expect(checkIpBlocked('127.0.0.1')).toBe('loopback');
      expect(checkIpBlocked('127.1.2.3')).toBe('loopback');
      expect(checkIpBlocked('169.254.169.254')).toBe('cloud metadata endpoint (169.254.169.254)');
      expect(checkIpBlocked('10.0.0.5')).toBe('private (10.x)');
      expect(checkIpBlocked('172.20.0.1')).toBe('private range (172.16-31.x)');
      expect(checkIpBlocked('192.168.1.100')).toBe('private range (192.168.x)');
      expect(checkIpBlocked('::1')).toBe('IPv6 loopback');
    });

    it('allows public IPs', () => {
      expect(checkIpBlocked('8.8.8.8')).toBeUndefined();
      expect(checkIpBlocked('104.18.2.1')).toBeUndefined();
    });

    it('blocks loopback and private URLs for regular users', async () => {
      const loopbackResult = await validateEndpointUrl('http://127.0.0.1:11434/v1', false);
      expect(loopbackResult.safe).toBe(false);

      const metadataResult = await validateEndpointUrl('http://169.254.169.254/latest', false);
      expect(metadataResult.safe).toBe(false);

      const privateResult = await validateEndpointUrl('http://192.168.1.50:8000/v1', false);
      expect(privateResult.safe).toBe(false);
    });

    it('allows loopback/private URLs for admin users', async () => {
      const res = await validateEndpointUrl('http://127.0.0.1:11434/v1', true);
      expect(res.safe).toBe(true);
    });

    it('rejects non-http protocols', async () => {
      const res = await validateEndpointUrl('file:///etc/passwd', false);
      expect(res.safe).toBe(false);
      expect(res.reason).toContain('Unsupported protocol');
    });
  });

  // ── 3. Bot Tokens ────────────────────────────────────────────────────────────
  describe('Bot Tokens', () => {
    it('creates and verifies valid tokens', () => {
      const token = createBotToken('bot-123', 3600);
      const verified = verifyBotToken(token);

      expect(verified).not.toBeNull();
      expect(verified?.botId).toBe('bot-123');
    });

    it('rejects expired tokens', () => {
      const token = createBotToken('bot-expired', -10); // expired 10s ago
      const verified = verifyBotToken(token);

      expect(verified).toBeNull();
    });

    it('rejects tampered tokens', () => {
      const token = createBotToken('bot-test', 3600);
      const tampered = token.slice(0, -3) + 'xyz';
      const verified = verifyBotToken(tampered);

      expect(verified).toBeNull();
    });

    it('rejects malformed token strings', () => {
      expect(verifyBotToken('')).toBeNull();
      expect(verifyBotToken('invalid-token')).toBeNull();
      expect(verifyBotToken('a.b')).toBeNull();
    });
  });

  // ── 4. LLM Endpoint CRUD Routes ─────────────────────────────────────────────
  describe('LLM Endpoint CRUD', () => {
    it('returns available presets', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/llm-endpoints/presets',
        cookies: { vr_session: userCookie },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.presets.length).toBeGreaterThanOrEqual(5);
      expect(data.presets.some((p: { id: string }) => p.id === 'openai')).toBe(true);
      expect(data.presets.some((p: { id: string; baseUrl: string; defaultModel: string }) => p.id === 'vercel' && p.baseUrl === 'https://ai-gateway.vercel.sh/v1' && p.defaultModel === 'openai/gpt-4o-mini')).toBe(true);
    });

    it('creates an endpoint and never exposes the raw API key', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/llm-endpoints',
        cookies: { vr_session: userCookie },
        payload: {
          name: 'My OpenAI',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'sk-proj-abcdef1234567890wxyz',
          defaultModel: 'gpt-4o-mini',
          timeoutS: 45,
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.id).toBeDefined();
      expect(body.name).toBe('My OpenAI');
      expect(body.baseUrl).toBe('https://api.openai.com/v1');
      expect(body.defaultModel).toBe('gpt-4o-mini');
      expect(body.lastFour).toBe('****wxyz');
      expect(body.apiKey).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain('abcdef1234567890');
    });

    it('creates a Vercel AI Gateway endpoint successfully', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/llm-endpoints',
        cookies: { vr_session: userCookie },
        payload: {
          name: 'Vercel AI Gateway',
          baseUrl: 'https://ai-gateway.vercel.sh/v1',
          apiKey: 'vcl_key_1234567890abcdef',
          defaultModel: 'openai/gpt-4o-mini',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.name).toBe('Vercel AI Gateway');
      expect(body.baseUrl).toBe('https://ai-gateway.vercel.sh/v1');
      expect(body.defaultModel).toBe('openai/gpt-4o-mini');
      expect(body.lastFour).toBe('****cdef');
    });

    it('blocks SSRF on create for non-admin', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/llm-endpoints',
        cookies: { vr_session: userCookie },
        payload: {
          name: 'Local Ollama SSRF',
          baseUrl: 'http://127.0.0.1:11434/v1',
          defaultModel: 'llama3',
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('SSRF_BLOCKED');
    });

    it('allows admin to create local/private endpoints', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/llm-endpoints',
        cookies: { vr_session: adminCookie },
        payload: {
          name: 'Admin Ollama',
          baseUrl: 'http://127.0.0.1:11434/v1',
          defaultModel: 'llama3',
        },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().name).toBe('Admin Ollama');
    });

    it('lists endpoints with masked keys', async () => {
      // Create one endpoint as user
      await app.inject({
        method: 'POST',
        url: '/api/llm-endpoints',
        cookies: { vr_session: userCookie },
        payload: {
          name: 'User Endpoint',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'sk-secret-key-1234',
        },
      });

      const listRes = await app.inject({
        method: 'GET',
        url: '/api/llm-endpoints',
        cookies: { vr_session: userCookie },
      });

      expect(listRes.statusCode).toBe(200);
      const { endpoints } = listRes.json();
      expect(endpoints.length).toBe(1);
      expect(endpoints[0].name).toBe('User Endpoint');
      expect(endpoints[0].lastFour).toBe('****1234');
      expect(endpoints[0].hasKey).toBe(true);
      expect(JSON.stringify(endpoints[0])).not.toContain('sk-secret-key-1234');
    });

    it('updates an endpoint', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/llm-endpoints',
        cookies: { vr_session: userCookie },
        payload: {
          name: 'Initial Name',
          baseUrl: 'https://api.groq.com/openai/v1',
          defaultModel: 'llama-3.1-8b-instant',
        },
      });
      const endpointId = createRes.json().id;

      const updateRes = await app.inject({
        method: 'PUT',
        url: `/api/llm-endpoints/${endpointId}`,
        cookies: { vr_session: userCookie },
        payload: {
          name: 'Updated Name',
          timeoutS: 60,
        },
      });

      expect(updateRes.statusCode).toBe(200);

      // Verify update in list
      const listRes = await app.inject({
        method: 'GET',
        url: '/api/llm-endpoints',
        cookies: { vr_session: userCookie },
      });
      const ep = listRes.json().endpoints.find((e: { id: string }) => e.id === endpointId);
      expect(ep.name).toBe('Updated Name');
      expect(ep.timeoutS).toBe(60);
    });

    it('deletes an endpoint', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/llm-endpoints',
        cookies: { vr_session: userCookie },
        payload: {
          name: 'To Delete',
          baseUrl: 'https://api.openai.com/v1',
        },
      });
      const endpointId = createRes.json().id;

      const delRes = await app.inject({
        method: 'DELETE',
        url: `/api/llm-endpoints/${endpointId}`,
        cookies: { vr_session: userCookie },
      });

      expect(delRes.statusCode).toBe(204);

      // Verify gone
      const listRes = await app.inject({
        method: 'GET',
        url: '/api/llm-endpoints',
        cookies: { vr_session: userCookie },
      });
      expect(listRes.json().endpoints.some((e: { id: string }) => e.id === endpointId)).toBe(false);
    });

    it('prevents deleting an endpoint that is assigned to a bot', async () => {
      const db = getDatabase();

      // Create endpoint
      const epRes = await app.inject({
        method: 'POST',
        url: '/api/llm-endpoints',
        cookies: { vr_session: adminCookie },
        payload: {
          name: 'Bot Endpoint',
          baseUrl: 'https://api.openai.com/v1',
        },
      });
      const endpointId = epRes.json().id;

      // Seed a server and bot
      const serverId = nanoid();
      db.insert(servers).values({
        id: serverId,
        ownerId: userId,
        name: 'Companion Server',
        templateId: 'minecraft-java',
        status: 'stopped',
        ramMb: 1024,
        containerId: null,
        createdAt: new Date().toISOString(),
      }).run();

      const botId = nanoid();
      db.insert(bots).values({
        id: botId,
        serverId,
        endpointId,
        name: 'GuardBot',
        persona: 'friendly helper',
        mode: 'manual',
        authMode: 'offline',
        whoCanCommand: 'owner',
        permissionsJson: '{}',
        protectedZonesJson: '[]',
        proactive: false,
        dailyTokenBudget: 100000,
        rpmLimit: 30,
        status: 'offline',
      }).run();

      const delRes = await app.inject({
        method: 'DELETE',
        url: `/api/llm-endpoints/${endpointId}`,
        cookies: { vr_session: adminCookie },
      });

      expect(delRes.statusCode).toBe(409);
      expect(delRes.json().code).toBe('ENDPOINT_IN_USE');
    });

    it('requires auth for companion routes', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/llm-endpoints',
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // ── 5. Test-Connection Endpoint ──────────────────────────────────────────────
  describe('POST /api/llm-endpoints/:id/test', () => {
    it('returns 3-step test result on successful mock endpoint', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/llm-endpoints',
        cookies: { vr_session: adminCookie },
        payload: {
          name: 'Mock Test EP',
          baseUrl: 'https://mock.llm.com/v1',
          apiKey: 'sk-test-key-1234',
          defaultModel: 'test-model',
        },
      });
      const endpointId = createRes.json().id;

      // Mock fetch
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = String(input);

        if (url.endsWith('/models')) {
          return new Response(JSON.stringify({ data: [{ id: 'test-model' }] }), { status: 200 });
        }

        if (url.endsWith('/chat/completions')) {
          const body = JSON.parse(String(init?.body ?? '{}'));
          if (body.tools) {
            // Tool call probe response
            return new Response(JSON.stringify({
              choices: [{
                message: {
                  role: 'assistant',
                  tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'ping', arguments: '{}' } }],
                },
              }],
            }), { status: 200 });
          }
          // Tiny completion response
          return new Response(JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'OK' } }],
          }), { status: 200 });
        }

        return new Response('Not found', { status: 404 });
      });

      const testRes = await app.inject({
        method: 'POST',
        url: `/api/llm-endpoints/${endpointId}/test`,
        cookies: { vr_session: adminCookie },
      });

      expect(testRes.statusCode).toBe(200);
      const result = testRes.json();
      expect(result.steps).toHaveLength(3);
      expect(result.steps[0].name).toBe('List Models');
      expect(result.steps[0].status).toBe('pass');
      expect(result.steps[1].name).toBe('Chat Completion');
      expect(result.steps[1].status).toBe('pass');
      expect(result.steps[2].name).toBe('Tool Calling');
      expect(result.steps[2].status).toBe('pass');
      expect(result.supportsTools).toBe(true);
    });

    it('maps 401 response to human-readable error', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/llm-endpoints',
        cookies: { vr_session: adminCookie },
        payload: {
          name: 'Bad Key EP',
          baseUrl: 'https://mock.llm.com/v1',
          apiKey: 'sk-invalid',
        },
      });
      const endpointId = createRes.json().id;

      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'Incorrect API key provided' } }), { status: 401 }),
      );

      const testRes = await app.inject({
        method: 'POST',
        url: `/api/llm-endpoints/${endpointId}/test`,
        cookies: { vr_session: adminCookie },
      });

      expect(testRes.statusCode).toBe(200);
      const result = testRes.json();
      const chatStep = result.steps.find((s: { name: string }) => s.name === 'Chat Completion');
      expect(chatStep.status).toBe('fail');
      expect(chatStep.message).toContain('Invalid API key');
    });

    it('maps 404 response to wrong URL error', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/llm-endpoints',
        cookies: { vr_session: adminCookie },
        payload: {
          name: '404 EP',
          baseUrl: 'https://mock.llm.com/v1',
        },
      });
      const endpointId = createRes.json().id;

      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('404 Not Found', { status: 404, statusText: 'Not Found' }),
      );

      const testRes = await app.inject({
        method: 'POST',
        url: `/api/llm-endpoints/${endpointId}/test`,
        cookies: { vr_session: adminCookie },
      });

      expect(testRes.statusCode).toBe(200);
      const result = testRes.json();
      const chatStep = result.steps.find((s: { name: string }) => s.name === 'Chat Completion');
      expect(chatStep.status).toBe('fail');
      expect(chatStep.message).toContain('Wrong base URL');
    });
  });

  // ── 6. LLM Gateway ──────────────────────────────────────────────────────────
  describe('LLM Gateway (POST /internal/llm/chat)', () => {
    let endpointId: string;
    let botId: string;
    let validBotToken: string;

    beforeEach(async () => {
      const db = getDatabase();

      // Create endpoint
      endpointId = nanoid();
      db.insert(llmEndpoints).values({
        id: endpointId,
        ownerId: userId,
        scope: 'user',
        name: 'Gateway Endpoint',
        baseUrl: 'https://mock.llm.com/v1',
        apiKeyEnc: encryptApiKey('sk-gateway-secret-key-1234'),
        defaultModel: 'gpt-4o-mini',
        timeoutS: 30,
      }).run();

      // Create server & bot
      const serverId = nanoid();
      db.insert(servers).values({
        id: serverId,
        ownerId: userId,
        name: 'Gateway Server',
        templateId: 'minecraft-java',
        status: 'running',
        ramMb: 1024,
        containerId: null,
        createdAt: new Date().toISOString(),
      }).run();

      botId = nanoid();
      db.insert(bots).values({
        id: botId,
        serverId,
        endpointId,
        name: 'CompanionBot',
        persona: 'helpful buddy',
        mode: 'manual',
        authMode: 'offline',
        whoCanCommand: 'owner',
        permissionsJson: '{}',
        protectedZonesJson: '[]',
        proactive: false,
        dailyTokenBudget: 500, // small budget for testing
        rpmLimit: 5,
        status: 'offline',
      }).run();

      validBotToken = createBotToken(botId, 3600);
    });

    it('authenticates via bot token and forwards chat request', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({
          id: 'chatcmpl-test',
          choices: [{ message: { role: 'assistant', content: 'Hello player!' } }],
          usage: { prompt_tokens: 15, completion_tokens: 10, total_tokens: 25 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );

      const res = await app.inject({
        method: 'POST',
        url: '/internal/llm/chat',
        headers: {
          authorization: `Bearer ${validBotToken}`,
          'content-type': 'application/json',
        },
        payload: {
          messages: [{ role: 'user', content: 'Hi bot!' }],
          max_tokens: 100,
        },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.choices[0]!.message.content).toBe('Hello player!');
      expect(data.usage.total_tokens).toBe(25);

      // Verify token usage tracked in DB
      const db = getDatabase();
      const usageRows = db.select().from(botUsage).all();
      expect(usageRows.length).toBe(1);
      expect(usageRows[0]!.promptTokens).toBe(15);
      expect(usageRows[0]!.completionTokens).toBe(10);
      expect(usageRows[0]!.requests).toBe(1);

      // Verify trace stored in DB
      const traceRows = db.select().from(botTraces).all();
      expect(traceRows.length).toBe(1);
      expect(traceRows[0]!.botId).toBe(botId);
      expect(traceRows[0]!.status).toBe('ok');
    });

    it('rejects missing or invalid bot tokens', async () => {
      const noAuthRes = await app.inject({
        method: 'POST',
        url: '/internal/llm/chat',
        payload: { messages: [{ role: 'user', content: 'Hi' }] },
      });
      expect(noAuthRes.statusCode).toBe(401);

      const badAuthRes = await app.inject({
        method: 'POST',
        url: '/internal/llm/chat',
        headers: { authorization: 'Bearer bad.token.here' },
        payload: { messages: [{ role: 'user', content: 'Hi' }] },
      });
      expect(badAuthRes.statusCode).toBe(401);
    });

    it('enforces rate limits', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
        new Response(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'ok' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );

      // rpmLimit is 5 for this bot
      for (let i = 0; i < 5; i++) {
        const res = await app.inject({
          method: 'POST',
          url: '/internal/llm/chat',
          headers: { authorization: `Bearer ${validBotToken}` },
          payload: { messages: [{ role: 'user', content: `msg ${i}` }] },
        });
        expect(res.statusCode).toBe(200);
      }

      // 6th request must be rate limited
      const limitedRes = await app.inject({
        method: 'POST',
        url: '/internal/llm/chat',
        headers: { authorization: `Bearer ${validBotToken}` },
        payload: { messages: [{ role: 'user', content: 'over limit' }] },
      });

      expect(limitedRes.statusCode).toBe(429);
      expect(limitedRes.json().code).toBe('RATE_LIMITED');
    });

    it('enforces daily token budget', async () => {
      // Simulate budget already reached (dailyTokenBudget = 500)
      const db = getDatabase();
      db.insert(botUsage).values({
        botId,
        day: new Date().toISOString().slice(0, 10),
        promptTokens: 300,
        completionTokens: 250, // total = 550 >= 500
        requests: 5,
      }).run();

      const res = await app.inject({
        method: 'POST',
        url: '/internal/llm/chat',
        headers: { authorization: `Bearer ${validBotToken}` },
        payload: { messages: [{ role: 'user', content: 'budget test' }] },
      });

      expect(res.statusCode).toBe(429);
      expect(res.json().code).toBe('BUDGET_EXHAUSTED');
    });

    it('caps max_tokens to 4096', async () => {
      let forwardedBody: Record<string, unknown> | null = null;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
        forwardedBody = JSON.parse(String(init?.body ?? '{}'));
        return new Response(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'ok' } }],
          usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      });

      await app.inject({
        method: 'POST',
        url: '/internal/llm/chat',
        headers: { authorization: `Bearer ${validBotToken}` },
        payload: {
          messages: [{ role: 'user', content: 'test cap' }],
          max_tokens: 100_000, // excessively large
        },
      });

      const captured = forwardedBody as { max_tokens?: number } | null;
      expect(captured).not.toBeNull();
      expect(captured?.max_tokens).toBe(4096);
    });
  });
});
