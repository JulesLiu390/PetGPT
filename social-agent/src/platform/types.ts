/**
 * Platform abstraction.
 *
 * The social-agent core depends ONLY on this interface — never on Node, Bun,
 * Tauri, or browser APIs directly. That keeps the door open for additional
 * runtimes (e.g. a future browser-side worker, an embedded mode) without
 * rewriting the agent loop.
 */

// ─────────────────── fs (absolute paths) ───────────────────

export interface FileStat {
  size: number;
  mtimeMs: number;
  isDirectory: boolean;
}

export interface PlatformFS {
  read(path: string): Promise<string>;
  readBuffer(path: string): Promise<Uint8Array>;
  write(path: string, content: string | Uint8Array): Promise<void>;
  /** Atomic write: tmp → rename. Defaults to true; pass false for log-style appends. */
  writeAtomic(path: string, content: string | Uint8Array): Promise<void>;
  append(path: string, content: string | Uint8Array): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string, recursive?: boolean): Promise<void>;
  readdir(path: string): Promise<string[]>;
  unlink(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  stat(path: string): Promise<FileStat | null>;
}

// ─────────────────── workspace (petId-relative) ───────────────────

/**
 * High-level wrappers that mirror the existing Tauri API surface
 * (`tauri.workspaceRead/Write/...`). The Phase 3 core port mechanically
 * substitutes `tauri.workspace*` → `platform.workspace.*`.
 */
export interface PlatformWorkspace {
  read(petId: string, relPath: string): Promise<string>;
  write(petId: string, relPath: string, content: string): Promise<void>;
  exists(petId: string, relPath: string): Promise<boolean>;
  list(petId: string, relPath: string): Promise<string[]>;
  unlink(petId: string, relPath: string): Promise<void>;
  /** Resolve to an absolute path on the host. Useful for diagnostics / openInOS. */
  absolute(petId: string, relPath: string): string;
}

// ─────────────────── http ───────────────────

export interface HTTPRequest {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  signal?: AbortSignal;
  /** Total deadline (ms). Default per-platform; node-http defaults to 60s. */
  timeoutMs?: number;
}

export interface HTTPResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: string;
}

export interface PlatformHTTP {
  request(req: HTTPRequest): Promise<HTTPResponse>;
  /** SSE / chunked streaming. Yields raw bytes; caller decodes. */
  stream(req: HTTPRequest): AsyncIterable<Uint8Array>;
}

// ─────────────────── events (in-process pub/sub) ───────────────────

export type EventHandler<T = unknown> = (payload: T) => void;

export interface PlatformEvents {
  emit<T = unknown>(channel: string, payload: T): void;
  on<T = unknown>(channel: string, handler: EventHandler<T>): () => void;
  once<T = unknown>(channel: string, handler: EventHandler<T>): () => void;
}

// ─────────────────── mcp (Phase 4 will implement) ───────────────────

export interface MCPToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface PlatformMCP {
  /** Start (or attach to) a server registered in mcp-servers.json. */
  ensureRunning(serverName: string): Promise<void>;
  listTools(serverName: string): Promise<MCPToolDescriptor[]>;
  callTool(serverName: string, toolName: string, args: unknown): Promise<unknown>;
  shutdown(serverName?: string): Promise<void>;
  /** 'running' if a connected client exists for this name, else 'stopped'. */
  status(serverName: string): 'running' | 'stopped';
  /** Names of all currently-running servers. */
  running(): string[];
}

// ─────────────────── aggregate ───────────────────

export interface Platform {
  fs: PlatformFS;
  workspace: PlatformWorkspace;
  http: PlatformHTTP;
  events: PlatformEvents;
  mcp: PlatformMCP;
  paths: {
    home: string;
    petWorkspace(petId: string): string;
  };
}
