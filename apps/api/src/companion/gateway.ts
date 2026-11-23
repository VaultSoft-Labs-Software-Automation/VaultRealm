/**
 * LLM Gateway — internal proxy for bot-runner → LLM endpoint.
 *
 * Authenticates via per-bot tokens, enforces rate limits and token budgets,
 * records usage metrics, and stores redacted traces.
 *
 * Route: POST /internal/llm/chat (bot-runner only, not for browser clients)
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq, and, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { getDatabase } from '../db/index.js';
import { bots, llmEndpoints, botUsage, botTraces } from '../db/schema.js';
import { verifyBotToken } from './bot-tokens.js';
import { decryptApiKey } from './crypto.js';

/** Maximum tokens the gateway will allow per request. */
const MAX_TOKENS_CAP = 4096;

/** Trace retention in days. */
const TRACE_RETENTION_DAYS = 7;

/** In-memory rate limit tracker: botId → { count, resetAt } */
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

/** Reset the rate limit map (useful for tests). */
export function resetGatewayRateLimits(): void {
  rateLimitMap.clear();
}

/**
 * Check and increment the per-bot rate limit.
 * Returns true if the request is allowed.
 */
function checkRateLimit(botId: string, rpmLimit: number): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(botId);

  if (!entry || now >= entry.resetAt) {
    rateLimitMap.set(botId, { count: 1, resetAt: now + 60_000 });
    return true;
  }

  if (entry.count >= rpmLimit) {
    return false;
  }

  entry.count++;
  return true;
}

/**
 * Get today's date string for usage tracking (YYYY-MM-DD).
 */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Get current daily token usage for a bot.
 */
function getDailyUsage(botId: string): { promptTokens: number; completionTokens: number; requests: number } {
  const db = getDatabase();
  const day = today();
  const rows = db
    .select()
    .from(botUsage)
    .where(and(eq(botUsage.botId, botId), eq(botUsage.day, day)))
    .all();

  if (rows.length === 0) {
    return { promptTokens: 0, completionTokens: 0, requests: 0 };
  }

  const row = rows[0]!;
  return {
    promptTokens: row.promptTokens,
    completionTokens: row.completionTokens,
    requests: row.requests,
  };
}

/**
 * Record token usage for a bot.
 */
function recordUsage(
  botId: string,
  promptTokens: number,
  completionTokens: number,
): void {
  const db = getDatabase();
  const day = today();

  // Upsert: try update first, then insert if no rows affected
  const updated = db
    .update(botUsage)
    .set({
      promptTokens: sql`${botUsage.promptTokens} + ${promptTokens}`,
      completionTokens: sql`${botUsage.completionTokens} + ${completionTokens}`,
      requests: sql`${botUsage.requests} + 1`,
    })
    .where(and(eq(botUsage.botId, botId), eq(botUsage.day, day)))
    .run();

  if (updated.changes === 0) {
    db.insert(botUsage)
      .values({ botId, day, promptTokens, completionTokens, requests: 1 })
      .run();
  }
}

/**
 * Store a redacted trace of the LLM request/response.
 */
function storeTrace(
  botId: string,
  requestBody: Record<string, unknown>,
  responseBody: Record<string, unknown> | null,
  latencyMs: number,
  status: string,
): void {
  const db = getDatabase();

  // Redact sensitive fields from the request
  const redactedRequest = { ...requestBody };
  // Don't store full message history — just the last user message
  if (Array.isArray(redactedRequest.messages)) {
    const messages = redactedRequest.messages as Array<{ role: string; content: string }>;
    if (messages.length > 3) {
      redactedRequest.messages = [
        messages[0], // system prompt (truncated)
        { role: 'info', content: `... ${messages.length - 2} messages omitted ...` },
        messages[messages.length - 1], // last message
      ];
    }
    // Truncate system prompt
    if (messages[0] && typeof messages[0].content === 'string' && messages[0].content.length > 500) {
      (redactedRequest.messages as Array<{ role: string; content: string }>)[0] = {
        ...messages[0],
        content: messages[0].content.slice(0, 500) + '...',
      };
    }
  }

  db.insert(botTraces)
    .values({
      id: nanoid(),
      botId,
      requestJson: JSON.stringify(redactedRequest).slice(0, 8192),
      responseJson: responseBody ? JSON.stringify(responseBody).slice(0, 8192) : null,
      latencyMs,
      status,
    })
    .run();

  // Prune old traces (keep last MAX_TRACES_PER_BOT and within retention period)
  const cutoff = new Date(Date.now() - TRACE_RETENTION_DAYS * 86400_000).toISOString();
  db.delete(botTraces)
    .where(
      and(
        eq(botTraces.botId, botId),
        sql`${botTraces.ts} < ${cutoff}`,
      ),
    )
    .run();
}

/**
 * Register the internal LLM gateway route.
 */
