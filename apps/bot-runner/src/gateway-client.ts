/**
 * Gateway Client — calls the panel LLM gateway using the bot's HMAC token.
 *
 * Route: POST /internal/llm/chat
 */

import type { GatewayChatMessage, GatewayChatResponse } from './types.js';
import type { ToolDefinition } from './skills/definitions.js';
import { resolveGatewayUrl } from './dns-fallback.js';

export interface ChatCompletionResult {
  role: string;
  content: string | null;
  tool_calls?: GatewayChatResponse['choices'][0]['message']['tool_calls'];
}

export class GatewayClient {
  private gatewayUrl: string;
  private botToken: string;

  constructor(gatewayUrl: string, botToken: string) {
    this.gatewayUrl = gatewayUrl.replace(/\/+$/, '');
    this.botToken = botToken;
  }

  /**
   * Request a chat completion with optional tools from the panel gateway.
   */
  async chatWithTools(
    messages: GatewayChatMessage[],
    tools?: ToolDefinition[],
    maxTokens = 300,
    timeoutMs = 25000,
  ): Promise<ChatCompletionResult> {
    const resolvedGatewayUrl = await resolveGatewayUrl(this.gatewayUrl);
    const url = `${resolvedGatewayUrl}/internal/llm/chat`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const payload: Record<string, unknown> = {
        messages,
        max_tokens: maxTokens,
      };

      if (tools && tools.length > 0) {
        payload.tools = tools;
        payload.tool_choice = 'auto';
      }

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.botToken}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errJson = (await res.json().catch(() => ({ message: res.statusText }))) as {
          code?: string;
          message?: string;
        };
        if (res.status === 429) {
          if (errJson.code === 'BUDGET_EXHAUSTED') {
            throw new Error('Daily token budget has been exhausted.');
          }
          throw new Error('Rate limit exceeded. Please wait a moment.');
        }
        throw new Error(errJson.message ?? `Gateway error (${res.status})`);
      }

      const data = (await res.json()) as GatewayChatResponse;
      const choice = data.choices?.[0]?.message;
      return {
        role: choice?.role ?? 'assistant',
        content: choice?.content ?? null,
        tool_calls: choice?.tool_calls,
      };
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('LLM request timed out.');
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Simple text-only chat completion (convenience helper).
   */
  async chat(messages: GatewayChatMessage[], maxTokens = 150, timeoutMs = 20000): Promise<string> {
    const res = await this.chatWithTools(messages, undefined, maxTokens, timeoutMs);
    return res.content ?? '';
  }
}
