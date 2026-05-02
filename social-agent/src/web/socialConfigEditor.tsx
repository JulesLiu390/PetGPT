import React, { useState, useEffect, useCallback } from 'react';
import * as api from './api';
import type { SocialConfig, ProviderPublic } from './api';

/**
 * Big sectioned form mirroring Tauri's src/pages/SocialPage.jsx config layout.
 * Loads /api/pets/:petId/social-config, edits in-memory, saves via PUT on demand.
 *
 * Sections (Tauri parity):
 *   1. Basic            — MCP server name + Reply LLM (default)
 *   2. Watched Targets  — groups / friends (one ID per line) + per-target rules
 *   3. Behaviour        — atMustReply / enableImages / imageDescMode / intervals
 *   4. Advanced LLM     — Intent / Observer / Compress / ImageDesc role pickers
 *   5. Image Gen        — generate_image_send config
 *   6. TTS              — voice_send config (ElevenLabs etc.)
 *   7. Subagent         — CC research config
 *   8. Identity         — botQQ / owner / anti-injection delimiters
 *   9. Persona          — personaPrompt / replyStrategyPrompt + agentCanEditStrategy
 */

interface Props {
  petId: string;
  providers: ProviderPublic[];
  onError: (msg: string) => void;
  onSaved?: (cfg: SocialConfig) => void;
}

