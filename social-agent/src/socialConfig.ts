import { readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveHome } from './paths.ts';
import { withStoreLock, ConflictError } from './storeLock.ts';

/**
 * Per-pet social agent configuration.
 *
 * Schema is a direct port of the Tauri-side `config` object in
 * src/pages/SocialPage.jsx — every field name matches so users can
 * "feel at home".
 *
 * Persisted at ~/.social-agent/pets/{petId}/social-config.json (mode 0600).
 */

export type LurkMode    = 'normal' | 'semi-lurk' | 'full-lurk';
export type ImageDescMode = 'off' | 'on' | 'when-mentioned';

export interface ImageGenConfig {
  enabled: boolean;
  providerId: string;
  modelName: string;
}

export interface TtsConfig {
  enabled: boolean;
  apiKey: string;
  voiceId: string;
  modelId: string;
}

export interface SocialConfig {
  petId: string;

  /**
   * Optimistic-lock stamp, set on every save. Clients echo back the value
   * they loaded; a full PUT with a stale stamp is rejected with a conflict
   * so two concurrent editors can't silently clobber each other.
   * 0 = never saved / legacy file.
   */
  updatedAt: number;

  // ─── MCP ───
  mcpServerName: string;

  // ─── LLM endpoints (provider id → providers.json entry) ───
  apiProviderId:        string;   // Reply LLM (also the default for any unset role)
  modelName:            string;
  intentApiProviderId:  string;   // Intent LLM
  intentModelName:      string;
  observerApiProviderId: string;  // Observer LLM
  observerModelName:    string;
  compressApiProviderId: string;  // history-compression LLM
  compressModelName:    string;
  imageDescProviderId:  string;   // vision LLM (describes incoming images)
  imageDescModelName:   string;

  // ─── Image generation (generate_image_send tool) ───
  imageGenConfig: ImageGenConfig;

  // ─── TTS (voice_send tool) ───
  ttsConfig: TtsConfig;

  // ─── Watched targets ───
  watchedGroups:  string[];   // group QQ ids
  watchedFriends: string[];   // friend QQ ids
  customGroupRules: Record<string, string>;   // per-target user-defined rules
  lurkModes:        Record<string, LurkMode>; // per-target lurk override
  pausedTargets:    Record<string, boolean>;  // per-target pause flag

  // ─── Bot identity ───
  botQQ:       string;
  ownerQQ:     string;
  ownerName:   string;
  ownerSecret: string;

  // ─── Anti-injection delimiters around sender names / message bodies ───
  nameDelimiterL: string;
  nameDelimiterR: string;
  msgDelimiterL:  string;
  msgDelimiterR:  string;

  // ─── Behaviour ───
  socialPersonaPrompt:   string;
  replyStrategyPrompt:   string;
  agentCanEditStrategy:  boolean;
  atMustReply:           boolean;
  enableImages:          boolean;
  imageDescMode:         ImageDescMode;

  // ─── Intervals ───
  replyInterval:    number;    // ms cooldown between Reply tasks per target
  observerInterval: number;    // seconds between Observer evals

  // ─── Subagent (CC) ───
  subagentEnabled:       boolean;
  subagentMaxConcurrent: number;
  subagentTimeoutSecs:   number;
  subagentModel:         string;
}

/** Defaults — matches the Tauri SocialPage initial useState config. */
export function defaultSocialConfig(petId: string): SocialConfig {
  return {
    petId,
    updatedAt: 0,
    mcpServerName: '',
    apiProviderId: '',
    modelName: '',
    intentApiProviderId: '',
    intentModelName: '',
    observerApiProviderId: '',
    observerModelName: '',
    compressApiProviderId: '',
    compressModelName: '',
    imageDescProviderId: '',
    imageDescModelName: '',
    imageGenConfig: { enabled: false, providerId: '', modelName: '' },
    ttsConfig:      { enabled: false, apiKey: '', voiceId: '', modelId: '' },
    watchedGroups:  [],
    watchedFriends: [],
    customGroupRules: {},
    lurkModes:        {},
    pausedTargets:    {},
    botQQ:       '',
    ownerQQ:     '',
    ownerName:   '',
    ownerSecret: '',
    nameDelimiterL: '',
    nameDelimiterR: '',
    msgDelimiterL:  '',
    msgDelimiterR:  '',
    socialPersonaPrompt:  '',
    replyStrategyPrompt:  '',
    agentCanEditStrategy: false,
    atMustReply:    true,
    enableImages:   true,
    imageDescMode:  'off',
    replyInterval:    0,
    observerInterval: 180,
    subagentEnabled:        true,
    subagentMaxConcurrent:  5,
    subagentTimeoutSecs:    300,
    subagentModel:          'sonnet',
  };
}