export async function registerGateway(app: FastifyInstance): Promise<void> {
  app.post('/internal/llm/chat', async (request: FastifyRequest, reply: FastifyReply) => {
    // 1. Authenticate via bot token (from Authorization header)
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.status(401).send({
        code: 'UNAUTHORIZED',
        message: 'Missing or invalid bot token.',
      });
    }

    const token = authHeader.slice(7);
    const tokenData = verifyBotToken(token);
    if (!tokenData) {
      return reply.status(401).send({
        code: 'UNAUTHORIZED',
        message: 'Invalid or expired bot token.',
      });
    }

    const { botId } = tokenData;

    // 2. Load bot and its endpoint config
    const db = getDatabase();
    const botRows = db.select().from(bots).where(eq(bots.id, botId)).all();
    const bot = botRows[0];
    if (!bot) {
      return reply.status(404).send({
        code: 'BOT_NOT_FOUND',
        message: 'Bot not found.',
      });
    }

    const endpointRows = db
      .select()
      .from(llmEndpoints)
      .where(eq(llmEndpoints.id, bot.endpointId))
      .all();
    const endpoint = endpointRows[0];
    if (!endpoint) {
      return reply.status(404).send({
        code: 'ENDPOINT_NOT_FOUND',
        message: 'LLM endpoint not found.',
      });
    }

    // 3. Rate limit check
    if (!checkRateLimit(botId, bot.rpmLimit)) {
      return reply.status(429).send({
        code: 'RATE_LIMITED',
        message: `Rate limit exceeded (${bot.rpmLimit} requests/min).`,
      });
    }

    // 4. Budget check
    const usage = getDailyUsage(botId);
    const totalTokensUsed = usage.promptTokens + usage.completionTokens;
    if (totalTokensUsed >= bot.dailyTokenBudget) {
      return reply.status(429).send({
        code: 'BUDGET_EXHAUSTED',
        message: `Daily token budget exhausted (${totalTokensUsed}/${bot.dailyTokenBudget}).`,
      });
    }

    // 5. Prepare the forwarded request
    const body = request.body as Record<string, unknown>;

    // Cap max_tokens
    const maxTokens = Math.min(
      typeof body.max_tokens === 'number' ? body.max_tokens : MAX_TOKENS_CAP,
      MAX_TOKENS_CAP,
    );

    // Use bot's configured model or the request's model
    const model = bot.model ?? endpoint.defaultModel ?? body.model;

    // Build clean request body (strip unknown/dangerous params)
    const forwardBody: Record<string, unknown> = {
      model,
      messages: body.messages,
      max_tokens: maxTokens,
    };

    // Allow these optional fields through
    if (body.temperature !== undefined) forwardBody.temperature = body.temperature;
    if (body.tools !== undefined) forwardBody.tools = body.tools;
    if (body.tool_choice !== undefined) forwardBody.tool_choice = body.tool_choice;
    if (body.stop !== undefined) forwardBody.stop = body.stop;

    // Build headers for the upstream request
    const upstreamHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (endpoint.apiKeyEnc) {
      try {
        const apiKey = decryptApiKey(endpoint.apiKeyEnc);
        upstreamHeaders['Authorization'] = `Bearer ${apiKey}`;
      } catch {
        return reply.status(500).send({
          code: 'KEY_DECRYPT_ERROR',
          message: 'Could not decrypt API key. The PANEL_SECRET may have changed. Please re-enter your API key in the Companion settings.',
        });
      }
    }

    // Add any extra headers from the endpoint config
    if (endpoint.headersJson) {
      try {
        const extra = JSON.parse(endpoint.headersJson) as Record<string, string>;
        Object.assign(upstreamHeaders, extra);
      } catch {
        // ignore malformed extra headers
      }
    }

    // 6. Forward request to the upstream endpoint
    const base = endpoint.baseUrl.replace(/\/+$/, '');
    const startTime = Date.now();
    let responseBody: Record<string, unknown> | null = null;
    let statusText = 'ok';

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), (endpoint.timeoutS ?? 30) * 1000);

      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: upstreamHeaders,
        body: JSON.stringify(forwardBody),
        signal: controller.signal,
      });

      clearTimeout(timeout);
      const latencyMs = Date.now() - startTime;

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        statusText = `error:${res.status}`;
        storeTrace(botId, forwardBody, { error: errBody.slice(0, 1000) }, latencyMs, statusText);
        return reply.status(res.status).send({
          code: 'UPSTREAM_ERROR',
          message: `LLM endpoint returned ${res.status}: ${errBody.slice(0, 500)}`,
        });
      }

      responseBody = await res.json() as Record<string, unknown>;
      const latency = Date.now() - startTime;

      // 7. Record usage
      const resUsage = responseBody.usage as
        | { prompt_tokens?: number; completion_tokens?: number }
        | undefined;

      const promptTokens = resUsage?.prompt_tokens ?? estimateTokens(forwardBody);
      const completionTokens = resUsage?.completion_tokens ?? 0;

      recordUsage(botId, promptTokens, completionTokens);

      // 8. Store trace
      storeTrace(botId, forwardBody, responseBody, latency, 'ok');

      // 9. Return the response to the bot-runner
      return reply.send(responseBody);
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      const errMsg = err instanceof Error ? err.message : String(err);

      if (err instanceof Error && err.name === 'AbortError') {
        statusText = 'timeout';
        storeTrace(botId, forwardBody, { error: 'timeout' }, latencyMs, statusText);
        return reply.status(504).send({
          code: 'UPSTREAM_TIMEOUT',
          message: `LLM endpoint timed out after ${endpoint.timeoutS ?? 30}s.`,
        });
      }

      statusText = 'error';
      storeTrace(botId, forwardBody, { error: errMsg.slice(0, 1000) }, latencyMs, statusText);
      return reply.status(502).send({
        code: 'UPSTREAM_ERROR',
        message: `Could not reach LLM endpoint: ${errMsg}`,
      });
    }
  });
}

/**
 * Rough token estimation when the response doesn't include usage info.
 * Uses the ~4 chars per token heuristic.
 */
function estimateTokens(body: Record<string, unknown>): number {
  const json = JSON.stringify(body.messages ?? '');
  return Math.ceil(json.length / 4);
}