export function SocialConfigEditor({ petId, providers, onError, onSaved }: Props) {
  const [cfg, setCfg]       = useState<SocialConfig | null>(null);
  const [dirty, setDirty]   = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const c = await api.getSocialConfig(petId);
      setCfg(c);
      setDirty(false);
      setSavedAt(null);
    } catch (e: any) { onError(e.message); }
  }, [petId, onError]);
  useEffect(() => { load(); }, [load]);

  if (!cfg) return <div className="text-sm text-slate-400">loading config…</div>;

  // Generic field setter — marks dirty
  function set<K extends keyof SocialConfig>(key: K, val: SocialConfig[K]) {
    setCfg(prev => prev ? { ...prev, [key]: val } : prev);
    setDirty(true);
  }

  function save() {
    if (!cfg) return;
    setSaving(true);
    api.putSocialConfig(petId, cfg)
      .then(saved => { setCfg(saved); setDirty(false); setSavedAt(Date.now()); onSaved?.(saved); })
      .catch(e => onError(e.message))
      .finally(() => setSaving(false));
  }

  // Helpers for textarea ⇄ string[] editing
  const arrToText = (a: string[]) => a.join('\n');
  const textToArr = (s: string) =>
    s.split('\n').map(x => x.trim()).filter(Boolean);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 sticky top-0 bg-slate-50 z-10 py-2 -mx-2 px-2 border-b border-slate-200">
        <h3 className="font-semibold text-base">Social Config</h3>
        {dirty && <span className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-700">● unsaved</span>}
        {!dirty && savedAt && <span className="text-xs text-emerald-600">saved {new Date(savedAt).toLocaleTimeString()}</span>}
        <button onClick={load} className="ml-auto text-xs px-2 py-1 border border-slate-300 rounded hover:bg-slate-100">Reload</button>
        <button onClick={save} disabled={saving || !dirty}
          className="text-sm px-3 py-1 bg-cyan-600 hover:bg-cyan-700 text-white rounded disabled:opacity-50">
          {saving ? 'saving…' : 'Save'}
        </button>
      </div>

      {/* 1. Basic */}
      <Section title="Basic">
        <Grid cols={2}>
          <Field label="MCP Server Name">
            <input value={cfg.mcpServerName} onChange={e => set('mcpServerName', e.target.value)}
              className="w-full px-2 py-1 border border-slate-300 rounded font-mono"
              placeholder="qq-mcp / telegram-mcp" />
          </Field>
        </Grid>
        <Grid cols={2}>
          <Field label="Default API Provider (Reply LLM)">
            <ProviderPicker value={cfg.apiProviderId} onChange={v => {
              set('apiProviderId', v);
              const p = providers.find(p => p.id === v);
              if (p?.defaultModel && !cfg.modelName) set('modelName', p.defaultModel);
            }} providers={providers} />
          </Field>
          <Field label="Default Model">
            <ModelInput value={cfg.modelName} onChange={v => set('modelName', v)}
              providers={providers} providerId={cfg.apiProviderId} />
          </Field>
        </Grid>
      </Section>

      {/* 2. Watched Targets */}
      <Section title="Watched Targets">
        <Grid cols={2}>
          <Field label="Groups (one QQ id per line)">
            <textarea value={arrToText(cfg.watchedGroups)} onChange={e => set('watchedGroups', textToArr(e.target.value))}
              rows={4} className="w-full px-2 py-1 border border-slate-300 rounded font-mono text-sm"
              placeholder="902317662" />
          </Field>
          <Field label="Friends (one QQ id per line)">
            <textarea value={arrToText(cfg.watchedFriends)} onChange={e => set('watchedFriends', textToArr(e.target.value))}
              rows={4} className="w-full px-2 py-1 border border-slate-300 rounded font-mono text-sm" />
          </Field>
        </Grid>
        <PerTargetRules cfg={cfg} setCfg={(next) => { setCfg(next); setDirty(true); }} />
      </Section>

      {/* 3. Behaviour */}
      <Section title="Behaviour">
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <Toggle label="atMustReply"           value={cfg.atMustReply}          onChange={v => set('atMustReply', v)} />
          <Toggle label="enableImages"          value={cfg.enableImages}         onChange={v => set('enableImages', v)} />
          <Toggle label="agentCanEditStrategy"  value={cfg.agentCanEditStrategy} onChange={v => set('agentCanEditStrategy', v)} />
        </div>
        <Grid cols={3}>
          <Field label="imageDescMode">
            <select value={cfg.imageDescMode} onChange={e => set('imageDescMode', e.target.value as any)}
              className="w-full px-2 py-1 border border-slate-300 rounded">
              <option value="off">off</option>
              <option value="on">on</option>
              <option value="when-mentioned">when-mentioned</option>
            </select>
          </Field>
          <Field label="replyInterval (ms)">
            <input type="number" min={0} value={cfg.replyInterval} onChange={e => set('replyInterval', Number(e.target.value) || 0)}
              className="w-full px-2 py-1 border border-slate-300 rounded font-mono" />
          </Field>
          <Field label="observerInterval (s)">
            <input type="number" min={0} value={cfg.observerInterval} onChange={e => set('observerInterval', Number(e.target.value) || 0)}
              className="w-full px-2 py-1 border border-slate-300 rounded font-mono" />
          </Field>
        </Grid>
      </Section>

      {/* 4. Advanced LLM */}
      <Section title="Advanced LLM (per-role overrides)" defaultOpen={false}>
        <p className="text-xs text-slate-500 mb-2">
          Leave a row blank to fall back to the default Reply LLM above.
        </p>
        <RoleLLMRow label="Intent"    cfg={cfg} set={set} providers={providers} idKey="intentApiProviderId"   modelKey="intentModelName" />
        <RoleLLMRow label="Observer"  cfg={cfg} set={set} providers={providers} idKey="observerApiProviderId" modelKey="observerModelName" />
        <RoleLLMRow label="Compress"  cfg={cfg} set={set} providers={providers} idKey="compressApiProviderId" modelKey="compressModelName" />
        <RoleLLMRow label="Vision (image desc)" cfg={cfg} set={set} providers={providers} idKey="imageDescProviderId" modelKey="imageDescModelName" />
      </Section>

      {/* 5. Image Gen */}
      <Section title="Image Generation (generate_image_send)">
        <Toggle label="Enable" value={cfg.imageGenConfig.enabled}
          onChange={v => set('imageGenConfig', { ...cfg.imageGenConfig, enabled: v })} />
        {cfg.imageGenConfig.enabled && (
          <Grid cols={2}>
            <Field label="Provider">
              <ProviderPicker value={cfg.imageGenConfig.providerId}
                onChange={v => set('imageGenConfig', { ...cfg.imageGenConfig, providerId: v })}
                providers={providers} />
            </Field>
            <Field label="Model">
              <ModelInput value={cfg.imageGenConfig.modelName}
                onChange={v => set('imageGenConfig', { ...cfg.imageGenConfig, modelName: v })}
                providers={providers} providerId={cfg.imageGenConfig.providerId}
                placeholder="gpt-image-2 / dall-e-3 / ..." />
            </Field>
          </Grid>
        )}
      </Section>

      {/* 6. TTS */}
      <Section title="TTS (voice_send)">
        <Toggle label="Enable" value={cfg.ttsConfig.enabled}
          onChange={v => set('ttsConfig', { ...cfg.ttsConfig, enabled: v })} />
        {cfg.ttsConfig.enabled && (
          <>
            <Field label="API Key">
              <input type="password" value={cfg.ttsConfig.apiKey}
                onChange={e => set('ttsConfig', { ...cfg.ttsConfig, apiKey: e.target.value })}
                className="w-full px-2 py-1 border border-slate-300 rounded font-mono" />
            </Field>
            <Grid cols={2}>
              <Field label="Voice ID">
                <input value={cfg.ttsConfig.voiceId}
                  onChange={e => set('ttsConfig', { ...cfg.ttsConfig, voiceId: e.target.value })}
                  className="w-full px-2 py-1 border border-slate-300 rounded font-mono" />
              </Field>
              <Field label="Model ID">
                <input value={cfg.ttsConfig.modelId}
                  onChange={e => set('ttsConfig', { ...cfg.ttsConfig, modelId: e.target.value })}
                  className="w-full px-2 py-1 border border-slate-300 rounded font-mono" />
              </Field>
            </Grid>
          </>
        )}
      </Section>

      {/* 7. Subagent */}
      <Section title="Subagent (CC Research)">
        <Toggle label="Enable" value={cfg.subagentEnabled} onChange={v => set('subagentEnabled', v)} />
        {cfg.subagentEnabled && (
          <Grid cols={3}>
            <Field label="Max Concurrent">
              <input type="number" min={1} value={cfg.subagentMaxConcurrent}
                onChange={e => set('subagentMaxConcurrent', Number(e.target.value) || 1)}
                className="w-full px-2 py-1 border border-slate-300 rounded font-mono" />
            </Field>
            <Field label="Timeout (s)">
              <input type="number" min={1} value={cfg.subagentTimeoutSecs}
                onChange={e => set('subagentTimeoutSecs', Number(e.target.value) || 1)}
                className="w-full px-2 py-1 border border-slate-300 rounded font-mono" />
            </Field>
            <Field label="Model">
              <select value={cfg.subagentModel} onChange={e => set('subagentModel', e.target.value)}
                className="w-full px-2 py-1 border border-slate-300 rounded">
                <option value="haiku">haiku</option>
                <option value="sonnet">sonnet</option>
                <option value="opus">opus</option>
              </select>
            </Field>
          </Grid>
        )}
      </Section>

      {/* 8. Identity */}
      <Section title="Identity & Anti-injection">
        <Grid cols={3}>
          <Field label="botQQ"><input value={cfg.botQQ} onChange={e => set('botQQ', e.target.value)} className="w-full px-2 py-1 border border-slate-300 rounded font-mono" /></Field>
          <Field label="ownerQQ"><input value={cfg.ownerQQ} onChange={e => set('ownerQQ', e.target.value)} className="w-full px-2 py-1 border border-slate-300 rounded font-mono" /></Field>
          <Field label="ownerName"><input value={cfg.ownerName} onChange={e => set('ownerName', e.target.value)} className="w-full px-2 py-1 border border-slate-300 rounded" /></Field>
        </Grid>
        <Field label="ownerSecret (anti-impersonation token)">
          <input type="password" value={cfg.ownerSecret} onChange={e => set('ownerSecret', e.target.value)}
            className="w-full px-2 py-1 border border-slate-300 rounded font-mono" />
        </Field>
        <p className="text-xs text-slate-500 mt-2">
          Delimiters wrap sender names and message bodies in the chat snapshot to prevent injection
          attacks where a message body forges a sender identity.
        </p>
        <Grid cols={4}>
          <Field label="nameDelimiterL"><input value={cfg.nameDelimiterL} onChange={e => set('nameDelimiterL', e.target.value)} className="w-full px-2 py-1 border border-slate-300 rounded font-mono" /></Field>
          <Field label="nameDelimiterR"><input value={cfg.nameDelimiterR} onChange={e => set('nameDelimiterR', e.target.value)} className="w-full px-2 py-1 border border-slate-300 rounded font-mono" /></Field>
          <Field label="msgDelimiterL"><input value={cfg.msgDelimiterL} onChange={e => set('msgDelimiterL', e.target.value)} className="w-full px-2 py-1 border border-slate-300 rounded font-mono" /></Field>
          <Field label="msgDelimiterR"><input value={cfg.msgDelimiterR} onChange={e => set('msgDelimiterR', e.target.value)} className="w-full px-2 py-1 border border-slate-300 rounded font-mono" /></Field>
        </Grid>
      </Section>

      {/* 9. Persona / Strategy */}
      <Section title="Persona & Strategy">
        <Field label="socialPersonaPrompt — extra persona injected on top of SOUL.md">
          <textarea value={cfg.socialPersonaPrompt} onChange={e => set('socialPersonaPrompt', e.target.value)}
            rows={5} className="w-full px-2 py-1 border border-slate-300 rounded text-sm" />
        </Field>
        <Field label="replyStrategyPrompt — overrides DEFAULT_REPLY_STRATEGY when non-empty">
          <textarea value={cfg.replyStrategyPrompt} onChange={e => set('replyStrategyPrompt', e.target.value)}
            rows={6} className="w-full px-2 py-1 border border-slate-300 rounded text-sm" />
        </Field>
      </Section>
    </div>
  );
}

