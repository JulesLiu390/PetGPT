import React, { useState, useEffect, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import * as api from './api';
import type { Pet, ProviderPublic, Settings, Status } from './api';

// ─────────────────── App shell ───────────────────

type Tab = 'providers' | 'pets' | 'llm' | 'settings';

function App() {
  const [status, setStatus]   = useState<Status | null>(null);
  const [tab,    setTab]      = useState<Tab>('providers');
  const [error,  setError]    = useState<string | null>(null);

  useEffect(() => {
    api.getStatus().then(setStatus).catch(e => setError(e.message));
  }, []);

  if (!status) {
    return <div className="p-8 text-slate-500">loading…</div>;
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800">
      <header className="bg-white border-b border-slate-200 px-6 py-3 flex items-center gap-4">
        <h1 className="font-semibold text-lg">PetGPT-Amadeus</h1>
        <span className="text-xs text-slate-400 font-mono">{status.home}</span>
      </header>

      {error && (
        <div className="bg-red-50 border-b border-red-200 px-6 py-2 text-sm text-red-700 flex justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="text-red-500 hover:text-red-700">×</button>
        </div>
      )}

      <nav className="bg-white border-b border-slate-200 px-6 flex gap-1">
        {(['providers','pets','llm','settings'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm border-b-2 transition-colors ${
              tab === t
                ? 'border-cyan-500 text-cyan-700 font-medium'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            {t === 'llm' ? 'LLM Test' : t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </nav>

      <main className="p-6 max-w-4xl mx-auto">
        {tab === 'providers' && <ProvidersTab onError={setError} />}
        {tab === 'pets'      && <PetsTab      onError={setError} />}
        {tab === 'llm'       && <LLMTab       onError={setError} />}
        {tab === 'settings'  && <SettingsTab  onError={setError} />}
      </main>
    </div>
  );
}

// ─────────────────── Providers ───────────────────

function ProvidersTab({ onError }: { onError: (s: string) => void }) {
  const [items, setItems] = useState<ProviderPublic[]>([]);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    try { setItems(await api.listProviders()); }
    catch (e: any) { onError(e.message); }
  }, [onError]);

  useEffect(() => { refresh(); }, [refresh]);

  const onDelete = async (id: string) => {
    if (!confirm('delete this provider?')) return;
    try { await api.deleteProvider(id); refresh(); }
    catch (e: any) { onError(e.message); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Providers</h2>
        <button
          onClick={() => setCreating(true)}
          className="px-3 py-1 text-sm bg-cyan-600 hover:bg-cyan-700 text-white rounded"
        >
          + Add
        </button>
      </div>

      {creating && (
        <ProviderForm
          onSave={async (input) => {
            try { await api.createProvider(input); setCreating(false); refresh(); }
            catch (e: any) { onError(e.message); }
          }}
          onCancel={() => setCreating(false)}
        />
      )}

      {items.length === 0 && !creating && (
        <div className="text-sm text-slate-400 italic">No providers yet. Click + Add.</div>
      )}

      <div className="space-y-2">
        {items.map(p => (
          <div key={p.id} className="bg-white border border-slate-200 rounded p-4 flex items-start gap-4">
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium">{p.name}</span>
                <span className="text-xs px-2 py-0.5 rounded bg-slate-100 text-slate-600 font-mono">{p.type}</span>
              </div>
              <div className="text-xs text-slate-500 font-mono mt-1">
                {p.baseUrl && <div>baseUrl: {p.baseUrl}</div>}
                {p.defaultModel && <div>defaultModel: {p.defaultModel}</div>}
                <div>apiKey: {p.apiKeyMasked}</div>
              </div>
            </div>
            <button
              onClick={() => onDelete(p.id)}
              className="text-sm text-red-500 hover:text-red-700"
            >
              delete
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function ProviderForm({ onSave, onCancel }: {
  onSave: (input: { type: ProviderPublic['type']; name: string; apiKey: string; baseUrl?: string; defaultModel?: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const [type,    setType]    = useState<ProviderPublic['type']>('openai-compat');
  const [name,    setName]    = useState('');
  const [apiKey,  setApiKey]  = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model,   setModel]   = useState('');
  const [pending, setPending] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPending(true);
    try {
      await onSave({
        type,
        name: name.trim(),
        apiKey: apiKey.trim(),
        baseUrl: baseUrl.trim() || undefined,
        defaultModel: model.trim() || undefined,
      });
    } finally { setPending(false); }
  };

  return (
    <form onSubmit={submit} className="bg-white border border-cyan-200 rounded p-4 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="type">
          <select value={type} onChange={e => setType(e.target.value as any)} className="w-full px-2 py-1 border border-slate-300 rounded">
            <option value="openai-compat">openai-compat</option>
            <option value="anthropic">anthropic</option>
            <option value="gemini">gemini</option>
          </select>
        </Field>
        <Field label="name">
          <input value={name} onChange={e => setName(e.target.value)} required placeholder="e.g. OpenRouter"
            className="w-full px-2 py-1 border border-slate-300 rounded" />
        </Field>
      </div>
      <Field label="apiKey">
        <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} required
          className="w-full px-2 py-1 border border-slate-300 rounded font-mono" />
      </Field>
      <Field label="baseUrl (required for openai-compat / optional for others)">
        <input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="https://openrouter.ai/api/v1"
          className="w-full px-2 py-1 border border-slate-300 rounded font-mono" />
      </Field>
      <Field label="defaultModel (optional)">
        <input value={model} onChange={e => setModel(e.target.value)} placeholder="claude-3-5-haiku-latest"
          className="w-full px-2 py-1 border border-slate-300 rounded font-mono" />
      </Field>
      <div className="flex gap-2 justify-end">
        <button type="button" onClick={onCancel} className="px-3 py-1 text-sm border border-slate-300 rounded hover:bg-slate-100">Cancel</button>
        <button type="submit" disabled={pending} className="px-3 py-1 text-sm bg-cyan-600 hover:bg-cyan-700 text-white rounded disabled:opacity-50">
          {pending ? 'saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}

// ─────────────────── Pets ───────────────────

function PetsTab({ onError }: { onError: (s: string) => void }) {
  const [items, setItems] = useState<Pet[]>([]);
  const [creating, setCreating] = useState(false);
  const [editing,  setEditing]  = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try { setItems(await api.listPets()); }
    catch (e: any) { onError(e.message); }
  }, [onError]);

  useEffect(() => { refresh(); }, [refresh]);

  const onDelete = async (id: string) => {
    if (!confirm('delete this pet?')) return;
    try { await api.deletePet(id); refresh(); }
    catch (e: any) { onError(e.message); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Pets</h2>
        <button onClick={() => setCreating(true)} className="px-3 py-1 text-sm bg-cyan-600 hover:bg-cyan-700 text-white rounded">+ Add</button>
      </div>

      {creating && (
        <PetForm
          onSave={async (input) => {
            try { await api.createPet(input); setCreating(false); refresh(); }
            catch (e: any) { onError(e.message); }
          }}
          onCancel={() => setCreating(false)}
        />
      )}

      {items.length === 0 && !creating && (
        <div className="text-sm text-slate-400 italic">No pets yet.</div>
      )}

      <div className="space-y-2">
        {items.map(p => (
          editing === p.id ? (
            <PetForm
              key={p.id}
              initial={p}
              onSave={async (input) => {
                try { await api.updatePet(p.id, input); setEditing(null); refresh(); }
                catch (e: any) { onError(e.message); }
              }}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <div key={p.id} className="bg-white border border-slate-200 rounded p-4 flex items-start gap-4">
              <div className="flex-1">
                <div className="font-medium">{p.name}</div>
                <div className="text-xs text-slate-400 font-mono">id: {p.id}</div>
                {p.persona && (
                  <div className="text-sm text-slate-600 mt-2 whitespace-pre-wrap">{p.persona}</div>
                )}
              </div>
              <div className="flex gap-2">
                <button onClick={() => setEditing(p.id)} className="text-sm text-cyan-600 hover:text-cyan-800">edit</button>
                <button onClick={() => onDelete(p.id)} className="text-sm text-red-500 hover:text-red-700">delete</button>
              </div>
            </div>
          )
        ))}
      </div>
    </div>
  );
}

function PetForm({ initial, onSave, onCancel }: {
  initial?: Pet;
  onSave: (input: { name: string; persona?: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [persona, setPersona] = useState(initial?.persona ?? '');
  const [pending, setPending] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPending(true);
    try { await onSave({ name: name.trim(), persona: persona.trim() || undefined }); }
    finally { setPending(false); }
  };

  return (
    <form onSubmit={submit} className="bg-white border border-cyan-200 rounded p-4 space-y-3">
      <Field label="name">
        <input value={name} onChange={e => setName(e.target.value)} required
          className="w-full px-2 py-1 border border-slate-300 rounded" />
      </Field>
      <Field label="persona (system prompt fragment, optional)">
        <textarea value={persona} onChange={e => setPersona(e.target.value)} rows={4}
          className="w-full px-2 py-1 border border-slate-300 rounded font-mono text-sm" />
      </Field>
      <div className="flex gap-2 justify-end">
        <button type="button" onClick={onCancel} className="px-3 py-1 text-sm border border-slate-300 rounded hover:bg-slate-100">Cancel</button>
        <button type="submit" disabled={pending} className="px-3 py-1 text-sm bg-cyan-600 hover:bg-cyan-700 text-white rounded disabled:opacity-50">
          {pending ? 'saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}

// ─────────────────── LLM Test ───────────────────

function LLMTab({ onError }: { onError: (s: string) => void }) {
  const [providers, setProviders] = useState<ProviderPublic[]>([]);
  const [providerId, setProviderId] = useState<string>('');
  const [model,    setModel]    = useState('');
  const [prompt,   setPrompt]   = useState('hi, in one sentence describe yourself');
  const [pending,  setPending]  = useState(false);
  const [result,   setResult]   = useState<api.LLMTestResult | null>(null);

  useEffect(() => {
    api.listProviders().then(ps => {
      setProviders(ps);
      if (ps[0]) {
        setProviderId(ps[0].id);
        if (ps[0].defaultModel) setModel(ps[0].defaultModel);
      }
    }).catch(e => onError(e.message));
  }, [onError]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPending(true); setResult(null);
    try {
      setResult(await api.llmTest({ providerId, model, prompt, maxTokens: 256 }));
    } catch (e: any) { onError(e.message); }
    finally { setPending(false); }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <h2 className="text-lg font-semibold">LLM Test</h2>
      <Field label="provider">
        <select value={providerId} onChange={e => {
          setProviderId(e.target.value);
          const p = providers.find(p => p.id === e.target.value);
          if (p?.defaultModel) setModel(p.defaultModel);
        }} className="w-full px-2 py-1 border border-slate-300 rounded">
          {providers.map(p => <option key={p.id} value={p.id}>{p.name} ({p.type})</option>)}
        </select>
      </Field>
      <Field label="model">
        <input value={model} onChange={e => setModel(e.target.value)} required
          className="w-full px-2 py-1 border border-slate-300 rounded font-mono" />
      </Field>
      <Field label="prompt">
        <textarea value={prompt} onChange={e => setPrompt(e.target.value)} required rows={3}
          className="w-full px-2 py-1 border border-slate-300 rounded" />
      </Field>
      <button type="submit" disabled={pending || !providerId || !model || !prompt}
        className="px-4 py-2 text-sm bg-cyan-600 hover:bg-cyan-700 text-white rounded disabled:opacity-50">
        {pending ? 'calling…' : 'Send'}
      </button>

      {result && (
        <div className="bg-white border border-slate-200 rounded p-4 space-y-2">
          <div className="flex gap-3 text-xs text-slate-500 font-mono">
            <span>{result.elapsedMs}ms</span>
            <span>in {result.inputTokens}</span>
            <span>out {result.outputTokens}</span>
            <span>finish: {result.finishReason}</span>
            <span className="ml-auto">{result.model}</span>
          </div>
          <div className="text-sm whitespace-pre-wrap">{result.content}</div>
        </div>
      )}
    </form>
  );
}

// ─────────────────── Settings ───────────────────

function SettingsTab({ onError }: { onError: (s: string) => void }) {
  const [s, setS] = useState<Settings | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    api.getSettings().then(setS).catch(e => onError(e.message));
  }, [onError]);

  if (!s) return <div className="text-sm text-slate-400">loading…</div>;

  const save = async (partial: Partial<Settings>) => {
    try { setS(await api.patchSettings(partial)); setSavedAt(Date.now()); }
    catch (e: any) { onError(e.message); }
  };

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Settings</h2>
      <Field label="port (restart server to apply)">
        <input type="number" value={s.port} onChange={e => setS({ ...s, port: Number(e.target.value) })}
          onBlur={e => save({ port: Number(e.target.value) })}
          className="w-32 px-2 py-1 border border-slate-300 rounded font-mono" />
      </Field>
      <Field label="logLevel">
        <select value={s.logLevel} onChange={e => save({ logLevel: e.target.value as Settings['logLevel'] })}
          className="px-2 py-1 border border-slate-300 rounded">
          <option value="debug">debug</option>
          <option value="info">info</option>
          <option value="warn">warn</option>
          <option value="error">error</option>
        </select>
      </Field>
      {savedAt && (
        <div className="text-xs text-emerald-600">saved {new Date(savedAt).toLocaleTimeString()}</div>
      )}
    </div>
  );
}

// ─────────────────── helpers ───────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs uppercase tracking-wide text-slate-500 mb-1">{label}</span>
      {children}
    </label>
  );
}

// ─────────────────── mount ───────────────────

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
