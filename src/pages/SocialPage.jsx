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
    pollingInterval: 60,
    watchedGroups: [],
    watchedFriends: [],
    socialPersonaPrompt: '',
    replyStrategyPrompt: '',
    agentCanEditStrategy: false,
    atMustReply: true,
    botQQ: '',
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

  // ── Poll content visibility toggles ──
  const [showChat, setShowChat] = useState(true);
  const [showLlm, setShowLlm] = useState(false);
  const [showTools, setShowTools] = useState(true);
  const [showSystem, setShowSystem] = useState(true);

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
        const { active, petId, lurkModes: lm } = event.payload;
        if (petId === selectedPetId || !selectedPetId) {
          setSocialActive(active);
          if (lm) setLurkModes(lm);
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

  // ── Listen for log responses ──
  useEffect(() => {
    let unlisten;
    const setup = async () => {
      unlisten = await listen('social-logs-response', (event) => {
        setLogs(event.payload || []);
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

  // ── Refresh logs + target names periodically ──
  useEffect(() => {
    emit('social-query-logs');
    emit('social-query-target-names');
    const interval = setInterval(() => {
      emit('social-query-logs');
      emit('social-query-target-names');
    }, 3000);
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
          pollingInterval: 60,
          watchedGroups: [],
          watchedFriends: [],
          socialPersonaPrompt: '',
          atMustReply: true,
          injectBehaviorGuidelines: true,
          atInstantReply: true,
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

  // Filter logs
  const filteredLogs = logs.filter(log => {
    // Target filter
    if (logFilter === 'system' && log.target) return false;
    if (logFilter !== 'all' && logFilter !== 'system' && log.target !== logFilter) return false;
    // Poll entries always pass (content toggles handled in render)
    if (log.level === 'poll') return true;
    // System toggle controls non-poll entries
    if (!showSystem) return false;
    return true;
  });

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

              {/* Polling */}
              <Card title="Polling" description="How often to check for new messages">
                <div className="space-y-3">
                  <FormGroup label="Interval (seconds)">
                    <Input
                      type="number"
                      min={3}
                      max={600}
                      value={config.pollingInterval}
                      onChange={(e) => handleConfigChange('pollingInterval', parseInt(e.target.value) || 60)}
                    />
                  </FormGroup>
                  <div className="flex items-center justify-between">
                    <div className="flex-1">
                      <div className="text-sm font-medium text-slate-700">Instant @Reply</div>
                      <div className="text-xs text-slate-500 mt-0.5">
                        Check for @mentions every 3s and reply immediately
                      </div>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={config.atInstantReply !== false}
                        onChange={(e) => handleConfigChange('atInstantReply', e.target.checked)}
                        className="sr-only peer"
                      />
                      <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-500"></div>
                    </label>
                  </div>
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
                  <ToggleRow
                    label="Behavior Guidelines"
                    hint="Inject built-in social behavior rules (be genuine, quality over quantity, etc.)"
                    checked={config.injectBehaviorGuidelines !== false}
                    onChange={(v) => handleConfigChange('injectBehaviorGuidelines', v)}
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
        <div className="flex-1 min-h-0 flex flex-col">
          {/* Log Tab Bar */}
          <div className="flex items-center gap-1 px-4 py-2 border-b border-slate-100 overflow-x-auto shrink-0">
            <LogTab
              active={logFilter === 'all'}
              onClick={() => setLogFilter('all')}
              label="All"
              count={logs.length}
            />
            <LogTab
              active={logFilter === 'system'}
              onClick={() => setLogFilter('system')}
              label="System"
              count={logs.filter(l => !l.target).length}
            />
            {watchedTargets.map(t => (
              <LogTab
                key={t.id}
                active={logFilter === t.id}
                onClick={() => setLogFilter(t.id)}
                label={t.label}
                count={logs.filter(l => l.target === t.id).length}
              />
            ))}
            {/* Clear button */}
            <div className="ml-auto shrink-0">
              <button
                onClick={() => { emit('social-clear-logs'); setLogs([]); }}
                className="text-xs text-slate-400 hover:text-red-500 px-2 py-1"
              >
                Clear
              </button>
            </div>
          </div>

          {/* Lurk Mode Bar (shown when a target tab is selected & agent is active) */}
          {socialActive && selectedTarget && (() => {
            const currentMode = lurkModes[selectedTarget] || 'normal';
            const currentOpt = LURK_OPTIONS.find(o => o.mode === currentMode) || LURK_OPTIONS[0];
            return (
            <div className="flex items-center gap-1.5 px-4 py-1.5 border-b border-slate-100 bg-slate-50/60">
              <span className="text-xs text-slate-400 mr-1 shrink-0">{currentOpt.icon} {currentOpt.label}</span>
              {LURK_OPTIONS.map(opt => {
                const isActive = (lurkModes[selectedTarget] || 'normal') === opt.mode;
                return (
                  <button
                    key={opt.mode}
                    onClick={() => setTargetLurkMode(selectedTarget, opt.mode)}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md border transition-colors ${
                      isActive ? opt.activeCls : `${opt.cls} hover:opacity-80`
                    }`}
                  >
                    {opt.icon} {opt.label}
                  </button>
                );
              })}
            </div>
            );
          })()}

          {/* Content Toggle Bar */}
          <div className="flex items-center gap-1.5 px-4 py-1.5 border-b border-slate-100 bg-white/60">
            <span className="text-xs text-slate-400 mr-1 shrink-0">Show:</span>
            <ToggleBtn active={showChat} onClick={() => setShowChat(!showChat)} icon="💬" label="Chat" />
            <ToggleBtn active={showLlm} onClick={() => setShowLlm(!showLlm)} icon="🧠" label="LLM" />
            <ToggleBtn active={showTools} onClick={() => setShowTools(!showTools)} icon="🔧" label="Tools" />
            <ToggleBtn active={showSystem} onClick={() => setShowSystem(!showSystem)} icon="📋" label="System" />
          </div>

          {/* Log Content */}
          <div className="flex-1 min-h-0 overflow-y-auto px-4 py-2 text-xs font-mono space-y-0.5">
            {filteredLogs.length === 0 ? (
              <div className="text-slate-400 text-center py-8">No logs yet</div>
            ) : (
              [...filteredLogs].reverse().map((log, i) => (
                log.level === 'poll' ? (
                  <PollEntry key={i} log={log} showChat={showChat} showLlm={showLlm} showTools={showTools} logFilter={logFilter} />
                ) : (
                  <div key={i} className={`py-0.5 ${
                    log.level === 'error' ? 'text-red-600' :
                    log.level === 'warn' ? 'text-amber-600' :
                    log.level === 'memory' ? 'text-purple-600' :
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
  );
}

// ==================== Helper Components ====================

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

function LogTab({ active, onClick, label, count }) {
  return (
    <button
      onClick={onClick}
      className={`shrink-0 px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
        active
          ? 'bg-cyan-50 text-cyan-700 border border-cyan-200'
          : 'text-slate-500 hover:text-slate-700 hover:bg-slate-50 border border-transparent'
      }`}
    >
      {label}
      {count > 0 && (
        <span className={`ml-1 ${active ? 'text-cyan-500' : 'text-slate-400'}`}>
          {count}
        </span>
      )}
    </button>
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
      {showLlm && (() => {
        const iters = d.llmIters || [];
        const sent = d.sentMessages || [];
        if (iters.length === 0 && sent.length === 0) return null;
        // Build display lines for each iteration
        const lines = iters.map((it) => {
          const parts = [];
          if (it.reasoning) parts.push(`[Reasoning] ${it.reasoning}`);
          if (it.content) parts.push(it.content);
          if (it.toolNames?.length > 0 && parts.length === 0) {
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
