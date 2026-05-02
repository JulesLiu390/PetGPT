import React, { useState, useEffect, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import * as api from './api';
import type { Pet, ProviderPublic, Settings, Status } from './api';
import { SocialConfigEditor } from './socialConfigEditor';

// ─────────────────── App shell ───────────────────

type Tab = 'sessions' | 'providers' | 'mcp' | 'pets' | 'llm' | 'settings';

function App() {
  const [status, setStatus]   = useState<Status | null>(null);
  const [tab,    setTab]      = useState<Tab>('sessions');
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
        {(['sessions','providers','mcp','pets','llm','settings'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm border-b-2 transition-colors ${
              tab === t
                ? 'border-cyan-500 text-cyan-700 font-medium'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            {t === 'llm' ? 'LLM Test' : t === 'mcp' ? 'MCP' : t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </nav>

      <main className={`p-6 mx-auto ${tab === 'sessions' ? 'max-w-7xl' : 'max-w-4xl'}`}>
        {tab === 'sessions'  && <SessionsTab  onError={setError} />}
        {tab === 'providers' && <ProvidersTab onError={setError} />}
        {tab === 'mcp'       && <MCPTab       onError={setError} />}
        {tab === 'pets'      && <PetsTab      onError={setError} />}
        {tab === 'llm'       && <LLMTab       onError={setError} />}
        {tab === 'settings'  && <SettingsTab  onError={setError} />}
      </main>
    </div>
  );
}

// ─────────────────── Sessions (real-time WS feed) ───────────────────

interface AgentEventBase { type: string; ts: number; targetId?: string; [k: string]: any }

function useAgentWS(onError: (s: string) => void) {
  const [connected, setConnected] = useState(false);
  const [sessions,  setSessions]  = useState<api.SessionView[]>([]);
  const [events,    setEvents]    = useState<AgentEventBase[]>([]);

  const refresh = useCallback(() => {
    api.listSessions().then(setSessions).catch(e => onError(e.message));
  }, [onError]);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let alive = true;
    try {
      ws = new WebSocket(api.agentWsUrl());
    } catch (e: any) {
      onError(`WS connect failed: ${e?.message ?? e}`);
      return;
    }

    ws.onopen    = () => { if (alive) setConnected(true); };
    ws.onclose   = () => { if (alive) setConnected(false); };
    ws.onerror   = () => { if (alive) setConnected(false); };
    ws.onmessage = (e) => {
      if (!alive) return;
      let msg: any;
      try { msg = JSON.parse(e.data); } catch { return; }

      if (msg.type === 'snapshot' && Array.isArray(msg.sessions)) {
        setSessions(msg.sessions);
        return;
      }
      if (msg.type === 'hello') return;

      // It's an AgentEvent
      setEvents(prev => {
        const next = [...prev, msg as AgentEventBase];
        return next.length > 500 ? next.slice(-500) : next;
      });

      // Refresh sessions snapshot on lifecycle / plan events
      if (msg.type?.startsWith('session:') || msg.type === 'eval:plan' || msg.type === 'eval:done') {
        refresh();
      }
    };

    return () => { alive = false; ws?.close(); };
  }, [refresh, onError]);

  return { connected, sessions, events, refresh };
}

const EVENT_COLOR: Record<string, string> = {
  'session:created': 'text-emerald-700 bg-emerald-50',
  'session:stopped': 'text-slate-500 bg-slate-100',
  'session:paused':  'text-amber-700 bg-amber-50',
  'session:resumed': 'text-emerald-700 bg-emerald-50',
  'eval:start':      'text-cyan-700 bg-cyan-50',
  'eval:tool':       'text-slate-600 bg-slate-50',
  'eval:plan':       'text-violet-700 bg-violet-50',
  'eval:done':       'text-cyan-700 bg-cyan-50',
  'eval:error':      'text-red-700 bg-red-50',
  'reply:spawn':     'text-pink-700 bg-pink-50',
  'reply:skip':      'text-amber-700 bg-amber-50',
  'reply:tool':      'text-slate-600 bg-slate-50',
  'reply:sent':      'text-emerald-700 bg-emerald-50',
  'reply:done':      'text-pink-700 bg-pink-50',
  'reply:error':     'text-red-700 bg-red-50',
};

function SessionsTab({ onError }: { onError: (s: string) => void }) {
  const { connected, sessions, events, refresh } = useAgentWS(onError);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating,   setCreating]   = useState(false);
  const [feeding,    setFeeding]    = useState(false);
  const [feedText,   setFeedText]   = useState('');

  // Pet picker + provider list (drives the social config editor up top)
  const [pets,         setPets]         = useState<Pet[]>([]);
  const [providers,    setProviders]    = useState<ProviderPublic[]>([]);
  const [editingPetId, setEditingPetId] = useState<string>('');
  useEffect(() => {
    api.listPets().then(ps => {
      setPets(ps);
      if (!editingPetId && ps[0]) setEditingPetId(ps[0].id);
    }).catch(e => onError(e.message));
    api.listProviders().then(setProviders).catch(e => onError(e.message));
  }, [onError]);

  const selected = sessions.find(s => s.config.targetId === selectedId);
  const selectedEvents = selectedId ? events.filter(e => e.targetId === selectedId) : [];

  // auto-select first session when sessions arrive and nothing selected
  useEffect(() => {
    if (!selectedId && sessions.length > 0) setSelectedId(sessions[0].config.targetId);
  }, [sessions, selectedId]);

  const onStop = async (id: string) => {
    if (!confirm(`stop session "${id}"?`)) return;
    try { await api.stopSession(id); }
    catch (e: any) { onError(e.message); }
    if (selectedId === id) setSelectedId(null);
    refresh();
  };
  const onPause  = async (id: string) => { try { await api.pauseSession(id);  refresh(); } catch (e: any) { onError(e.message); } };
  const onResume = async (id: string) => { try { await api.resumeSession(id); refresh(); } catch (e: any) { onError(e.message); } };
  const onFeed   = async () => {
    if (!selectedId || !feedText.trim()) return;
    setFeeding(true);
    try { await api.feedSession(selectedId, feedText); setFeedText(''); }
    catch (e: any) { onError(e.message); }
    finally { setFeeding(false); }
  };

  return (
    <div className="space-y-4">
      {/* ── Pet picker + Social Config editor (Tauri parity) ── */}
      {pets.length === 0 ? (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded p-3">
          No pets yet — add one in the <strong>Pets</strong> tab to start configuring a social agent.
        </div>
      ) : (
        <div className="bg-slate-50 border border-slate-200 rounded p-3 space-y-3">
          <div className="flex items-center gap-2">
            <label className="text-xs uppercase tracking-wide text-slate-500">Editing pet:</label>
            <select value={editingPetId} onChange={e => setEditingPetId(e.target.value)}
              className="px-2 py-1 border border-slate-300 rounded text-sm">
              {pets.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          {editingPetId && (
            <SocialConfigEditor petId={editingPetId} providers={providers} onError={onError} />
          )}
        </div>
      )}

      {/* ── Active sessions header ── */}
      <div className="flex items-center gap-3">
        <h2 className="text-lg font-semibold">Active Sessions</h2>
        <span className={`text-xs px-2 py-0.5 rounded-full ${connected ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
          {connected ? '● connected' : '○ disconnected'}
        </span>
        <span className="text-xs text-slate-400">{sessions.length} session{sessions.length === 1 ? '' : 's'}</span>
        <button
          onClick={() => setCreating(true)}
          className="ml-auto px-3 py-1 text-sm bg-cyan-600 hover:bg-cyan-700 text-white rounded"
        >+ Start Session</button>
      </div>

      {creating && (
        <SessionForm
          onSave={async (cfg) => {
            try { await api.createSession(cfg); setCreating(false); setSelectedId(cfg.targetId); refresh(); }
            catch (e: any) { onError(e.message); }
          }}
          onCancel={() => setCreating(false)}
        />
      )}

      {sessions.length === 0 && !creating && (
        <div className="text-sm text-slate-400 italic">No sessions yet. Click + Start Session.</div>
      )}

      {sessions.length > 0 && (
        <div className="grid grid-cols-12 gap-4">
          {/* Left: sessions list */}
          <div className="col-span-4 space-y-2">
            {sessions.map(s => (
              <SessionRow
                key={s.config.targetId}
                s={s}
                selected={s.config.targetId === selectedId}
                onClick={() => setSelectedId(s.config.targetId)}
                onPause={() => onPause(s.config.targetId)}
                onResume={() => onResume(s.config.targetId)}
                onStop={() => onStop(s.config.targetId)}
              />
            ))}
          </div>

          {/* Right: session detail + event stream */}
          <div className="col-span-8 space-y-3">
            {selected ? (
              <>
                <SessionDetail s={selected} />

                {/* Feed snapshot */}
                <div className="bg-white border border-slate-200 rounded p-3 space-y-2">
                  <div className="text-xs font-semibold text-slate-600 uppercase">Feed Chat Snapshot</div>
                  <textarea
                    value={feedText}
                    onChange={e => setFeedText(e.target.value)}
                    placeholder="[14:00] Bob(2222) [#abc1]: 这个问题怎么解决？"
                    rows={3}
                    className="w-full px-2 py-1 border border-slate-300 rounded font-mono text-sm"
                  />
                  <button
                    onClick={onFeed}
                    disabled={feeding || !feedText.trim()}
                    className="px-3 py-1 text-sm bg-cyan-600 hover:bg-cyan-700 text-white rounded disabled:opacity-50"
                  >{feeding ? 'feeding…' : 'Feed → trigger eval'}</button>
                </div>

                {/* Event stream */}
                <EventStream events={selectedEvents} />
              </>
            ) : (
              <div className="text-sm text-slate-400 italic">Select a session to inspect.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SessionRow({ s, selected, onClick, onPause, onResume, onStop }: {
  s: api.SessionView;
  selected: boolean;
  onClick: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className={`bg-white border rounded p-3 cursor-pointer transition-colors ${
        selected ? 'border-cyan-500 ring-1 ring-cyan-200' : 'border-slate-200 hover:border-slate-300'
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="font-medium truncate">{s.config.targetName || s.config.targetId}</span>
        <span className="text-xs text-slate-400">{s.config.targetType ?? 'group'}</span>
        <span className="ml-auto" />
        <StatusPill status={s.status} />
      </div>
      <div className="text-xs text-slate-500 font-mono mt-1 truncate">
        targetId: {s.config.targetId}
      </div>
      <div className="text-xs text-slate-400 mt-1">
        evals: {s.evalCount}{s.lastEvalAt ? ` · last ${new Date(s.lastEvalAt).toLocaleTimeString()}` : ''}
        {s.hasPendingSnapshot && <span className="ml-2 text-amber-600">⏳ queued</span>}
      </div>
      <div className="flex gap-2 mt-2 text-xs" onClick={e => e.stopPropagation()}>
        {s.status === 'paused'
          ? <button onClick={onResume} className="px-2 py-0.5 rounded border border-emerald-300 text-emerald-700 hover:bg-emerald-50">▶ resume</button>
          : <button onClick={onPause}  className="px-2 py-0.5 rounded border border-amber-300 text-amber-700 hover:bg-amber-50">⏸ pause</button>}
        <button onClick={onStop} className="px-2 py-0.5 rounded border border-red-300 text-red-600 hover:bg-red-50">⏹ stop</button>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: api.SessionView['status'] }) {
  const cls =
    status === 'evaluating' ? 'bg-cyan-100 text-cyan-700' :
    status === 'paused'     ? 'bg-amber-100 text-amber-700' :
                              'bg-slate-100 text-slate-600';
  const label =
    status === 'evaluating' ? '⚙️ thinking' :
    status === 'paused'     ? '⏸ paused' :
                              '○ idle';
  return <span className={`text-xs px-2 py-0.5 rounded-full ${cls}`}>{label}</span>;
}

function SessionDetail({ s }: { s: api.SessionView }) {
  return (
    <div className="bg-white border border-slate-200 rounded p-3 space-y-2 text-sm">
      <div className="text-xs font-semibold text-slate-600 uppercase">Session Detail</div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs font-mono">
        <span className="text-slate-400">petId:</span>     <span className="truncate">{s.config.petId}</span>
        <span className="text-slate-400">targetId:</span>  <span>{s.config.targetId}</span>
        <span className="text-slate-400">model:</span>     <span>{s.config.model}</span>
        <span className="text-slate-400">lurkMode:</span>  <span>{s.config.lurkMode ?? 'normal'}</span>
        <span className="text-slate-400">created:</span>   <span>{new Date(s.createdAt).toLocaleString()}</span>
        <span className="text-slate-400">evalCount:</span> <span>{s.evalCount}</span>
      </div>
      {s.lastPlan && (
        <details className="text-xs">
          <summary className="cursor-pointer font-semibold text-violet-700">Last Plan ▾</summary>
          <div className="mt-2 space-y-2">
            <div>
              <div className="text-slate-500 font-semibold">state</div>
              <pre className="whitespace-pre-wrap break-words bg-violet-50 p-2 rounded text-violet-900">{s.lastPlan.state}</pre>
            </div>
            {s.lastPlan.brief && (
              <div>
                <div className="text-slate-500 font-semibold">brief</div>
                <pre className="whitespace-pre-wrap break-words bg-pink-50 p-2 rounded text-pink-900">{s.lastPlan.brief}</pre>
              </div>
            )}
            <div>
              <div className="text-slate-500 font-semibold">actions</div>
              <pre className="whitespace-pre-wrap break-words bg-slate-50 p-2 rounded">{JSON.stringify(s.lastPlan.actions, null, 2)}</pre>
            </div>
          </div>
        </details>
      )}
    </div>
  );
}

function EventStream({ events }: { events: AgentEventBase[] }) {
  const reversed = [...events].reverse();   // newest first
  return (
    <div className="bg-white border border-slate-200 rounded p-3">
      <div className="text-xs font-semibold text-slate-600 uppercase mb-2">Event Stream ({events.length})</div>
      {events.length === 0 ? (
        <div className="text-xs text-slate-400 italic">no events yet — try Feed to trigger an eval.</div>
      ) : (
        <div className="space-y-1 max-h-[60vh] overflow-y-auto font-mono text-xs">
          {reversed.map((e, i) => (
            <details key={`${e.ts}-${i}`} className={`rounded px-2 py-1 ${EVENT_COLOR[e.type] ?? 'text-slate-600 bg-slate-50'}`}>
              <summary className="cursor-pointer flex items-center gap-2">
                <span className="text-slate-400">{new Date(e.ts).toLocaleTimeString()}</span>
                <span className="font-semibold">{e.type}</span>
                <EventSummary e={e} />
              </summary>
              <pre className="mt-1 whitespace-pre-wrap break-words text-[10px] text-slate-700">
                {JSON.stringify(e, null, 2)}
              </pre>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}

function EventSummary({ e }: { e: AgentEventBase }) {
  if (e.type === 'eval:tool')  return <span className="truncate"> {e.name}{e.isError ? ' ❌' : ''}</span>;
  if (e.type === 'eval:plan')  return <span className="truncate"> actions=[{e.plan?.actions?.map((a: any) => a.type).join(',')}]</span>;
  if (e.type === 'eval:done')  return <span className="truncate"> iter={e.iterations} {e.elapsedMs}ms{e.hadPlan ? ' ✓ plan' : ''}</span>;
  if (e.type === 'reply:spawn') return <span className="truncate"> #{e.replyId?.slice(0, 8)} (in-flight {e.inFlightCount})</span>;
  if (e.type === 'reply:sent') return <span className="truncate"> "{(e.content ?? '').slice(0, 40)}{e.content?.length > 40 ? '…' : ''}"</span>;
  if (e.type === 'reply:done') return <span className="truncate"> {e.sent ? '✓ sent' : '○ no-send'} · {e.elapsedMs}ms</span>;
  if (e.type === 'reply:skip') return <span className="truncate"> {e.reason}</span>;
  return null;
}

function SessionForm({ onSave, onCancel }: {
  onSave: (cfg: api.SessionConfig) => Promise<void>;
  onCancel: () => void;
}) {
  const [pets,      setPets]      = useState<Pet[]>([]);
  const [providers, setProviders] = useState<ProviderPublic[]>([]);
  useEffect(() => {
    api.listPets().then(setPets).catch(() => {});
    api.listProviders().then(setProviders).catch(() => {});
  }, []);

  const [petId,         setPetId]      = useState('');
  const [targetId,      setTargetId]   = useState('');
  const [targetType,    setTargetType] = useState<api.TargetType>('group');
  const [targetName,    setTargetName] = useState('');
  const [providerId,    setProviderId] = useState('');
  const [model,         setModel]      = useState('');
  const [botQQ,         setBotQQ]      = useState('');
  const [lurkMode,      setLurkMode]   = useState<api.LurkMode>('normal');
  const [pending,       setPending]    = useState(false);

  // Auto-fill defaults when lists arrive
  useEffect(() => { if (!petId && pets.length > 0)           setPetId(pets[0].id); }, [pets, petId]);
  useEffect(() => {
    if (!providerId && providers.length > 0) {
      setProviderId(providers[0].id);
      if (providers[0].defaultModel) setModel(providers[0].defaultModel);
    }
  }, [providers, providerId]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!petId || !targetId.trim() || !providerId || !model.trim()) return;
    setPending(true);
    try {
      await onSave({
        petId,
        targetId: targetId.trim(),
        targetType,
        targetName: targetName.trim() || undefined,
        providerId,
        model: model.trim(),
        botQQ: botQQ.trim() || undefined,
        lurkMode,
      });
    } finally { setPending(false); }
  };

  return (
    <form onSubmit={submit} className="bg-white border border-cyan-200 rounded p-4 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="pet">
          <select value={petId} onChange={e => setPetId(e.target.value)} required
            className="w-full px-2 py-1 border border-slate-300 rounded">
            {pets.length === 0 && <option value="">(no pets — add one in Pets tab)</option>}
            {pets.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <Field label="provider">
          <select value={providerId} onChange={e => {
            setProviderId(e.target.value);
            const p = providers.find(p => p.id === e.target.value);
            if (p?.defaultModel) setModel(p.defaultModel);
          }} required className="w-full px-2 py-1 border border-slate-300 rounded">
            {providers.length === 0 && <option value="">(no providers — add one in Providers tab)</option>}
            {providers.map(p => <option key={p.id} value={p.id}>{p.name} ({p.type})</option>)}
          </select>
        </Field>
      </div>
      <Field label="model">
        <input value={model} onChange={e => setModel(e.target.value)} required
          placeholder="claude-sonnet-4-6 / gpt-4 / ..."
          className="w-full px-2 py-1 border border-slate-300 rounded font-mono" />
      </Field>
      <div className="grid grid-cols-3 gap-3">
        <Field label="targetId (e.g. group QQ)">
          <input value={targetId} onChange={e => setTargetId(e.target.value)} required
            placeholder="902317662"
            className="w-full px-2 py-1 border border-slate-300 rounded font-mono" />
        </Field>
        <Field label="targetType">
          <select value={targetType} onChange={e => setTargetType(e.target.value as api.TargetType)}
            className="w-full px-2 py-1 border border-slate-300 rounded">
            <option value="group">group</option>
            <option value="friend">friend</option>
          </select>
        </Field>
        <Field label="lurkMode">
          <select value={lurkMode} onChange={e => setLurkMode(e.target.value as api.LurkMode)}
            className="w-full px-2 py-1 border border-slate-300 rounded">
            <option value="normal">normal</option>
            <option value="semi-lurk">semi-lurk</option>
            <option value="full-lurk">full-lurk</option>
          </select>
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="targetName (optional)">
          <input value={targetName} onChange={e => setTargetName(e.target.value)}
            placeholder="测试群"
            className="w-full px-2 py-1 border border-slate-300 rounded" />
        </Field>
        <Field label="botQQ (optional)">
          <input value={botQQ} onChange={e => setBotQQ(e.target.value)}
            placeholder="bot QQ number for self-recognition"
            className="w-full px-2 py-1 border border-slate-300 rounded font-mono" />
        </Field>
      </div>
      <div className="flex gap-2 justify-end">
        <button type="button" onClick={onCancel} className="px-3 py-1 text-sm border border-slate-300 rounded hover:bg-slate-100">Cancel</button>
        <button type="submit" disabled={pending} className="px-3 py-1 text-sm bg-cyan-600 hover:bg-cyan-700 text-white rounded disabled:opacity-50">
          {pending ? 'starting…' : 'Start'}
        </button>
      </div>
    </form>
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
          <ProviderRow key={p.id} p={p} onDelete={() => onDelete(p.id)} onRefresh={refresh} onError={onError} />
        ))}
      </div>
    </div>
  );
}

function ProviderRow({ p, onDelete, onRefresh, onError }: {
  p: ProviderPublic;
  onDelete: () => void;
  onRefresh: () => void;
  onError: (s: string) => void;
}) {
  const [fetching, setFetching] = useState(false);
  const onFetchModels = async () => {
    setFetching(true);
    try { const r = await api.fetchProviderModels(p.id); onRefresh(); alert(`✓ fetched ${r.count} models`); }
    catch (e: any) { onError(e.message); }
    finally { setFetching(false); }
  };
  return (
    <div className="bg-white border border-slate-200 rounded p-4 flex items-start gap-4">
      <div className="flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium">{p.name}</span>
          <span className="text-xs px-2 py-0.5 rounded bg-slate-100 text-slate-600 font-mono">{p.apiFormat}</span>
        </div>
        <div className="text-xs text-slate-500 font-mono mt-1">
          {p.baseUrl && <div>baseUrl: {p.baseUrl}</div>}
          {p.defaultModel && <div>defaultModel: {p.defaultModel}</div>}
          <div>apiKey: {p.apiKeyMasked}</div>
          <div className="mt-1">
            cachedModels: {p.cachedModels?.length
              ? <span className="text-emerald-600">{p.cachedModels.length} models · {p.cachedModelsAt ? new Date(p.cachedModelsAt).toLocaleString() : ''}</span>
              : <span className="text-slate-400">(not fetched)</span>}
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-1 items-end">
        <button
          onClick={onFetchModels}
          disabled={fetching}
          className="text-xs px-2 py-1 rounded border border-cyan-300 text-cyan-700 hover:bg-cyan-50 disabled:opacity-50"
        >{fetching ? 'fetching…' : '↻ Fetch Models'}</button>
        <button onClick={onDelete} className="text-xs text-red-500 hover:text-red-700">delete</button>
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

// ─────────────────── MCP servers ───────────────────

function MCPTab({ onError }: { onError: (s: string) => void }) {
  const [items,    setItems]    = useState<api.MCPServer[]>([]);
  const [creating, setCreating] = useState(false);
  const [editing,  setEditing]  = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try { setItems(await api.listMCPServers()); }
    catch (e: any) { onError(e.message); }
  }, [onError]);
  useEffect(() => { refresh(); }, [refresh]);

  const onDelete = async (id: string) => {
    if (!confirm('delete this MCP server?')) return;
    try { await api.deleteMCPServer(id); refresh(); }
    catch (e: any) { onError(e.message); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">MCP Servers</h2>
        <button onClick={() => setCreating(true)} className="px-3 py-1 text-sm bg-cyan-600 hover:bg-cyan-700 text-white rounded">+ Add</button>
      </div>
      <p className="text-xs text-slate-500">
        Each server is a child process spawned via <code>command</code> + <code>args</code> + <code>env</code>.
        Reference one in a pet's <code>mcpServerName</code> to make its tools available to the agent.
        (Lifecycle / spawning will be wired in Phase 5; this tab manages config only.)
      </p>

      {creating && (
        <MCPServerForm
          onSave={async (input) => {
            try { await api.createMCPServer(input); setCreating(false); refresh(); }
            catch (e: any) { onError(e.message); }
          }}
          onCancel={() => setCreating(false)}
        />
      )}

      {items.length === 0 && !creating && (
        <div className="text-sm text-slate-400 italic">No MCP servers yet. Click + Add.</div>
      )}

      <div className="space-y-2">
        {items.map(s => editing === s.id ? (
          <MCPServerForm
            key={s.id}
            initial={s}
            onSave={async (input) => {
              try { await api.updateMCPServer(s.id, input); setEditing(null); refresh(); }
              catch (e: any) { onError(e.message); }
            }}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <div key={s.id} className="bg-white border border-slate-200 rounded p-4 flex items-start gap-4">
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <span className="font-mono font-medium">{s.name}</span>
                {!s.enabled && <span className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-700">disabled</span>}
                <span className="ml-auto text-[10px] text-slate-400 font-mono">{s.id.slice(0, 8)}…</span>
              </div>
              <div className="text-xs text-slate-600 font-mono mt-1 whitespace-pre-wrap">
                {[s.command, ...s.args].join(' ')}
              </div>
              {Object.keys(s.env).length > 0 && (
                <div className="text-xs text-slate-500 font-mono mt-1">
                  env: {Object.keys(s.env).join(', ')} <span className="text-slate-400">({Object.keys(s.env).length})</span>
                </div>
              )}
            </div>
            <div className="flex gap-2">
              <button onClick={() => setEditing(s.id)} className="text-sm text-cyan-600 hover:text-cyan-800">edit</button>
              <button onClick={() => onDelete(s.id)} className="text-sm text-red-500 hover:text-red-700">delete</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function MCPServerForm({ initial, onSave, onCancel }: {
  initial?: api.MCPServer;
  onSave: (input: { name: string; command: string; args: string[]; env: Record<string, string>; enabled: boolean }) => Promise<void>;
  onCancel: () => void;
}) {
  const [name,    setName]    = useState(initial?.name ?? '');
  const [command, setCommand] = useState(initial?.command ?? 'npx');
  const [argsText, setArgsText] = useState(initial?.args.join('\n') ?? '');
  const [envText,  setEnvText]  = useState(
    initial ? Object.entries(initial.env).map(([k, v]) => `${k}=${v}`).join('\n') : ''
  );
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [pending, setPending] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !command.trim()) return;
    const args = argsText.split('\n').map(s => s.trim()).filter(Boolean);
    const env: Record<string, string> = {};
    for (const line of envText.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const k = trimmed.slice(0, eq).trim();
      const v = trimmed.slice(eq + 1);
      if (k) env[k] = v;
    }
    setPending(true);
    try { await onSave({ name: name.trim(), command: command.trim(), args, env, enabled }); }
    finally { setPending(false); }
  };

  return (
    <form onSubmit={submit} className="bg-white border border-cyan-200 rounded p-4 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="name (referenced by social-config.mcpServerName)">
          <input value={name} onChange={e => setName(e.target.value)} required
            placeholder="qq-mcp"
            className="w-full px-2 py-1 border border-slate-300 rounded font-mono" />
        </Field>
        <Field label="command (executable)">
          <input value={command} onChange={e => setCommand(e.target.value)} required
            placeholder="npx / uvx / bun / python"
            className="w-full px-2 py-1 border border-slate-300 rounded font-mono" />
        </Field>
      </div>
      <Field label="args (one per line)">
        <textarea value={argsText} onChange={e => setArgsText(e.target.value)} rows={4}
          placeholder={'-y\n@modelcontextprotocol/qq'}
          className="w-full px-2 py-1 border border-slate-300 rounded font-mono text-sm" />
      </Field>
      <Field label="env (KEY=VALUE per line)">
        <textarea value={envText} onChange={e => setEnvText(e.target.value)} rows={4}
          placeholder="QQ_BOT_TOKEN=...\nDEBUG=1"
          className="w-full px-2 py-1 border border-slate-300 rounded font-mono text-sm" />
      </Field>
      <label className="flex items-center gap-2 text-sm cursor-pointer">
        <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
        <span>enabled</span>
      </label>
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
