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

export interface ProviderPublic {
  id: string;
  type: 'openai-compat' | 'anthropic' | 'gemini';
  name: string;
  baseUrl?: string;
  defaultModel?: string;
  apiKeyMasked: string;
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

// ─── LLM test ───
export const llmTest = (input: { providerId: string; model: string; prompt: string; temperature?: number; maxTokens?: number }) =>
  request<LLMTestResult>('POST', '/api/llm/test', input);