// ─────────────────── sub-components ───────────────────

function Section({ title, defaultOpen = true, children }: { title: string; defaultOpen?: boolean; children: React.ReactNode }) {
  return (
    <details open={defaultOpen} className="bg-white border border-slate-200 rounded">
      <summary className="cursor-pointer px-3 py-2 text-sm font-semibold text-slate-700 select-none hover:bg-slate-50">
        {title}
      </summary>
      <div className="p-3 space-y-3 border-t border-slate-100">{children}</div>
    </details>
  );
}

function Grid({ cols, children }: { cols: 2 | 3 | 4; children: React.ReactNode }) {
  const cls = cols === 2 ? 'grid-cols-2' : cols === 3 ? 'grid-cols-3' : 'grid-cols-4';
  return <div className={`grid ${cls} gap-3`}>{children}</div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs uppercase tracking-wide text-slate-500 mb-1">{label}</span>
      {children}
    </label>
  );
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer text-sm">
      <input type="checkbox" checked={value} onChange={e => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function ProviderPicker({ value, onChange, providers }: {
  value: string; onChange: (v: string) => void; providers: ProviderPublic[];
}) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)}
      className="w-full px-2 py-1 border border-slate-300 rounded">
      <option value="">(none)</option>
      {providers.map(p => <option key={p.id} value={p.id}>{p.name} ({p.type})</option>)}
    </select>
  );
}

