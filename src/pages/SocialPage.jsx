import React, { useState, useEffect, useCallback, useMemo } from "react";
import { FaCheck, FaSpinner } from "react-icons/fa6";
import { MdCancel } from "react-icons/md";
import TitleBar from "../components/UI/TitleBar";
import { Card, FormGroup, Input, Select, Textarea, Button } from "../components/UI/ui";
import * as tauri from "../utils/tauri";
import { loadSocialConfig, saveSocialConfig } from "../utils/socialAgent";
import { DEFAULT_REPLY_STRATEGY } from "../utils/socialPromptBuilder";
import { listen, emit } from "@tauri-apps/api/event";

// ==================== SocialPage ====================
// Independent window — superset of ManagementPage's SocialPanel.
// Extra capabilities: per-target log filtering, always-visible large log area.

export default function SocialPage() {
  // ── Data ──
  const [assistants, setAssistants] = useState([]);
  const [apiProviders, setApiProviders] = useState([]);
  const [selectedPetId, setSelectedPetId] = useState('');
  const [config, setConfig] = useState({
    petId: '',
    mcpServerName: '',
    apiProviderId: '',
    modelName: '',
    replyInterval: 0,
    observerInterval: 180,
    watchedGroups: [],
    watchedFriends: [],
    socialPersonaPrompt: '',
    replyStrategyPrompt: '',
    agentCanEditStrategy: false,
    atMustReply: true,
    botQQ: '',
    intentModelName: '',
  });
  const [mcpServers, setMcpServers] = useState([]);
  const [saving, setSaving] = useState(false);
  const [socialActive, setSocialActive] = useState(false);
  const [logs, setLogs] = useState([]);
  const [groupsText, setGroupsText] = useState('');
  const [friendsText, setFriendsText] = useState('');

  // ── Log filtering (superset feature) ──
  const [logFilter, setLogFilter] = useState('all'); // 'all' | 'system' | target string
  const [showConfig, setShowConfig] = useState(false);
  const [lurkModes, setLurkModes] = useState({}); // { [target]: 'normal'|'semi-lurk'|'full-lurk' }
  const [targetNames, setTargetNames] = useState({}); // { [targetId]: displayName }
  const [pausedTargets, setPausedTargets] = useState({}); // { [target]: true }

  // ── Poll content visibility toggles ──
  const [showChat, setShowChat] = useState(true);
  const [showLlm, setShowLlm] = useState(false);
  const [showTools, setShowTools] = useState(true);
  const [showSystem, setShowSystem] = useState(true);
  const [showIntent, setShowIntent] = useState(true);

  // ── Load assistants + providers ──
  useEffect(() => {
    const fetchData = async () => {
      try {
        const [assistantData, providerData] = await Promise.all([
          tauri.getAssistants(),
          tauri.getApiProviders()
        ]);
        if (Array.isArray(assistantData)) setAssistants(assistantData);
        if (Array.isArray(providerData)) {
          const normalized = providerData.map(p => ({
            ...p,
            cachedModels: typeof p.cachedModels === 'string'
              ? JSON.parse(p.cachedModels) : (p.cachedModels || []),
            hiddenModels: typeof p.hiddenModels === 'string'
              ? JSON.parse(p.hiddenModels) : (p.hiddenModels || [])
          }));
          setApiProviders(normalized);
        }
      } catch (e) {
        console.error("SocialPage: Failed to load data:", e);
      }
    };
    fetchData();
  }, []);

  // ── Load MCP servers ──
  useEffect(() => {
    const load = async () => {
      try {
        const list = await tauri.mcp.getServers();
        setMcpServers(list || []);
      } catch (e) {
        console.error('Failed to load MCP servers:', e);
      }
    };
    load();
  }, []);

  // ── Listen for social status changes ──
  useEffect(() => {
    let unlisten;
    const setup = async () => {
      unlisten = await listen('social-status-changed', (event) => {
        const { active, petId, lurkModes: lm, pausedTargets: pt } = event.payload;
        if (petId === selectedPetId || !selectedPetId) {
          setSocialActive(active);
          if (lm) setLurkModes(lm);
          if (pt) setPausedTargets(pt);
        }
      });
      emit('social-query-status');
    };
    setup();
    return () => { unlisten?.(); };
  }, [selectedPetId]);

  // ── Listen for lurk mode changes ──
  useEffect(() => {
    let unlisten;
    const setup = async () => {
      unlisten = await listen('social-lurk-mode-changed', (event) => {
        const { lurkModes: lm } = event.payload || {};
        if (lm) setLurkModes(lm);
      });
    };
    setup();
    return () => { unlisten?.(); };
  }, []);

  // ── Listen for target paused changes ──
  useEffect(() => {
    let unlisten;
    const setup = async () => {
      unlisten = await listen('social-target-paused-changed', (event) => {
        const { pausedTargets: pt } = event.payload || {};
        if (pt) setPausedTargets(pt);
      });
    };
    setup();
    return () => { unlisten?.(); };
  }, []);

  // ── Listen for full log responses (initial load / clear) ──
  // ── Dedup set for incremental log entries ──
  const seenLogIdsRef = React.useRef(new Set());

  // ── Listen for full log responses (initial load / clear) ──
  useEffect(() => {
    let unlisten;
    const setup = async () => {
      unlisten = await listen('social-logs-response', (event) => {
        const payload = event.payload || [];
        // Rebuild dedup set from full load
        const ids = seenLogIdsRef.current;
        ids.clear();
        for (const log of payload) {
          if (log.id != null) ids.add(log.id);
        }
        setLogs(payload);
      });
    };
    setup();
    return () => { unlisten?.(); };
  }, []);

  // ── Listen for incremental log entries (real-time push) ──
  useEffect(() => {
    let unlisten;
    const UI_MAX_LOGS = 2000;
    const setup = async () => {
      unlisten = await listen('social-log-entry', (event) => {
        const entry = event.payload;
        if (!entry) return;
        // O(1) dedup via Set
        const ids = seenLogIdsRef.current;
        if (entry.id != null && ids.has(entry.id)) return; // already seen
        if (entry.id != null) ids.add(entry.id);
        setLogs(prev => {
          const next = [...prev, entry];
          if (next.length > UI_MAX_LOGS) {
            // Trim oldest entries and remove their ids from dedup set
            const trimmed = next.slice(next.length - UI_MAX_LOGS);
            const trimmedIds = next.slice(0, next.length - UI_MAX_LOGS);
            for (const t of trimmedIds) {
              if (t.id != null) ids.delete(t.id);
            }
            return trimmed;
          }
          return next;
        });
      });
    };
    setup();
    return () => { unlisten?.(); };
  }, []);

  // ── Listen for target names ──
  useEffect(() => {
    let unlisten;
    const setup = async () => {
      unlisten = await listen('social-target-names-response', (event) => {
        const names = event.payload;
        if (names && typeof names === 'object') {
          setTargetNames(prev => ({ ...prev, ...names }));
        }
      });
    };
    setup();
    return () => { unlisten?.(); };
  }, []);

  // ── Initial full log load + periodic target names refresh ──
  useEffect(() => {
    emit('social-query-logs'); // one-time full load on mount
    emit('social-query-target-names');
    const interval = setInterval(() => {
      emit('social-query-target-names'); // only names, logs are pushed incrementally
    }, 10000);
    return () => clearInterval(interval);
  }, []);

  // ── Load config when pet changes ──
  useEffect(() => {
    if (!selectedPetId) return;
    const load = async () => {
      const saved = await loadSocialConfig(selectedPetId);
      if (saved) {
        setConfig({ ...saved, petId: selectedPetId });
        setGroupsText((saved.watchedGroups || []).join(', '));
        setFriendsText((saved.watchedFriends || []).join(', '));
      } else {
        setConfig(prev => ({
          ...prev,
          petId: selectedPetId,
          mcpServerName: '',
          apiProviderId: '',
          modelName: '',
          replyInterval: 0,
          observerInterval: 180,
          watchedGroups: [],
          watchedFriends: [],
          socialPersonaPrompt: '',
          atMustReply: true,
          botQQ: '',
          ownerQQ: '',
          ownerName: '',
          enabledMcpServers: [],
        }));
        setGroupsText('');
        setFriendsText('');
      }
      emit('social-query-status');
    };
    load();
  }, [selectedPetId]);

  // ── Auto-select first assistant ──
  useEffect(() => {
    if (assistants.length > 0 && !selectedPetId) {
      setSelectedPetId(assistants[0]._id);
    }
  }, [assistants, selectedPetId]);

  // ── Handlers ──
  const handleConfigChange = (field, value) => {
    setConfig(prev => ({ ...prev, [field]: value }));
  };

  const buildConfigToSave = useCallback(() => ({
    ...config,
    petId: selectedPetId,
    watchedGroups: groupsText.split(',').map(s => s.trim()).filter(Boolean),
    watchedFriends: friendsText.split(',').map(s => s.trim()).filter(Boolean),
  }), [config, selectedPetId, groupsText, friendsText]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const configToSave = buildConfigToSave();
      await saveSocialConfig(selectedPetId, configToSave);
      setConfig(configToSave);
      if (socialActive) {
        emit('social-config-updated', configToSave);
      }
    } catch (e) {
      console.error('Failed to save social config:', e);
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async () => {
    if (socialActive) {
      emit('social-stop');
    } else {
      const configToStart = buildConfigToSave();
      await saveSocialConfig(selectedPetId, configToStart);
      setConfig(configToStart);
      emit('social-start', configToStart);
    }
  };

  // ── Derived state ──
  const selectedProvider = apiProviders.find(p => (p._id || p.id) === config.apiProviderId);
  const providerModels = selectedProvider?.cachedModels || [];

  // Build log filter tabs from config
  const watchedTargets = [
    ...(config.watchedGroups || []).map(g => {
      const name = targetNames[g];
      return { id: g, label: name ? `${name} (${g})` : `Group:${g}` };
    }),
    ...(config.watchedFriends || []).map(f => {
      const name = targetNames[f];
      return { id: f, label: name ? `${name} (${f})` : `Friend:${f}` };
    }),
  ];

  // Unified sorted logs — single sort, all downstream consumers benefit
  const sortedLogs = useMemo(() =>
    [...logs].sort((a, b) => (a.id ?? 0) - (b.id ?? 0)),
    [logs]
  );

  // Precompute log counts by target (O(N) once instead of O(N×M) per render)
  const logCountByTarget = useMemo(() => {
    const counts = {};
    for (const log of sortedLogs) {
      if (log.target) counts[log.target] = (counts[log.target] || 0) + 1;
    }
    return counts;
  }, [sortedLogs]);

  // Memoized filtered logs (based on sorted data)
  const filteredLogs = useMemo(() => sortedLogs.filter(log => {
    // Intent logs have target — apply target filter normally
    if (log.level === 'intent') return showIntent && (logFilter === 'all' || logFilter === 'system' || log.target === logFilter);
    if (logFilter === 'system' && log.target) return false;
    if (logFilter !== 'all' && logFilter !== 'system' && log.target !== logFilter) return false;
    if (log.level === 'poll') return true;
    if (!showSystem) return false;
    return true;
  }), [sortedLogs, logFilter, showSystem, showIntent]);

  // Newest first — just reverse the already-sorted filtered logs (O(N))
  const reversedFilteredLogs = useMemo(() => [...filteredLogs].reverse(), [filteredLogs]);

  // ── Close handler ──
  const handleClose = () => {
    tauri.hideSocialWindow();
  };

  // ── Per-target lurk mode ──
  const LURK_OPTIONS = [
    { mode: 'normal',    icon: '💬', label: 'Normal',    cls: 'bg-cyan-50 text-cyan-700 border-cyan-300',    activeCls: 'bg-cyan-500 text-white border-cyan-500' },
    { mode: 'semi-lurk', icon: '👀', label: 'Semi-Lurk', cls: 'bg-amber-50 text-amber-700 border-amber-300',  activeCls: 'bg-amber-500 text-white border-amber-500' },
    { mode: 'full-lurk', icon: '🫥', label: 'Full-Lurk', cls: 'bg-slate-50 text-slate-600 border-slate-300',  activeCls: 'bg-slate-500 text-white border-slate-500' },
  ];
  const setTargetLurkMode = (target, mode) => {
    emit('social-set-lurk-mode', { target, mode });
  };
  const toggleTargetPaused = (target) => {
    const isPaused = pausedTargets[target] || false;
    emit('social-set-target-paused', { target, paused: !isPaused });
  };
  // Which target is selected in the log filter (not 'all'/'system')
  const selectedTarget = logFilter !== 'all' && logFilter !== 'system' ? logFilter : null;

  return (
    <div className="h-screen flex flex-col bg-white/95 backdrop-blur-xl rounded-2xl overflow-hidden border border-slate-200/80 shadow-xl">
      {/* Title Bar */}
      <TitleBar
        title="Social Agent"
        left={
          <button
            type="button"
            className="no-drag inline-flex items-center justify-center rounded-xl p-2 text-slate-500 hover:text-slate-900 hover:bg-slate-100"
            onClick={handleClose}
            title="Close"
          >
            <MdCancel size={18} />
          </button>
        }
        right={
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowConfig(!showConfig)}
              className="no-drag px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50"
            >
              {showConfig ? 'Hide Config' : 'Show Config'}
            </button>
            <button
              onClick={handleToggle}
              disabled={!selectedPetId}
              className={`no-drag px-3 py-1.5 text-xs font-medium rounded-lg ${
                socialActive
                  ? 'bg-red-500 text-white hover:bg-red-600'
                  : 'bg-cyan-500 text-white hover:bg-cyan-600'
              } disabled:opacity-50`}
            >
              {socialActive ? 'Stop' : 'Start'}
            </button>
          </div>
        }
      />

      {/* Main Content */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {/* Config Section (collapsible) */}
        {showConfig && (
          <div className="border-b border-slate-100 max-h-[50%] overflow-y-auto px-4 py-3">
            <div className="space-y-4">
              {/* Assistant Selector */}
              <Card title="Assistant" description="Select which assistant powers the social agent">
                <FormGroup label="Assistant">
                  <Select
                    value={selectedPetId}
                    onChange={(e) => setSelectedPetId(e.target.value)}
                  >
                    <option value="">Select an assistant...</option>
                    {assistants.map(a => (
                      <option key={a._id} value={a._id}>{a.name}</option>
                    ))}
                  </Select>
                </FormGroup>
              </Card>

              {/* LLM Configuration */}
              <Card title="LLM" description="API provider and model for social decisions">
                <div className="space-y-3">
                  <FormGroup label="API Provider">
                    <Select
                      value={config.apiProviderId}
                      onChange={(e) => {
                        handleConfigChange('apiProviderId', e.target.value);
                        handleConfigChange('modelName', '');
                      }}
                    >
                      <option value="">Select provider...</option>
                      {apiProviders.map(p => (
                        <option key={p._id || p.id} value={p._id || p.id}>{p.name}</option>
                      ))}
                    </Select>
                  </FormGroup>
                  <FormGroup label="Model">
                    {providerModels.length > 0 ? (
                      <Select
                        value={config.modelName}
                        onChange={(e) => handleConfigChange('modelName', e.target.value)}
                      >
                        <option value="">Select model...</option>
                        {providerModels.map(m => {
                          const modelId = typeof m === 'string' ? m : m.id;
                          return <option key={modelId} value={modelId}>{modelId}</option>;
                        })}
                      </Select>
                    ) : (
                      <Input
                        value={config.modelName}
                        onChange={(e) => handleConfigChange('modelName', e.target.value)}
                        placeholder="e.g. gpt-4o-mini"
                      />
                    )}
                  </FormGroup>
                </div>
              </Card>

              {/* Intent Model */}
              <Card title="Intent Model" description="Separate model for intent analysis (optional, defaults to main model)">
                <FormGroup label="Model">
                  {providerModels.length > 0 ? (
                    <Select
                      value={config.intentModelName}
                      onChange={(e) => handleConfigChange('intentModelName', e.target.value)}
                    >
                      <option value="">Same as main model</option>
                      {providerModels.map(m => {
                        const modelId = typeof m === 'string' ? m : m.id;
                        return <option key={modelId} value={modelId}>{modelId}</option>;
                      })}
                    </Select>
                  ) : (
                    <Input
                      value={config.intentModelName}
                      onChange={(e) => handleConfigChange('intentModelName', e.target.value)}
                      placeholder="Leave empty to use main model"
                    />
                  )}
                </FormGroup>
              </Card>

              {/* MCP Server */}
              <Card title="MCP Server" description="The QQ MCP server to use for messaging">
                <FormGroup label="Server">
                  <Select
                    value={config.mcpServerName}
                    onChange={(e) => handleConfigChange('mcpServerName', e.target.value)}
                  >
                    <option value="">Select server...</option>
                    {mcpServers.map(s => (
                      <option key={s._id} value={s.name}>{s.name}</option>
                    ))}
                  </Select>
                </FormGroup>
                <FormGroup label="Bot QQ Number" hint="Your bot's QQ number, used to detect @mentions">
                  <Input
                    value={config.botQQ}
                    onChange={(e) => handleConfigChange('botQQ', e.target.value)}
                    placeholder="e.g. 3825478002"
                  />
                </FormGroup>
                <FormGroup label="Owner QQ Number" hint="Your personal QQ number, so the bot can recognize you in group chat">
                  <Input
                    value={config.ownerQQ}
                    onChange={(e) => handleConfigChange('ownerQQ', e.target.value)}
                    placeholder="e.g. 123456789"
                  />
                </FormGroup>
                <FormGroup label="Owner Name" hint="Your QQ display name or nickname">
                  <Input
                    value={config.ownerName}
                    onChange={(e) => handleConfigChange('ownerName', e.target.value)}
                    placeholder="e.g. Jules"
                  />
                </FormGroup>
              </Card>

              {/* Additional MCP Servers */}
              {mcpServers.filter(s => s.name !== config.mcpServerName).length > 0 && (
                <Card title="Additional MCP Tools" description="Enable extra MCP servers whose tools the agent can use">
                  <div className="space-y-2">
                    {mcpServers.filter(s => s.name !== config.mcpServerName).map(s => (
                      <div key={s._id} className="flex items-center justify-between">
                        <div className="text-sm text-slate-700">{s.name}</div>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={(config.enabledMcpServers || []).includes(s.name)}
                            onChange={(e) => {
                              const prev = config.enabledMcpServers || [];
                              if (e.target.checked) {
                                handleConfigChange('enabledMcpServers', [...prev, s.name]);
                              } else {
                                handleConfigChange('enabledMcpServers', prev.filter(n => n !== s.name));
                              }
                            }}
                            className="sr-only peer"
                          />
                          <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-500"></div>
                        </label>
                      </div>
                    ))}
                  </div>
                </Card>
              )}

              {/* Targets */}
              <Card title="Watch Targets" description="QQ groups and friends to monitor">
                <div className="space-y-3">
                  <FormGroup label="Groups" hint="Comma-separated group numbers">
                    <Input
                      value={groupsText}
                      onChange={(e) => setGroupsText(e.target.value)}
                      placeholder="e.g. 1059558644, 123456789"
                    />
                  </FormGroup>
                  <FormGroup label="Friends" hint="Comma-separated QQ numbers">
                    <Input
                      value={friendsText}
                      onChange={(e) => setFriendsText(e.target.value)}
                      placeholder="e.g. 100001, 100002"
                    />
                  </FormGroup>
                </div>
              </Card>

              {/* Processing Intervals */}
              <Card title="Processing Intervals" description="How often each processor calls LLM per group">
                <div className="space-y-3">
                  <FormGroup label="Reply Interval (seconds)" hint="Min time between Reply LLM calls per group (0 = instant)">
                    <Input
                      type="number"
                      min={0}
                      max={600}
                      value={config.replyInterval ?? 0}
                      onChange={(e) => handleConfigChange('replyInterval', parseInt(e.target.value) || 0)}
                    />
                  </FormGroup>
                  <FormGroup label="Observer Interval (seconds)" hint="Min time between Observer LLM calls per group">
                    <Input
                      type="number"
                      min={10}
                      max={3600}
                      value={config.observerInterval ?? 180}
                      onChange={(e) => handleConfigChange('observerInterval', parseInt(e.target.value) || 180)}
                    />
                  </FormGroup>
                </div>
              </Card>

              {/* Prompt Configuration */}
              <Card title="Prompts" description="Customize social behavior and reply strategy">
                <div className="space-y-3">
                  <FormGroup label="Social Persona" hint="Additional persona instructions for social context">
                    <Textarea
                      rows={3}
                      value={config.socialPersonaPrompt}
                      onChange={(e) => handleConfigChange('socialPersonaPrompt', e.target.value)}
                      placeholder="e.g. 你是群里的活跃成员，喜欢用emoji..."
                    />
                  </FormGroup>
                  <FormGroup label="Reply Strategy" hint="Rules for when to reply vs stay silent (stored in social/REPLY_STRATEGY.md)">
                    <div className="flex gap-2">
                      <Button
                        variant="secondary"
                        className="flex-1"
                        onClick={async () => {
                          if (!selectedPetId) return;
                          try {
                            await tauri.workspaceOpenFile(selectedPetId, 'social/REPLY_STRATEGY.md', DEFAULT_REPLY_STRATEGY);
                          } catch (e) {
                            console.error('Failed to open reply strategy file:', e);
                          }
                        }}
                      >
                        Edit Reply Strategy
                      </Button>
                    </div>
                  </FormGroup>
                  <ToggleRow
                    label="Agent Can Edit Strategy"
                    hint="Allow the AI to adjust its own reply rules based on experience"
                    checked={config.agentCanEditStrategy === true}
                    onChange={(v) => handleConfigChange('agentCanEditStrategy', v)}
                  />
                  <ToggleRow
                    label="@Mention Must Reply"
                    hint="Always reply when someone @mentions the bot"
                    checked={config.atMustReply !== false}
                    onChange={(v) => handleConfigChange('atMustReply', v)}
                  />
                </div>
              </Card>

              {/* Save Button */}
              <div className="flex justify-end pb-2">
                <Button
                  variant="primary"
                  onClick={handleSave}
                  disabled={saving || !selectedPetId}
                >
                  {saving ? <FaSpinner className="animate-spin w-4 h-4 mr-1" /> : <FaCheck className="w-4 h-4 mr-1" />}
                  Save Configuration
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* ========== Log Section (always visible, superset feature) ========== */}
        <div className="flex-1 min-h-0 flex flex-row">
          {/* ── Left Sidebar: target list ── */}
          <div className="w-40 shrink-0 border-r border-slate-200/60 flex flex-col overflow-hidden bg-slate-50/30">
            {/* Fixed: All + System */}
            <SidebarItem
              active={logFilter === 'all'}
              onClick={() => setLogFilter('all')}
              label="All"
              count={logs.length}
            />
            <SidebarItem
              active={logFilter === 'system'}
              onClick={() => setLogFilter('system')}
              label="System"
              count={logs.filter(l => !l.target).length}
            />

            {/* Separator */}
            {watchedTargets.length > 0 && <div className="border-t border-slate-200/60 mx-2 my-1" />}

            {/* Scrollable target list */}
            <div className="flex-1 overflow-y-auto">
              {watchedTargets.map(t => {
                const mode = lurkModes[t.id] || 'normal';
                const lurkIcon = mode === 'semi-lurk' ? '👀' : mode === 'full-lurk' ? '🫥' : '💬';
                const displayName = targetNames[t.id] || t.id;
                const isPaused = pausedTargets[t.id] || false;
                return (
                  <SidebarItem
                    key={t.id}
                    active={logFilter === t.id}
                    onClick={() => setLogFilter(t.id)}
                    label={displayName}
                    count={logCountByTarget[t.id] || 0}
                    lurkIcon={socialActive ? lurkIcon : null}
                    onLurkClick={socialActive ? () => {
                      const next = mode === 'normal' ? 'semi-lurk' : mode === 'semi-lurk' ? 'full-lurk' : 'normal';
                      setTargetLurkMode(t.id, next);
                    } : null}
                    paused={socialActive ? isPaused : false}
                    onPauseClick={socialActive ? () => toggleTargetPaused(t.id) : null}
                  />
                );
              })}
            </div>

            {/* Clear logs */}
            <div className="border-t border-slate-200/60 p-1.5">
              <button
                onClick={() => { emit('social-clear-logs'); setLogs([]); }}
                className="w-full text-[10px] text-slate-400 hover:text-red-500 py-1 rounded hover:bg-red-50 transition-colors"
              >
                Clear Logs
              </button>
            </div>
          </div>

          {/* ── Right: toolbar + log content ── */}
          <div className="flex-1 min-w-0 flex flex-col">
            {/* Content Toggle Bar + Lurk indicator */}
            <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-slate-100 bg-white/60 shrink-0">
              <span className="text-xs text-slate-400 mr-0.5 shrink-0">Show:</span>
              <ToggleBtn active={showChat} onClick={() => setShowChat(!showChat)} icon="💬" label="Chat" />
              <ToggleBtn active={showLlm} onClick={() => setShowLlm(!showLlm)} icon="🧠" label="LLM" />
              <ToggleBtn active={showTools} onClick={() => setShowTools(!showTools)} icon="🔧" label="Tools" />
              <ToggleBtn active={showSystem} onClick={() => setShowSystem(!showSystem)} icon="📋" label="System" />
              <ToggleBtn active={showIntent} onClick={() => setShowIntent(!showIntent)} icon="🧠" label="Intent" />
              {/* Lurk mode buttons for selected target */}
              {socialActive && selectedTarget && (() => {
                const currentMode = lurkModes[selectedTarget] || 'normal';
                const isPaused = pausedTargets[selectedTarget] || false;
                return (
                  <div className="ml-auto flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => toggleTargetPaused(selectedTarget)}
                      className={`px-2 py-0.5 text-[10px] font-medium rounded border transition-colors ${
                        isPaused
                          ? 'bg-red-500 text-white border-red-500'
                          : 'bg-emerald-50 text-emerald-700 border-emerald-300 hover:opacity-80'
                      }`}
                      title={isPaused ? 'Resume processing' : 'Pause processing'}
                    >
                      {isPaused ? '⏸️ Paused' : '▶️ Running'}
                    </button>
                    <div className="w-px h-4 bg-slate-200 mx-0.5" />
                    {LURK_OPTIONS.map(opt => {
                      const isActive = currentMode === opt.mode;
                      return (
                        <button
                          key={opt.mode}
                          onClick={() => setTargetLurkMode(selectedTarget, opt.mode)}
                          className={`px-2 py-0.5 text-[10px] font-medium rounded border transition-colors ${
                            isActive ? opt.activeCls : `${opt.cls} hover:opacity-80`
                          }`}
                          title={opt.label}
                        >
                          {opt.icon}
                        </button>
                      );
                    })}
                  </div>
                );
              })()}
            </div>

            {/* Log Content */}
            <div className="flex-1 min-h-0 overflow-y-auto px-4 py-2 text-xs font-mono space-y-0.5">
              {reversedFilteredLogs.length === 0 ? (
                <div className="text-slate-400 text-center py-8">No logs yet</div>
              ) : (
                reversedFilteredLogs.map((log) => (
                  log.level === 'poll' ? (
                    <PollEntry key={log.id ?? log.timestamp} log={log} showChat={showChat} showLlm={showLlm} showTools={showTools} logFilter={logFilter} />
                  ) : log.level === 'intent' ? (
                    <IntentLogEntry key={log.id ?? log.timestamp} log={log} logFilter={logFilter} />
                  ) : (
                    <div key={log.id ?? log.timestamp} className={`py-0.5 ${
                      log.level === 'error' ? 'text-red-600' :
                      log.level === 'warn' ? 'text-amber-600' :
                      log.level === 'memory' ? 'text-purple-600' :
                      log.level === 'intent' ? 'text-purple-500' :
                      'text-slate-600'
                    }`}>
                      <span className="text-slate-400">{new Date(log.timestamp).toLocaleTimeString()}</span>
                      {' '}
                      <span className="font-semibold">[{log.level}]</span>
                      {log.target && logFilter === 'all' && (
                        <span className="text-cyan-500 ml-1">[{log.target}]</span>
                      )}
                      {' '}
                      {log.message}
                      {log.details && <span className="text-slate-400"> — {typeof log.details === 'string' ? log.details : JSON.stringify(log.details)}</span>}
                    </div>
                  )
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ==================== Helper Components ====================

function IntentLogEntry({ log, logFilter }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetails = !!log.details;
  return (
    <div className="py-0.5 text-purple-500">
      <span className="text-slate-400">{new Date(log.timestamp).toLocaleTimeString()}</span>
      {' '}
      <span className="font-semibold">[{log.level}]</span>
      {log.target && logFilter === 'all' && (
        <span className="text-cyan-500 ml-1">[{log.target}]</span>
      )}
      {' '}
      {log.message}
      {hasDetails && (
        <button
          onClick={() => setExpanded(v => !v)}
          className="ml-1.5 text-purple-400 hover:text-purple-300 transition-colors"
        >
          {expanded ? '▾' : '▸'}
        </button>
      )}
      {hasDetails && expanded && (
        <div className="mt-0.5 ml-4 pl-2 border-l-2 border-purple-300/40 text-purple-400 whitespace-pre-wrap break-words">
          {typeof log.details === 'string' ? log.details : JSON.stringify(log.details, null, 2)}
        </div>
      )}
    </div>
  );
}

function ToggleRow({ label, hint, checked, onChange }) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex-1">
        <div className="text-sm font-medium text-slate-700">{label}</div>
        {hint && <div className="text-xs text-slate-500 mt-0.5">{hint}</div>}
      </div>
      <label className="relative inline-flex items-center cursor-pointer">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="sr-only peer"
        />
        <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-500"></div>
      </label>
    </div>
  );
}

function SidebarItem({ active, onClick, label, count, lurkIcon, onLurkClick, paused, onPauseClick }) {
  return (
    <div
      onClick={onClick}
      className={`flex items-center gap-1.5 px-2.5 py-1.5 cursor-pointer text-xs transition-colors ${
        active
          ? 'bg-cyan-50 text-cyan-700 border-r-2 border-cyan-400'
          : 'text-slate-600 hover:bg-slate-100/80'
      }${paused ? ' opacity-50' : ''}`}
      title={label}
    >
      {onPauseClick && (
        <button
          onClick={(e) => { e.stopPropagation(); onPauseClick(); }}
          className="shrink-0 hover:scale-125 transition-transform text-sm leading-none"
          title={paused ? 'Resume' : 'Pause'}
        >
          {paused ? '⏸' : '▶'}
        </button>
      )}
      {lurkIcon && (
        <button
          onClick={(e) => { e.stopPropagation(); onLurkClick?.(); }}
          className="shrink-0 hover:scale-125 transition-transform text-sm leading-none"
          title="Click to cycle lurk mode"
        >
          {lurkIcon}
        </button>
      )}
      <span className="truncate flex-1 font-medium">{label}</span>
      {count > 0 && (
        <span className={`shrink-0 tabular-nums text-[10px] ${active ? 'text-cyan-500' : 'text-slate-400'}`}>
          {count}
        </span>
      )}
    </div>
  );
}

function ToggleBtn({ active, onClick, icon, label }) {
  return (
    <button
      onClick={onClick}
      className={`px-2 py-0.5 text-xs font-medium rounded-md border transition-colors ${
        active
          ? 'bg-indigo-50 text-indigo-700 border-indigo-200'
          : 'bg-slate-50 text-slate-400 border-slate-200 opacity-60 hover:opacity-80'
      }`}
    >
      {icon} {label}
    </button>
  );
}

function PollEntry({ log, showChat, showLlm, showTools, logFilter }) {
  const [llmExpanded, setLlmExpanded] = useState(false);
  const [promptExpanded, setPromptExpanded] = useState(false);
  const d = log.details || {};
  const actionColors = {
    replied: 'text-green-600',
    silent: 'text-slate-500',
    send_failed: 'text-amber-600',
    error: 'text-red-600',
  };
  const actionIcons = {
    replied: '✅',
    silent: '😶',
    send_failed: '⚠️',
    error: '❌',
  };
  return (
    <div className="py-1 border-l-2 border-indigo-200 pl-2 my-1">
      <div className="flex items-center gap-1">
        <span className="text-slate-400">{new Date(log.timestamp).toLocaleTimeString()}</span>
        <span className={`font-semibold ${actionColors[d.action] || 'text-slate-600'}`}>
          {actionIcons[d.action] || '📊'} {d.action || 'poll'}
        </span>
        {d.role && (
          <span className="text-indigo-400 text-[10px] uppercase">{d.role === 'observer' ? '👁 Observer' : '💬 Reply'}</span>
        )}
        {log.target && logFilter === 'all' && (
          <span className="text-cyan-500">[{log.target}]</span>
        )}
      </div>
      {showChat && d.chatMessages?.length > 0 && (
        <div className="ml-2 mt-0.5">
          <div className="text-slate-400 text-[10px] uppercase tracking-wider">💬 Chat ({d.chatMessages.length})</div>
          {d.chatMessages.slice(-8).map((m, i) => (
            <div key={i} className={`truncate ${m.isAtMe ? 'text-orange-600' : 'text-slate-500'}`}>
              <span className="font-medium">{m.sender}:</span> {m.content}
            </div>
          ))}
          {d.chatMessages.length > 8 && (
            <div className="text-slate-400">...{d.chatMessages.length - 8} more</div>
          )}
        </div>
      )}
      {showLlm && d.inputPrompt?.length > 0 && (() => {
        // Format prompt messages for display
        const promptLines = d.inputPrompt.map((m, i) => {
          const roleLabel = m.role === 'system' ? '🔧 system' : m.role === 'assistant' ? '🤖 assistant' : '👤 user';
          const content = typeof m.content === 'string'
            ? m.content
            : (m.content || []).map(p => p.type === 'text' ? p.text : `[image]`).join('\n');
          return `── ${roleLabel} ──\n${content}`;
        }).join('\n\n');
        return (
          <div className="ml-2 mt-0.5">
            <div className="flex items-center gap-2">
              <span className="text-slate-400 text-[10px] uppercase tracking-wider">📝 Input Prompt ({d.inputPrompt.length} turns)</span>
              <button
                onClick={() => setPromptExpanded(!promptExpanded)}
                className="text-[10px] text-indigo-500 hover:text-indigo-700 font-medium"
              >
                {promptExpanded ? 'Collapse' : 'Expand'}
              </button>
            </div>
            {promptExpanded && (
              <div className="text-slate-600 whitespace-pre-wrap break-words max-h-96 overflow-y-auto bg-slate-50/80 rounded p-1.5 mt-0.5 border border-slate-100 text-[11px] font-mono">
                {promptLines}
              </div>
            )}
          </div>
        );
      })()}
      {showLlm && (() => {
        const iters = d.llmIters || [];
        const sent = d.sentMessages || [];
        if (iters.length === 0 && sent.length === 0) return null;
        // Build display lines for each iteration
        const lines = iters.map((it) => {
          const parts = [];
          if (it.reasoning) parts.push(`[Reasoning] ${it.reasoning}`);
          if (it.content) parts.push(it.content);
          if (it.toolNames?.length > 0) {
            parts.push(`(→ ${it.toolNames.join(', ')})`);
          }
          return { iteration: it.iteration, text: parts.join('\n'), hasContent: parts.length > 0, toolNames: it.toolNames || [] };
        }).filter(l => l.hasContent);
        const totalIters = iters.length;
        const fullText = lines.map(l => {
          const header = totalIters > 1 ? `[Iter ${l.iteration}] ` : '';
          return header + l.text;
        }).join('\n---\n');
        const preview = fullText.length > 80 ? fullText.substring(0, 80) + '…' : fullText;
        return (
          <div className="ml-2 mt-0.5">
            {sent.length > 0 && (
              <div className="mt-0.5 mb-1">
                {sent.map((s, i) => (
                  <div key={i} className="text-green-600 font-medium">📤 Sent: {s}</div>
                ))}
              </div>
            )}
            {lines.length > 0 && (
              <>
                <div className="flex items-center gap-2">
                  <span className="text-slate-400 text-[10px] uppercase tracking-wider">🧠 LLM Output ({totalIters} iter{totalIters > 1 ? 's' : ''})</span>
                  <button
                    onClick={() => setLlmExpanded(!llmExpanded)}
                    className="text-[10px] text-indigo-500 hover:text-indigo-700 font-medium"
                  >
                    {llmExpanded ? 'Collapse' : 'Expand'}
                  </button>
                </div>
                {llmExpanded ? (
                  <div className="text-slate-600 whitespace-pre-wrap break-words max-h-60 overflow-y-auto bg-slate-50/80 rounded p-1.5 mt-0.5 border border-slate-100">
                    {fullText}
                  </div>
                ) : (
                  <div className="text-slate-500 truncate cursor-pointer" onClick={() => setLlmExpanded(true)}>
                    {preview}
                  </div>
                )}
              </>
            )}
          </div>
        );
      })()}
      {showTools && d.toolCalls?.length > 0 && (
        <div className="ml-2 mt-0.5">
          <div className="text-slate-400 text-[10px] uppercase tracking-wider">🔧 Tools ({d.toolCalls.length})</div>
          {d.toolCalls.map((tc, i) => (
            <div key={i} className={tc.isError ? 'text-red-500' : 'text-slate-500'}>
              <span className="font-medium">{tc.name}</span>
              {tc.result && <span className="text-slate-400"> → {tc.result}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
