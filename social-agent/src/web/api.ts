/**
 * Typed wrappers around the social-agent REST API.
 * The server ships dashboard + API on the same origin, so all paths are relative.
 */

export interface Status {
  home: string;
}

export interface Settings {
  port: number;
  logLevel: 'info' | 'warn' | 'error' | 'debug';
  defaultProviderId?: string;
  defaultModel?: string;
}

export interface Pet {
  id: string;
  name: string;
  persona?: string;
  createdAt: number;
  updatedAt: number;
}

export type ProviderType       = 'openai-compat' | 'anthropic' | 'gemini';
export type ProviderApiFormat  = 'openai_compatible' | 'anthropic_native' | 'gemini_official';

export interface ProviderPublic {
  id: string;
  type: ProviderType;
  apiFormat: ProviderApiFormat;     // Tauri-style alias of `type`
  name: string;
  baseUrl?: string;
  defaultModel?: string;
  apiKeyMasked: string;
  cachedModels?: string[];
  cachedModelsAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface LLMTestResult {
  content: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  elapsedMs: number;
  finishReason: string;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: any = null;
  if (text) {
    try { parsed = JSON.parse(text); } catch { /* leave null */ }
  }
  if (!res.ok) {
    const msg = parsed?.error ?? `HTTP ${res.status}`;
    throw new ApiError(res.status, msg);
  }
  return parsed as T;
}

// ─── status / settings ───
export const getStatus     = ()                          => request<Status>('GET', '/api/status');
export const getSettings   = ()                          => request<Settings>('GET', '/api/settings');
export const patchSettings = (p: Partial<Settings>)      => request<Settings>('PATCH', '/api/settings', p);

// ─── pets ───
export const listPets   = ()                                                  => request<Pet[]>('GET', '/api/pets');
export const createPet  = (input: { name: string; persona?: string })          => request<Pet>('POST', '/api/pets', input);
export const updatePet  = (id: string, partial: Partial<Pick<Pet, 'name'|'persona'>>) => request<Pet>('PATCH', `/api/pets/${encodeURIComponent(id)}`, partial);
export const deletePet  = (id: string)                                         => request<{ ok: true }>('DELETE', `/api/pets/${encodeURIComponent(id)}`);

// ─── providers ───
export const listProviders   = ()                               => request<ProviderPublic[]>('GET', '/api/providers');
export const createProvider  = (input: {
  type: ProviderPublic['type'];
  name: string;
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
}) => request<ProviderPublic>('POST', '/api/providers', input);
export const updateProvider  = (id: string, partial: Partial<{ name: string; apiKey: string; baseUrl: string; defaultModel: string }>) =>
  request<ProviderPublic>('PATCH', `/api/providers/${encodeURIComponent(id)}`, partial);
export const deleteProvider  = (id: string) => request<{ ok: true }>('DELETE', `/api/providers/${encodeURIComponent(id)}`);
export const fetchProviderModels = (id: string) =>
  request<{ ok: true; models: string[]; count: number; provider: ProviderPublic }>('POST', `/api/providers/${encodeURIComponent(id)}/fetch-models`);

// ─── LLM test ───
export const llmTest = (input: { providerId: string; model: string; prompt: string; temperature?: number; maxTokens?: number }) =>
  request<LLMTestResult>('POST', '/api/llm/test', input);

// ─── agent sessions ───

export type LurkMode = 'normal' | 'semi-lurk' | 'full-lurk';
export type TargetType = 'group' | 'friend';

export interface SessionConfig {
  petId: string;
  targetId: string;
  targetType?: TargetType;
  providerId: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  maxIterations?: number;
  targetName?: string;
  socialPersonaPrompt?: string;
  botQQ?: string;
  ownerQQ?: string;
  ownerName?: string;
  ownerSecret?: string;
  lurkMode?: LurkMode;
  voiceEnabled?: boolean;
  imageGenEnabled?: boolean;
  customGroupRules?: string;
}

export interface SessionView {
  config: SessionConfig;
  status: 'idle' | 'evaluating' | 'paused';
  lastEvalAt: number | null;
  evalCount: number;
  lastPlan: { state: string; brief: string; actions: any[] } | null;
  hasPendingSnapshot: boolean;
  createdAt: number;
}

export const listSessions   = ()                                      => request<SessionView[]>('GET', '/api/agent/sessions');
export const getSession     = (id: string)                            => request<SessionView>('GET', `/api/agent/sessions/${encodeURIComponent(id)}`);
export const createSession  = (cfg: SessionConfig)                    => request<SessionView>('POST', '/api/agent/sessions', cfg);
export const stopSession    = (id: string)                            => request<{ ok: true }>('DELETE', `/api/agent/sessions/${encodeURIComponent(id)}`);
export const feedSession    = (id: string, chatSnapshot: string)      => request<{ ok: true; queued: true }>('POST', `/api/agent/sessions/${encodeURIComponent(id)}/feed`, { chatSnapshot });
export const pauseSession   = (id: string)                            => request<{ ok: true }>('POST', `/api/agent/sessions/${encodeURIComponent(id)}/pause`);
export const resumeSession  = (id: string)                            => request<{ ok: true }>('POST', `/api/agent/sessions/${encodeURIComponent(id)}/resume`);

// WebSocket URL helper (browser uses ws/wss based on the page protocol)
export function agentWsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws/agent`;
}

// ─── per-pet social config (Tauri-parity schema) ───

export type ImageDescMode = 'off' | 'on' | 'when-mentioned';

export interface ImageGenConfig { enabled: boolean; providerId: string; modelName: string; }
export interface TtsConfig      { enabled: boolean; apiKey: string; voiceId: string; modelId: string; }

export interface SocialConfig {
  petId: string;
  mcpServerName: string;
  apiProviderId: string;
  modelName: string;
  intentApiProviderId: string;
  intentModelName: string;
  observerApiProviderId: string;
  observerModelName: string;
  compressApiProviderId: string;
  compressModelName: string;
  imageDescProviderId: string;
  imageDescModelName: string;
  imageGenConfig: ImageGenConfig;
  ttsConfig: TtsConfig;
  watchedGroups: string[];
  watchedFriends: string[];
  customGroupRules: Record<string, string>;
  lurkModes: Record<string, LurkMode>;
  pausedTargets: Record<string, boolean>;
  botQQ: string;
  ownerQQ: string;
  ownerName: string;
  ownerSecret: string;
  nameDelimiterL: string;
  nameDelimiterR: string;
  msgDelimiterL: string;
  msgDelimiterR: string;
  socialPersonaPrompt: string;
  replyStrategyPrompt: string;
  agentCanEditStrategy: boolean;
  atMustReply: boolean;
  enableImages: boolean;
  imageDescMode: ImageDescMode;
  replyInterval: number;
  observerInterval: number;
  subagentEnabled: boolean;
  subagentMaxConcurrent: number;
  subagentTimeoutSecs: number;
  subagentModel: string;
}

// ─── MCP servers ───

export interface MCPServer {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export const listMCPServers   = ()                                      => request<MCPServer[]>('GET', '/api/mcp-servers');
export const getMCPServer     = (id: string)                            => request<MCPServer>('GET', `/api/mcp-servers/${encodeURIComponent(id)}`);
export const createMCPServer  = (input: { name: string; command: string; args?: string[]; env?: Record<string, string>; enabled?: boolean }) =>
  request<MCPServer>('POST', '/api/mcp-servers', input);
export const updateMCPServer  = (id: string, partial: Partial<Omit<MCPServer, 'id' | 'createdAt' | 'updatedAt'>>) =>
  request<MCPServer>('PATCH', `/api/mcp-servers/${encodeURIComponent(id)}`, partial);
export const deleteMCPServer  = (id: string)                            => request<{ ok: true }>('DELETE', `/api/mcp-servers/${encodeURIComponent(id)}`);

export const getSocialConfig    = (petId: string)                          => request<SocialConfig>('GET', `/api/pets/${encodeURIComponent(petId)}/social-config`);
export const putSocialConfig    = (petId: string, cfg: SocialConfig)       => request<SocialConfig>('PUT', `/api/pets/${encodeURIComponent(petId)}/social-config`, cfg);
export const patchSocialConfig  = (petId: string, cfg: Partial<SocialConfig>) => request<SocialConfig>('PATCH', `/api/pets/${encodeURIComponent(petId)}/social-config`, cfg);