function RoleLLMRow({ label, cfg, set, providers, idKey, modelKey }: {
  label: string;
  cfg: SocialConfig;
  set: <K extends keyof SocialConfig>(key: K, val: SocialConfig[K]) => void;
  providers: ProviderPublic[];
  idKey: keyof SocialConfig;
  modelKey: keyof SocialConfig;
}) {
  const id    = cfg[idKey] as string;
  const model = cfg[modelKey] as string;
  return (
    <div className="grid grid-cols-[120px_1fr_1fr] gap-3 items-center">
      <span className="text-xs uppercase tracking-wide text-slate-500">{label}</span>
      <ProviderPicker value={id} onChange={v => set(idKey, v as any)} providers={providers} />
      <ModelInput value={model} onChange={v => set(modelKey, v as any)}
        providers={providers} providerId={id} placeholder="(default)" />
    </div>
  );
}

/**
 * Model input field — combines a free-text input with a <datalist> of the
 * provider's cachedModels. Browsers render this as a typeable combo box:
 * autocomplete suggests cached models but the user can also type any string
 * (e.g. a model name not yet in the cache).
 */
function ModelInput({ value, onChange, providers, providerId, placeholder }: {
  value: string;
  onChange: (v: string) => void;
  providers: ProviderPublic[];
  providerId: string;
  placeholder?: string;
}) {
  const provider = providers.find(p => p.id === providerId);
  const cached = provider?.cachedModels ?? [];
  const listId = `models-${providerId || 'none'}`;
  return (
    <div className="flex items-center gap-2">
      <input value={value} onChange={e => onChange(e.target.value)}
        list={cached.length > 0 ? listId : undefined}
        placeholder={placeholder ?? (provider?.defaultModel ?? '')}
        className="flex-1 px-2 py-1 border border-slate-300 rounded font-mono text-sm" />
      {cached.length > 0 && (
        <datalist id={listId}>
          {cached.map(m => <option key={m} value={m} />)}
        </datalist>
      )}
      {cached.length > 0 && (
        <span className="text-[10px] text-slate-400 whitespace-nowrap">{cached.length} cached</span>
      )}
    </div>
  );
}

