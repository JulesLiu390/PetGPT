import type { Platform } from '../../platform/index.ts';
import type { Provider } from '../../providers.ts';
import type { LLMClient } from './types.ts';
import { createAnthropicClient } from './anthropic.ts';
import { createOpenAICompatClient } from './openai-compat.ts';
import { createGeminiClient } from './gemini.ts';

export type {
  ChatMessage, ChatRequest, ChatResponse,
  ChatRole, FinishReason, LLMClient,
  ToolCall, ToolDefinition, ToolChoice,
} from './types.ts';
export { LLMError } from './types.ts';
export {
  callWithTools,
  type ToolHandler, type ToolHandlerResult,
  type CallWithToolsOptions, type CallWithToolsResult,
} from './tool-loop.ts';

/** Build an LLMClient for the given provider config, dispatching by `provider.type`. */
export function createLLMClient(platform: Platform, provider: Provider): LLMClient {
  switch (provider.type) {
    case 'anthropic':     return createAnthropicClient(platform.http, provider);
    case 'openai-compat': return createOpenAICompatClient(platform.http, provider);
    case 'gemini':        return createGeminiClient(platform.http, provider);
    default: {
      const _exhaustive: never = provider.type;
      throw new Error(`unknown provider type: ${_exhaustive}`);
    }
  }
}