// ─────────────────── disk I/O ───────────────────

function configPath(petId: string): string {
  return join(resolveHome(), 'pets', petId, 'social-config.json');
}

/**
 * Read the social config for a pet. Missing file → returns defaults.
 * Existing file is shallow-merged onto defaults so newly-added fields
 * acquire sane values without manual migration.
 */
export async function readSocialConfig(petId: string): Promise<SocialConfig> {
  const path = configPath(petId);
  if (!existsSync(path)) return defaultSocialConfig(petId);
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<SocialConfig>;
    return { ...defaultSocialConfig(petId), ...parsed, petId };  // petId always wins
  } catch {
    return defaultSocialConfig(petId);
  }
}

/** Unlocked atomic write with mode 0600. Callers hold the per-pet store lock. */
async function persist(petId: string, cfg: SocialConfig): Promise<SocialConfig> {
  // Deep-clone-style sanity: ensure the canonical shape (drop unknown keys)
  const def = defaultSocialConfig(petId);
  const next: SocialConfig = { ...def, ...cfg, petId, updatedAt: Date.now() };
  const path = configPath(petId);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
  await chmod(tmp, 0o600);
  await rename(tmp, path);
  return next;
}

/**
 * Optimistic-lock guard: a write carrying a stale `updatedAt` means the
 * caller edited on top of an outdated copy — reject rather than clobber the
 * other editor's save. Only writes that omit the field entirely (callers
 * predating the stamp) skip the check; 0 is a real value ("loaded a
 * never-saved config") and must still match.
 */
function assertNotStale(cur: SocialConfig, incomingUpdatedAt: number | undefined): void {
  if (typeof incomingUpdatedAt !== 'number') return;
  if (incomingUpdatedAt !== cur.updatedAt) {
    throw new ConflictError(
      `social config was modified elsewhere (loaded=${incomingUpdatedAt}, current=${cur.updatedAt}) — reload before saving`,
    );
  }
}

/** Full replace. Rejects with ConflictError if `cfg.updatedAt` is stale. */
export async function writeSocialConfig(petId: string, cfg: SocialConfig): Promise<SocialConfig> {
  return withStoreLock(configPath(petId), async () => {
    const cur = await readSocialConfig(petId);
    assertNotStale(cur, cfg.updatedAt);
    return persist(petId, cfg);
  });
}

/** Patch — shallow merge user-supplied fields onto current config. */
export async function patchSocialConfig(petId: string, partial: Partial<SocialConfig>): Promise<SocialConfig> {
  return withStoreLock(configPath(petId), async () => {
    const cur = await readSocialConfig(petId);
    assertNotStale(cur, partial.updatedAt);
    // Nested objects need their own merge so the LLM picker etc. preserve siblings.
    const next: SocialConfig = {
      ...cur,
      ...partial,
      petId,
      imageGenConfig: { ...cur.imageGenConfig, ...(partial.imageGenConfig || {}) },
      ttsConfig:      { ...cur.ttsConfig,      ...(partial.ttsConfig || {}) },
      customGroupRules: { ...cur.customGroupRules, ...(partial.customGroupRules || {}) },
      lurkModes:        { ...cur.lurkModes,        ...(partial.lurkModes || {}) },
      pausedTargets:    { ...cur.pausedTargets,    ...(partial.pausedTargets || {}) },
    };
    return persist(petId, next);
  });
}