function PerTargetRules({ cfg, setCfg }: {
  cfg: SocialConfig;
  setCfg: (next: SocialConfig) => void;
}) {
  const targets = [...cfg.watchedGroups.map(id => ({ id, kind: 'group' as const })),
                   ...cfg.watchedFriends.map(id => ({ id, kind: 'friend' as const }))];
  if (targets.length === 0) return null;
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-xs text-slate-600 hover:text-slate-900">Per-target rules / lurkMode / paused</summary>
      <div className="mt-2 space-y-2">
        {targets.map(t => (
          <div key={`${t.kind}-${t.id}`} className="border border-slate-200 rounded p-2 bg-slate-50">
            <div className="flex items-center gap-2 text-xs mb-1">
              <span className="font-mono text-slate-700">{t.id}</span>
              <span className="text-slate-400">{t.kind}</span>
              <select value={cfg.lurkModes[t.id] ?? 'normal'} onChange={e => {
                setCfg({ ...cfg, lurkModes: { ...cfg.lurkModes, [t.id]: e.target.value as any } });
              }} className="ml-auto px-1 py-0.5 text-xs border border-slate-300 rounded">
                <option value="normal">normal</option>
                <option value="semi-lurk">semi-lurk</option>
                <option value="full-lurk">full-lurk</option>
              </select>
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={!!cfg.pausedTargets[t.id]}
                  onChange={e => setCfg({ ...cfg, pausedTargets: { ...cfg.pausedTargets, [t.id]: e.target.checked } })} />
                <span>paused</span>
              </label>
            </div>
            <textarea
              value={cfg.customGroupRules[t.id] ?? ''}
              onChange={e => setCfg({ ...cfg, customGroupRules: { ...cfg.customGroupRules, [t.id]: e.target.value } })}
              rows={2}
              placeholder="custom rules for this target (overrides RULE_<id>.md guidance)"
              className="w-full px-2 py-1 border border-slate-300 rounded text-xs"
            />
          </div>
        ))}
      </div>
    </details>
  );
}
