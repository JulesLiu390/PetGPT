import React, { useState, useEffect, useCallback, useMemo } from "react";
import { FaCheck, FaSpinner, FaChevronDown, FaChevronUp } from "react-icons/fa6";
import { MdCancel } from "react-icons/md";
import TitleBar from "../components/UI/TitleBar";
import { Card, FormGroup, Input, Select, Textarea, Button } from "../components/UI/ui";
import * as tauri from "../utils/tauri";
import { loadSocialConfig, saveSocialConfig, loadSavedTargetNames, loadSavedPausedTargets, saveTargetPausedDirect } from "../utils/socialAgent";
import { subagentRegistry, onSubagentChange, getActiveCount } from "../utils/subagentManager";
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
    enableImages: true,
    imageDescMode: 'off',
    imageDescProviderId: '',
    imageDescModelName: '',
    botQQ: '',
    intentModelName: '',
    // 独立 API 配置
    observerApiProviderId: '',
    observerModelName: '',
    intentApiProviderId: '',
    compressApiProviderId: '',
    compressModelName: '',
    // Subagent
    subagentEnabled: true,
    subagentMaxConcurrent: 5,
    subagentTimeoutSecs: 300,
    subagentModel: 'sonnet',
  });
  const [mcpServers, setMcpServers] = useState([]);
  const [saving, setSaving] = useState(false);
  const [socialActive, setSocialActive] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [logs, setLogs] = useState([]);
  const [groupsText, setGroupsText] = useState('');
  const [friendsText, setFriendsText] = useState('');

  // ── Log filtering (superset feature) ──
  const [logFilter, setLogFilter] = useState('all'); // 'all' | 'system' | target string
  const [showConfig, setShowConfig] = useState(false);
  const [showAdvancedLLM, setShowAdvancedLLM] = useState(false);
  const [lurkModes, setLurkModes] = useState({}); // { [target]: 'normal'|'semi-lurk'|'full-lurk' }
  const [trainingTargets, setTrainingTargets] = useState({}); // { [target]: true }
  const [trainingCollectionEnabled, setTrainingCollectionEnabled] = useState(false);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [exportOptions, setExportOptions] = useState({
    redact: true,
    statusSuccessOnly: true,
    terminationStrict: true,
  });
  const [exportResult, setExportResult] = useState(null);
  const [exportRunning, setExportRunning] = useState(false);
  const [targetNames, setTargetNames] = useState({}); // { [targetId]: displayName }
  const [pausedTargets, setPausedTargets] = useState({}); // { [target]: true }
  const [intentPlans, setIntentPlans] = useState({}); // { [target]: { planLogId, actions, state, doneTypes[] } }

  // ── MCP target picker ──
  const [mcpGroups, setMcpGroups] = useState(null); // [{ group_id, group_name, member_count }] or null
  const [mcpFriends, setMcpFriends] = useState(null); // [{ user_id, nickname }] or null
  const [fetchingGroups, setFetchingGroups] = useState(false);
  const [fetchingFriends, setFetchingFriends] = useState(false);

  // ── ElevenLabs TTS models ──
  // 兜底模型列表：当 API key 没有 models_read 权限时仍可选择
  const FALLBACK_TTS_MODELS = [
    { model_id: 'eleven_multilingual_v2', name: 'Multilingual v2 (推荐，多语言)' },
    { model_id: 'eleven_flash_v2_5', name: 'Flash v2.5 (超低延迟，多语言)' },
    { model_id: 'eleven_turbo_v2_5', name: 'Turbo v2.5 (低延迟，多语言)' },
    { model_id: 'eleven_flash_v2', name: 'Flash v2 (超低延迟，英文)' },
    { model_id: 'eleven_turbo_v2', name: 'Turbo v2 (低延迟，英文)' },
    { model_id: 'eleven_monolingual_v1', name: 'Monolingual v1 (英文)' },
    { model_id: 'eleven_multilingual_v1', name: 'Multilingual v1 (旧版)' },
  ];
  const [ttsModels, setTtsModels] = useState(FALLBACK_TTS_MODELS); // [{ model_id, name }]
  const [loadingTtsModels, setLoadingTtsModels] = useState(false);
  const [ttsModelsError, setTtsModelsError] = useState('');
  const [testingVoice, setTestingVoice] = useState(false);
  const [testVoiceError, setTestVoiceError] = useState('');

  // Helper: ensure MCP server is running, then call a tool
  const callMcpTool = async (toolName, args = {}) => {
    const serverName = config.mcpServerName;
    if (!serverName) throw new Error('No MCP server selected');
    // Find server and ensure it's running
    const server = await tauri.mcp.getServerByName(serverName);
    if (!server) throw new Error(`MCP server "${serverName}" not found`);
    const running = await tauri.mcp.isServerRunning(server._id);
    if (!running) {
      await tauri.mcp.startServer(server._id);
      // Brief wait for server to be ready
      await new Promise(r => setTimeout(r, 1500));
    }
    const fullName = `${serverName}__${toolName}`;
    const result = await tauri.mcp.callToolByName(fullName, args);
    if (result?.error) throw new Error(result.error);
    // Parse MCP CallToolResponse: { success, content: [{ type:'text', text:'...' }] }
    const textContent = result?.content?.find(c => c.type === 'text');
    if (!textContent?.text) throw new Error('Empty response from MCP');
    return JSON.parse(textContent.text);
  };

  const fetchMcpGroups = async () => {
    if (!config.mcpServerName) return;
    setFetchingGroups(true);
    try {
      const data = await callMcpTool('get_group_list');
      setMcpGroups(data.groups || []);
    } catch (e) {
      console.error('Failed to fetch group list:', e);
      setMcpGroups([]);
    }
    setFetchingGroups(false);
  };

  const fetchMcpFriends = async () => {
    if (!config.mcpServerName) return;
    setFetchingFriends(true);
    try {
      const data = await callMcpTool('get_friend_list');
      setMcpFriends(data.friends || []);
    } catch (e) {
      console.error('Failed to fetch friend list:', e);
      setMcpFriends([]);
    }
    setFetchingFriends(false);
  };

  // Reset fetched lists when MCP server changes
  useEffect(() => {
    setMcpGroups(null);
    setMcpFriends(null);
  }, [config.mcpServerName]);

  // Manual add input state
  const [addGroupInput, setAddGroupInput] = useState('');
  const [addFriendInput, setAddFriendInput] = useState('');

  // Helper: toggle a target ID in/out of a comma-separated text
  const toggleTarget = (id, text, setText) => {
    const items = text.split(',').map(s => s.trim()).filter(Boolean);
    if (items.includes(String(id))) {
      setText(items.filter(i => i !== String(id)).join(', '));
    } else {
      setText([...items, String(id)].join(', '));
    }
  };

  // Helper: add a new ID to the comma-separated text
  const addTarget = (input, setInput, text, setText) => {
    const id = input.trim();
    if (!id) return;
    const items = text.split(',').map(s => s.trim()).filter(Boolean);
    if (!items.includes(id)) {
      setText([...items, id].join(', '));
    }
    setInput('');
  };

  // ── Poll content visibility toggles ──
  const [showChat, setShowChat] = useState(true);
  const [showLlm, setShowLlm] = useState(false);
  const [showTools, setShowTools] = useState(true);
  const [showSystem, setShowSystem] = useState(true);
  const [showIntent, setShowIntent] = useState(true);
  const [showSubagent, setShowSubagent] = useState(true);
  const [showReflect, setShowReflect] = useState(true);
  const [showUsage, setShowUsage] = useState(true);
  const [activeSubagentCount, setActiveSubagentCount] = useState(0);
  const [cacheResetAt, setCacheResetAt] = useState(0);

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

    // 监听跨窗口 API providers 更新事件
    let unlisten;
    listen('api-providers-updated', () => { fetchData(); }).then(fn => { unlisten = fn; });
    return () => { if (unlisten) unlisten(); };
  }, []);

  // ── Load trainingCollectionEnabled and trainingTargets from persisted settings ──
  useEffect(() => {
    tauri.getSettings().then(s => {
      if (s?.trainingCollectionEnabled != null) setTrainingCollectionEnabled(!!s.trainingCollectionEnabled);
      if (s?.trainingTargets && typeof s.trainingTargets === 'object') setTrainingTargets(s.trainingTargets);
    }).catch(() => {});
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
          if (active) setIsStarting(false);
          if (!active) setActiveSubagentCount(0);
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

  // ── Subscribe to subagent registry changes ──
  useEffect(() => {
    const unsub = onSubagentChange(() => setActiveSubagentCount(getActiveCount()));
    return unsub;
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
        // Intent plan updates — drive the dynamic todolist
        if (entry.level === 'intent-plan' && entry.target && entry.details) {
          try {
            const plan = JSON.parse(entry.details);
            setIntentPlans(prev => ({
              ...prev,
              [entry.target]: { planLogId: entry.id, actions: plan.actions || [], state: plan.state || '', done: [] },
            }));
          } catch { /* ignore */ }
          return; // don't add to log list
        }
        if (entry.level === 'intent-action-done' && entry.target && entry.details) {
          try {
            const data = JSON.parse(entry.details);
            setIntentPlans(prev => {
              const cur = prev[entry.target];
              if (!cur) return prev;
              return { ...prev, [entry.target]: { ...cur, done: [...cur.done, data] } };
            });
          } catch { /* ignore */ }
          return; // don't add to log list
        }

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

  // ── Listen for cache stats reset (agent start) ──
  useEffect(() => {
    let unlisten = null;
    (async () => {
      unlisten = await listen('social-cache-stats-reset', () => {
        setCacheResetAt(Date.now());
      });
    })();
    return () => { if (unlisten) unlisten(); };
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
        // Restore per-server config if available
        const serverConfig = saved.configByServer?.[saved.mcpServerName] || {};
        setConfig({ ...saved, ...serverConfig, petId: selectedPetId });
        // Load targets for current server from targetsByServer, or fall back to watchedGroups/watchedFriends
        const serverTargets = saved.targetsByServer?.[saved.mcpServerName];
        if (serverTargets) {
          setGroupsText((serverTargets.groups || []).join(', '));
          setFriendsText((serverTargets.friends || []).join(', '));
        } else {
          setGroupsText((saved.watchedGroups || []).join(', '));
          setFriendsText((saved.watchedFriends || []).join(', '));
        }
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
          observerApiProviderId: '',
          observerModelName: '',
          intentApiProviderId: '',
          intentModelName: '',
          compressApiProviderId: '',
          compressModelName: '',
        }));
        setGroupsText('');
        setFriendsText('');
      }
      // 预加载群名缓存（即使 agent 未启动）
      const savedNames = await loadSavedTargetNames(selectedPetId);
      if (savedNames && Object.keys(savedNames).length > 0) {
        setTargetNames(prev => ({ ...prev, ...savedNames }));
      }
      // 预加载 paused 状态（即使 agent 未启动）
      const savedPaused = await loadSavedPausedTargets(selectedPetId);
      if (savedPaused && typeof savedPaused === 'object') {
        setPausedTargets(savedPaused);
      }
      emit('social-query-status');
    };
    load();
  }, [selectedPetId]);

  // ── Auto-select last used assistant (or first) ──
  useEffect(() => {
    if (assistants.length > 0 && !selectedPetId) {
      (async () => {
        try {
          const settings = await tauri.getSettings();
          const lastId = settings?.social_last_pet_id;
          if (lastId && assistants.some(a => a._id === lastId)) {
            setSelectedPetId(lastId);
            return;
          }
        } catch (e) { /* ignore */ }
        setSelectedPetId(assistants[0]._id);
      })();
    }
  }, [assistants, selectedPetId]);

  // ── Persist last selected assistant ──
  useEffect(() => {
    if (selectedPetId) {
      tauri.updateSettings({ social_last_pet_id: selectedPetId }).catch(() => {});
    }
  }, [selectedPetId]);

  // ── Per-server config keys (saved/restored when switching MCP) ──
  const PER_SERVER_KEYS = [
    'apiProviderId', 'modelName',
    'observerApiProviderId', 'observerModelName',
    'intentApiProviderId', 'intentModelName',
    'compressApiProviderId', 'compressModelName',
    'imageDescProviderId', 'imageDescModelName', 'imageDescMode',
    'replyInterval', 'observerInterval',
    'botQQ', 'ownerQQ', 'ownerName',
    'enabledMcpServers',
    'subagentEnabled', 'subagentMaxConcurrent', 'subagentTimeoutSecs', 'subagentModel',
  ];

  // ── Handlers ──
  const handleConfigChange = (field, value) => {
    if (field === 'mcpServerName') {
      // Switching MCP server: save ALL per-server settings, load new server's settings
      const oldServer = config.mcpServerName;
      const currentGroups = groupsText.split(',').map(s => s.trim()).filter(Boolean);
      const currentFriends = friendsText.split(',').map(s => s.trim()).filter(Boolean);

      // Save targets
      const updatedTargets = { ...(config.targetsByServer || {}) };
      if (oldServer) {
        updatedTargets[oldServer] = { groups: currentGroups, friends: currentFriends };
      }

      // Save per-server config
      const updatedConfigByServer = { ...(config.configByServer || {}) };
      if (oldServer) {
        const serverSnapshot = {};
        for (const key of PER_SERVER_KEYS) {
          if (config[key] !== undefined) serverSnapshot[key] = config[key];
        }
        updatedConfigByServer[oldServer] = serverSnapshot;
      }

      // Restore new server's config
      const newServerConfig = updatedConfigByServer[value] || {};
      const newTargets = updatedTargets[value] || { groups: [], friends: [] };
      setGroupsText((newTargets.groups || []).join(', '));
      setFriendsText((newTargets.friends || []).join(', '));
      setConfig(prev => ({
        ...prev,
        ...newServerConfig,
        mcpServerName: value,
        targetsByServer: updatedTargets,
        configByServer: updatedConfigByServer,
      }));
    } else {
      setConfig(prev => ({ ...prev, [field]: value }));
    }
  };

  const buildConfigToSave = useCallback(() => {
    const groups = groupsText.split(',').map(s => s.trim()).filter(Boolean);
    const friends = friendsText.split(',').map(s => s.trim()).filter(Boolean);
    const updatedTargets = { ...(config.targetsByServer || {}) };
    if (config.mcpServerName) {
      updatedTargets[config.mcpServerName] = { groups, friends };
    }
    // Save current per-server config snapshot
    const updatedConfigByServer = { ...(config.configByServer || {}) };
    if (config.mcpServerName) {
      const serverSnapshot = {};
      for (const key of PER_SERVER_KEYS) {
        if (config[key] !== undefined) serverSnapshot[key] = config[key];
      }
      updatedConfigByServer[config.mcpServerName] = serverSnapshot;
    }
    return {
      ...config,
      petId: selectedPetId,
      watchedGroups: groups,
      watchedFriends: friends,
      targetsByServer: updatedTargets,
      configByServer: updatedConfigByServer,
    };
  }, [config, selectedPetId, groupsText, friendsText]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const configToSave = buildConfigToSave();
      await saveSocialConfig(selectedPetId, configToSave);
      setConfig(configToSave);
      if (socialActive) {
        emit('social-config-updated', configToSave);
      }
      alert('Social configuration saved successfully!');
    } catch (e) {
      console.error('Failed to save social config:', e);
      alert('Failed to save social config: ' + (e.message || e));
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async () => {
    if (socialActive) {
      emit('social-stop');
    } else {
      setIsStarting(true);
      const configToStart = buildConfigToSave();
      await saveSocialConfig(selectedPetId, configToStart);
      setConfig(configToStart);
      const appSettings = await tauri.getSettings().catch(() => ({}));
      emit('social-start', {
        ...configToStart,
        trainingCollectionEnabled: appSettings?.trainingCollectionEnabled || false,
        trainingTargets,
      });
    }
  };

  // ── Derived state ──
  const sortModels = (models) => [...(models || [])].sort((a, b) => {
    const na = typeof a === 'string' ? a : a.id;
    const nb = typeof b === 'string' ? b : b.id;
    return na.localeCompare(nb);
  });

  const selectedProvider = apiProviders.find(p => (p._id || p.id) === config.apiProviderId);
  const providerModels = sortModels(selectedProvider?.cachedModels);

  const observerProvider = apiProviders.find(p => (p._id || p.id) === config.observerApiProviderId);
  const observerProviderModels = sortModels(observerProvider?.cachedModels);

  const intentProvider = apiProviders.find(p => (p._id || p.id) === config.intentApiProviderId);
  const intentProviderModels = sortModels(intentProvider?.cachedModels);

  const compressProvider = apiProviders.find(p => (p._id || p.id) === config.compressApiProviderId);
  const compressProviderModels = sortModels(compressProvider?.cachedModels);

  const visionProvider = apiProviders.find(p => (p._id || p.id) === config.imageDescProviderId);
  const visionProviderModels = [...(visionProvider?.cachedModels || [])].sort((a, b) => {
    const na = typeof a === 'string' ? a : a.id;
    const nb = typeof b === 'string' ? b : b.id;
    return na.localeCompare(nb);
  });

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
    if (log.level === 'intent' || log.level === 'send') return showIntent && (logFilter === 'all' || logFilter === 'system' || log.target === logFilter);
    if (log.level === 'subagent') return showSubagent && (logFilter === 'all' || logFilter === 'system' || log.target === logFilter);
    if (log.level === 'reflect') return showReflect && (logFilter === 'all' || logFilter === 'system' || log.target === logFilter);
    if (log.level === 'usage') return showUsage && (logFilter === 'all' || logFilter === 'system' || log.target === logFilter);
    if (logFilter === 'system' && log.target) return false;
    if (logFilter !== 'all' && logFilter !== 'system' && log.target !== logFilter) return false;
    if (log.level === 'poll') return true;
    if (!showSystem) return false;
    return true;
  }), [sortedLogs, logFilter, showSystem, showIntent, showSubagent, showReflect, showUsage]);

  // Newest first — just reverse the already-sorted filtered logs (O(N))
  const reversedFilteredLogs = useMemo(() => [...filteredLogs].reverse(), [filteredLogs]);

  // Usage logs after the most recent agent start (for PromptCachePanel)
  const usageLogsAfterReset = useMemo(
    () => sortedLogs.filter(l => {
      if (l.level !== 'usage') return false;
      const t = typeof l.timestamp === 'number' ? l.timestamp : new Date(l.timestamp).getTime();
      return t >= cacheResetAt;
    }),
    [sortedLogs, cacheResetAt],
  );

  // ── Close handler ──
  const handleClose = () => {
    tauri.hideSocialWindow();
  };

  // ── Training Export ──
  const runExport = async () => {
    setExportRunning(true);
    setExportResult(null);
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      let outputPath;
      try {
        const homeDir = await tauri.getHomeDir();
        outputPath = `${homeDir}/Downloads/qwen_intent_${timestamp}.jsonl`;
      } catch {
        outputPath = `./qwen_intent_${timestamp}.jsonl`;
      }

      const result = await tauri.runTrainingExport({
        pet_id: selectedPetId,
        output_path: outputPath,
        redact: exportOptions.redact,
        status: exportOptions.statusSuccessOnly ? 'success' : null,
        termination: exportOptions.terminationStrict ? 'write_intent_plan' : null,
      });
      setExportResult({ ...result, outputPath });
    } catch (e) {
      setExportResult({ stdout: '', stderr: String(e?.message || e), success: false, outputPath: '' });
    } finally {
      setExportRunning(false);
    }
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
  const setTargetTrainingEnabled = (target, enabled) => {
    emit('social-set-training-enabled', { target, enabled });
    setTrainingTargets(prev => {
      const next = { ...prev, [target]: enabled };
      tauri.updateSettings({ trainingTargets: next }).catch(() => {});
      return next;
    });
  };
  const toggleTargetPaused = (target) => {
    const isPaused = pausedTargets[target] || false;
    const newPaused = !isPaused;
    if (socialActive) {
      // agent 运行时：通过事件通知 agent（agent 会同时持久化）
      emit('social-set-target-paused', { target, paused: newPaused });
    } else {
      // agent 未启动：直接更新 UI 状态 + 持久化到 DB
      setPausedTargets(prev => ({ ...prev, [target]: newPaused }));
      if (selectedPetId) saveTargetPausedDirect(selectedPetId, target, newPaused);
    }
  };
  // Which target is selected in the log filter (not 'all'/'system')
  const selectedTarget = logFilter !== 'all' && logFilter !== 'system' ? logFilter : null;

  return (
    <>
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
              disabled={!selectedPetId || isStarting}
              className={`no-drag px-3 py-1.5 text-xs font-medium rounded-lg ${
                socialActive
                  ? 'bg-red-500 text-white hover:bg-red-600'
                  : 'bg-cyan-500 text-white hover:bg-cyan-600'
              } disabled:opacity-50`}
            >
              {isStarting ? (
                <FaSpinner className="animate-spin inline-block" />
              ) : socialActive ? 'Stop' : 'Start'}
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

              {/* Prompt Configuration (bot-level, shared across all MCP servers) */}
              <Card title="Prompts" description="Customize social behavior and reply strategy (shared across all servers)">
                <div className="space-y-3">
                  <FormGroup label="Social Persona" hint="Additional persona instructions for social context">
                    <Textarea
                      rows={3}
                      value={config.socialPersonaPrompt}
                      onChange={(e) => handleConfigChange('socialPersonaPrompt', e.target.value)}
                      placeholder="e.g. You're an active group member who loves using emoji..."
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
                    label="Enable Images"
                    hint="Send images to LLM for understanding; disable if provider doesn't support vision"
                    checked={config.enableImages !== false}
                    onChange={(v) => handleConfigChange('enableImages', v)}
                  />
                </div>
              </Card>

              {/* Prompt Cache — performance setting for OpenAI-type APIs */}
              <Card title="Prompt Cache" description="显式缓存参数（仅影响 OpenAI 类 API；Anthropic 始终启用，Gemini 走隐式缓存）">
                <ToggleRow
                  label="启用显式 Prompt Cache（OpenAI 类 API）"
                  hint="向 OpenAI 类 API 附加 prompt_cache_key + 24h 保留，提升多轮缓存命中率。如果你用的兼容网关对未知字段报错，请关闭此开关。"
                  checked={config.explicitPromptCache !== false}
                  onChange={(v) => handleConfigChange('explicitPromptCache', v)}
                />
              </Card>

              {/* MCP Server — all per-server settings nested below */}
              <Card title="MCP Server" description="Server-specific settings (LLMs, IDs, targets, intervals)">
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
              </Card>

              {/* Per-server settings — only show when a server is selected */}
              {config.mcpServerName && (
                <div className="pl-4 border-l-2 border-blue-200 space-y-4">
                  {/* Bot / Owner IDs */}
                  <Card title={`${config.mcpServerName} Identity`} description="Bot and owner identification">
                    <div className="space-y-3">
                      <FormGroup label={`Bot ${config.mcpServerName} ID`} hint={`Your bot's ID on ${config.mcpServerName}, used to detect @mentions`}>
                        <Input
                          value={config.botQQ}
                          onChange={(e) => handleConfigChange('botQQ', e.target.value)}
                          placeholder="e.g. 3825478002 or @bot_username"
                        />
                      </FormGroup>
                      <FormGroup label={`Owner ${config.mcpServerName} ID`} hint={`Your personal ID on ${config.mcpServerName}, so the bot can recognize you`}>
                        <Input
                          value={config.ownerQQ}
                          onChange={(e) => handleConfigChange('ownerQQ', e.target.value)}
                          placeholder="e.g. 123456789 or @username"
                        />
                      </FormGroup>
                      <FormGroup label="Owner Name" hint="Your display name or nickname">
                        <Input
                          value={config.ownerName}
                          onChange={(e) => handleConfigChange('ownerName', e.target.value)}
                          placeholder="e.g. Jules"
                        />
                      </FormGroup>
                    </div>
                  </Card>

                  {/* LLM Configuration — Reply (main) */}
                  <Card title="Reply LLM" description="API provider and model for reply decisions (main model)">
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

                  {/* Advanced LLM Settings — collapsible */}
                  <button
                    onClick={() => setShowAdvancedLLM(!showAdvancedLLM)}
                    className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium text-slate-600 bg-slate-50 hover:bg-slate-100 rounded-lg transition-colors"
                  >
                    <span>Advanced LLM Settings</span>
                    {showAdvancedLLM ? <FaChevronUp className="w-3 h-3" /> : <FaChevronDown className="w-3 h-3" />}
                  </button>
                  {showAdvancedLLM && <>

                  {/* Observer LLM — independent toggle */}
                  <Card title="Observer LLM" description="Independent API for group observation and memory recording">
                    <div className="space-y-3">
                      <label className="flex items-center gap-2 text-xs text-slate-600 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={!!config.observerApiProviderId}
                          onChange={(e) => {
                            if (!e.target.checked) {
                              handleConfigChange('observerApiProviderId', '');
                              handleConfigChange('observerModelName', '');
                            } else {
                              handleConfigChange('observerApiProviderId', config.apiProviderId);
                            }
                          }}
                          className="rounded border-slate-300"
                        />
                        Use independent API (uncheck to use Reply LLM)
                      </label>
                      {config.observerApiProviderId && (
                        <>
                          <FormGroup label="API Provider">
                            <Select
                              value={config.observerApiProviderId}
                              onChange={(e) => {
                                handleConfigChange('observerApiProviderId', e.target.value);
                                handleConfigChange('observerModelName', '');
                              }}
                            >
                              <option value="">Select provider...</option>
                              {apiProviders.map(p => (
                                <option key={p._id || p.id} value={p._id || p.id}>{p.name}</option>
                              ))}
                            </Select>
                          </FormGroup>
                          <FormGroup label="Model">
                            {observerProviderModels.length > 0 ? (
                              <Select
                                value={config.observerModelName}
                                onChange={(e) => handleConfigChange('observerModelName', e.target.value)}
                              >
                                <option value="">Select model...</option>
                                {observerProviderModels.map(m => {
                                  const modelId = typeof m === 'string' ? m : m.id;
                                  return <option key={modelId} value={modelId}>{modelId}</option>;
                                })}
                              </Select>
                            ) : (
                              <Input
                                value={config.observerModelName}
                                onChange={(e) => handleConfigChange('observerModelName', e.target.value)}
                                placeholder="e.g. gpt-4o-mini"
                              />
                            )}
                          </FormGroup>
                        </>
                      )}
                    </div>
                  </Card>

                  {/* Intent LLM — independent toggle */}
                  <Card title="Intent LLM" description="Independent API for willingness analysis">
                    <div className="space-y-3">
                      <label className="flex items-center gap-2 text-xs text-slate-600 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={!!config.intentApiProviderId}
                          onChange={(e) => {
                            if (!e.target.checked) {
                              handleConfigChange('intentApiProviderId', '');
                              handleConfigChange('intentModelName', '');
                            } else {
                              handleConfigChange('intentApiProviderId', config.apiProviderId);
                            }
                          }}
                          className="rounded border-slate-300"
                        />
                        Use independent API (uncheck to use Reply LLM)
                      </label>
                      {config.intentApiProviderId ? (
                        <>
                          <FormGroup label="API Provider">
                            <Select
                              value={config.intentApiProviderId}
                              onChange={(e) => {
                                handleConfigChange('intentApiProviderId', e.target.value);
                                handleConfigChange('intentModelName', '');
                              }}
                            >
                              <option value="">Select provider...</option>
                              {apiProviders.map(p => (
                                <option key={p._id || p.id} value={p._id || p.id}>{p.name}</option>
                              ))}
                            </Select>
                          </FormGroup>
                          <FormGroup label="Model">
                            {intentProviderModels.length > 0 ? (
                              <Select
                                value={config.intentModelName}
                                onChange={(e) => handleConfigChange('intentModelName', e.target.value)}
                              >
                                <option value="">Select model...</option>
                                {intentProviderModels.map(m => {
                                  const modelId = typeof m === 'string' ? m : m.id;
                                  return <option key={modelId} value={modelId}>{modelId}</option>;
                                })}
                              </Select>
                            ) : (
                              <Input
                                value={config.intentModelName}
                                onChange={(e) => handleConfigChange('intentModelName', e.target.value)}
                                placeholder="e.g. gpt-4o-mini"
                              />
                            )}
                          </FormGroup>
                        </>
                      ) : (
                        <FormGroup label="Model (optional, use different model from same provider)">
                          {providerModels.length > 0 ? (
                            <Select
                              value={config.intentModelName}
                              onChange={(e) => handleConfigChange('intentModelName', e.target.value)}
                            >
                              <option value="">Same as Reply model</option>
                              {providerModels.map(m => {
                                const modelId = typeof m === 'string' ? m : m.id;
                                return <option key={modelId} value={modelId}>{modelId}</option>;
                              })}
                            </Select>
                          ) : (
                            <Input
                              value={config.intentModelName}
                              onChange={(e) => handleConfigChange('intentModelName', e.target.value)}
                              placeholder="Leave empty to use Reply model"
                            />
                          )}
                        </FormGroup>
                      )}
                    </div>
                  </Card>

                  {/* Compress LLM — independent toggle */}
                  <Card title="Compress LLM" description="Independent API for daily compression and MCP sampling">
                    <div className="space-y-3">
                      <label className="flex items-center gap-2 text-xs text-slate-600 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={!!config.compressApiProviderId}
                          onChange={(e) => {
                            if (!e.target.checked) {
                              handleConfigChange('compressApiProviderId', '');
                              handleConfigChange('compressModelName', '');
                            } else {
                              handleConfigChange('compressApiProviderId', config.apiProviderId);
                            }
                          }}
                          className="rounded border-slate-300"
                        />
                        Use independent API (uncheck to use Reply LLM)
                      </label>
                      {config.compressApiProviderId && (
                        <>
                          <FormGroup label="API Provider">
                            <Select
                              value={config.compressApiProviderId}
                              onChange={(e) => {
                                handleConfigChange('compressApiProviderId', e.target.value);
                                handleConfigChange('compressModelName', '');
                              }}
                            >
                              <option value="">Select provider...</option>
                              {apiProviders.map(p => (
                                <option key={p._id || p.id} value={p._id || p.id}>{p.name}</option>
                              ))}
                            </Select>
                          </FormGroup>
                          <FormGroup label="Model">
                            {compressProviderModels.length > 0 ? (
                              <Select
                                value={config.compressModelName}
                                onChange={(e) => handleConfigChange('compressModelName', e.target.value)}
                              >
                                <option value="">Select model...</option>
                                {compressProviderModels.map(m => {
                                  const modelId = typeof m === 'string' ? m : m.id;
                                  return <option key={modelId} value={modelId}>{modelId}</option>;
                                })}
                              </Select>
                            ) : (
                              <Input
                                value={config.compressModelName}
                                onChange={(e) => handleConfigChange('compressModelName', e.target.value)}
                                placeholder="e.g. gpt-4o-mini"
                              />
                            )}
                          </FormGroup>
                        </>
                      )}
                    </div>
                  </Card>

                  {/* Vision Model (Image Pre-Description) */}
                  <Card title="Vision Model" description="Use a vision LLM to describe images before sending to main model">
                    <div className="space-y-3">
                      <FormGroup label="Image Pre-Description">
                        <Select
                          value={config.imageDescMode || 'off'}
                          onChange={(e) => {
                            handleConfigChange('imageDescMode', e.target.value);
                            if (e.target.value !== 'other') {
                              handleConfigChange('imageDescProviderId', '');
                              handleConfigChange('imageDescModelName', '');
                            }
                          }}
                        >
                          <option value="off">Off</option>
                          <option value="self">Self (use main model)</option>
                          <option value="other">Other (use independent model)</option>
                        </Select>
                      </FormGroup>
                      {config.imageDescMode === 'other' && (
                        <>
                          <FormGroup label="API Provider">
                            <Select
                              value={config.imageDescProviderId}
                              onChange={(e) => {
                                handleConfigChange('imageDescProviderId', e.target.value);
                                handleConfigChange('imageDescModelName', '');
                              }}
                            >
                              <option value="">Select provider...</option>
                              {apiProviders.map(p => (
                                <option key={p._id || p.id} value={p._id || p.id}>{p.name}</option>
                              ))}
                            </Select>
                          </FormGroup>
                          <FormGroup label="Model">
                            {visionProviderModels.length > 0 ? (
                              <Select
                                value={config.imageDescModelName}
                                onChange={(e) => handleConfigChange('imageDescModelName', e.target.value)}
                              >
                                <option value="">Select model...</option>
                                {visionProviderModels.map(m => {
                                  const modelId = typeof m === 'string' ? m : m.id;
                                  return <option key={modelId} value={modelId}>{modelId}</option>;
                                })}
                              </Select>
                            ) : (
                              <Input
                                value={config.imageDescModelName}
                                onChange={(e) => handleConfigChange('imageDescModelName', e.target.value)}
                                placeholder="e.g. gemini-2.0-flash"
                              />
                            )}
                          </FormGroup>
                        </>
                      )}
                    </div>
                  </Card>

                  </>}

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

                  {/* Watch Targets */}
                  <Card title="Watch Targets" description="Groups and private chats to monitor">
                    <div className="space-y-4">
                      {/* Groups */}
                      <FormGroup label="Groups">
                        {mcpGroups ? (
                          /* Fetched: show full checkbox list */
                          <div className="max-h-56 overflow-y-auto border border-slate-200 rounded-lg">
                            {mcpGroups.map(g => {
                              const selected = groupsText.split(',').map(s => s.trim()).includes(String(g.group_id));
                              return (
                                <label key={g.group_id} className={`flex items-center gap-3 px-3 py-1.5 cursor-pointer hover:bg-slate-50 transition-colors border-b border-slate-100 last:border-b-0 ${selected ? 'bg-blue-50' : ''}`}>
                                  <input
                                    type="checkbox"
                                    checked={selected}
                                    onChange={() => toggleTarget(g.group_id, groupsText, setGroupsText)}
                                    className="rounded border-slate-300 text-blue-500 focus:ring-blue-400"
                                  />
                                  <span className="text-sm text-slate-700 truncate">
                                    {g.group_name || 'Unknown'} <span className="text-slate-400">({g.group_id})</span>
                                  </span>
                                </label>
                              );
                            })}
                            {mcpGroups.length === 0 && <div className="text-xs text-slate-400 px-3 py-2">No groups found</div>}
                          </div>
                        ) : (
                          /* Not fetched: show selected items as scrollable list + add input */
                          <>
                            {groupsText.trim() && (
                              <div className="max-h-40 overflow-y-auto border border-slate-200 rounded-lg mb-2">
                                {groupsText.split(',').map(s => s.trim()).filter(Boolean).map(id => (
                                  <div key={id} className="flex items-center justify-between px-3 py-1.5 border-b border-slate-100 last:border-b-0">
                                    <span className="text-sm text-slate-700 truncate">
                                      {targetNames[id] ? `${targetNames[id]} ` : ''}<span className="text-slate-400">({id})</span>
                                    </span>
                                    <button onClick={() => toggleTarget(id, groupsText, setGroupsText)} className="text-slate-400 hover:text-red-500 text-xs ml-2 shrink-0">✕</button>
                                  </div>
                                ))}
                              </div>
                            )}
                            <div className="flex items-center gap-2">
                              <Input
                                value={addGroupInput}
                                onChange={(e) => setAddGroupInput(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTarget(addGroupInput, setAddGroupInput, groupsText, setGroupsText); } }}
                                placeholder="Enter group ID..."
                                className="flex-1"
                              />
                              <button
                                onClick={() => addTarget(addGroupInput, setAddGroupInput, groupsText, setGroupsText)}
                                disabled={!addGroupInput.trim()}
                                className="shrink-0 px-3 py-2 text-xs font-medium rounded-lg border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                              >+ Add</button>
                            </div>
                          </>
                        )}
                        {config.mcpServerName && (
                          <button
                            onClick={fetchMcpGroups}
                            disabled={fetchingGroups}
                            className="mt-2 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                          >
                            {fetchingGroups ? <FaSpinner className="inline animate-spin mr-1" /> : null}
                            {mcpGroups ? '🔄 Refresh' : '🔄 Fetch from MCP'}
                          </button>
                        )}
                      </FormGroup>

                      {/* Private Chats */}
                      <FormGroup label="Private Chats">
                        {mcpFriends ? (
                          <div className="max-h-56 overflow-y-auto border border-slate-200 rounded-lg">
                            {mcpFriends.map(f => {
                              const selected = friendsText.split(',').map(s => s.trim()).includes(String(f.user_id));
                              return (
                                <label key={f.user_id} className={`flex items-center gap-3 px-3 py-1.5 cursor-pointer hover:bg-slate-50 transition-colors border-b border-slate-100 last:border-b-0 ${selected ? 'bg-blue-50' : ''}`}>
                                  <input
                                    type="checkbox"
                                    checked={selected}
                                    onChange={() => toggleTarget(f.user_id, friendsText, setFriendsText)}
                                    className="rounded border-slate-300 text-blue-500 focus:ring-blue-400"
                                  />
                                  <span className="text-sm text-slate-700 truncate">
                                    {f.nickname || 'Unknown'} <span className="text-slate-400">({f.user_id})</span>
                                  </span>
                                </label>
                              );
                            })}
                            {mcpFriends.length === 0 && <div className="text-xs text-slate-400 px-3 py-2">No friends found</div>}
                          </div>
                        ) : (
                          <>
                            {friendsText.trim() && (
                              <div className="max-h-40 overflow-y-auto border border-slate-200 rounded-lg mb-2">
                                {friendsText.split(',').map(s => s.trim()).filter(Boolean).map(id => (
                                  <div key={id} className="flex items-center justify-between px-3 py-1.5 border-b border-slate-100 last:border-b-0">
                                    <span className="text-sm text-slate-700 truncate">
                                      {targetNames[id] ? `${targetNames[id]} ` : ''}<span className="text-slate-400">({id})</span>
                                    </span>
                                    <button onClick={() => toggleTarget(id, friendsText, setFriendsText)} className="text-slate-400 hover:text-red-500 text-xs ml-2 shrink-0">✕</button>
                                  </div>
                                ))}
                              </div>
                            )}
                            <div className="flex items-center gap-2">
                              <Input
                                value={addFriendInput}
                                onChange={(e) => setAddFriendInput(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTarget(addFriendInput, setAddFriendInput, friendsText, setFriendsText); } }}
                                placeholder="Enter user ID..."
                                className="flex-1"
                              />
                              <button
                                onClick={() => addTarget(addFriendInput, setAddFriendInput, friendsText, setFriendsText)}
                                disabled={!addFriendInput.trim()}
                                className="shrink-0 px-3 py-2 text-xs font-medium rounded-lg border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                              >+ Add</button>
                            </div>
                          </>
                        )}
                        {config.mcpServerName && (
                          <button
                            onClick={fetchMcpFriends}
                            disabled={fetchingFriends}
                            className="mt-2 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                          >
                            {fetchingFriends ? <FaSpinner className="inline animate-spin mr-1" /> : null}
                            {mcpFriends ? '🔄 Refresh' : '🔄 Fetch from MCP'}
                          </button>
                        )}
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

                  {/* CC Subagent */}
                  <Card>
                    <div className="flex items-center gap-2 mb-2">
                      <input
                        type="checkbox"
                        checked={config.subagentEnabled !== false}
                        onChange={(e) => handleConfigChange('subagentEnabled', e.target.checked)}
                        className="rounded"
                      />
                      <span className="text-sm font-medium text-gray-700">CC Subagent</span>
                      <span className="text-xs text-gray-400">后台研究任务</span>
                    </div>
                    {config.subagentEnabled !== false && (
                      <div className="grid grid-cols-3 gap-3">
                        <FormGroup label="Max Concurrent" hint="同时运行上限">
                          <Input
                            type="number"
                            min={1}
                            max={20}
                            value={config.subagentMaxConcurrent ?? 5}
                            onChange={(e) => handleConfigChange('subagentMaxConcurrent', parseInt(e.target.value) || 5)}
                          />
                        </FormGroup>
                        <FormGroup label="Timeout (seconds)" hint="兜底超时">
                          <Input
                            type="number"
                            min={30}
                            max={600}
                            value={config.subagentTimeoutSecs ?? 300}
                            onChange={(e) => handleConfigChange('subagentTimeoutSecs', parseInt(e.target.value) || 300)}
                          />
                        </FormGroup>
                        <FormGroup label="Model" hint="CC 模型">
                          <Input
                            type="text"
                            value={config.subagentModel || 'sonnet'}
                            onChange={(e) => handleConfigChange('subagentModel', e.target.value)}
                            placeholder="sonnet"
                          />
                        </FormGroup>
                      </div>
                    )}
                  </Card>

                  {/* TTS / 语音 (ElevenLabs) */}
                  <Card>
                    <div className="flex items-center gap-2 mb-2">
                      <input
                        type="checkbox"
                        checked={!!config.ttsConfig?.enabled}
                        onChange={(e) => handleConfigChange('ttsConfig', { ...(config.ttsConfig || {}), enabled: e.target.checked })}
                        className="rounded"
                      />
                      <span className="text-sm font-medium text-gray-700">TTS 语音 (ElevenLabs)</span>
                      <span className="text-xs text-gray-400">启用 voice_send 内置工具，最多 50 字</span>
                    </div>
                    {config.ttsConfig?.enabled && (
                      <div className="grid grid-cols-2 gap-3">
                        <FormGroup label="API Key" hint="ElevenLabs xi-api-key">
                          <Input
                            type="password"
                            value={config.ttsConfig?.apiKey || ''}
                            onChange={(e) => handleConfigChange('ttsConfig', { ...(config.ttsConfig || {}), apiKey: e.target.value })}
                            placeholder="sk_..."
                          />
                        </FormGroup>
                        <FormGroup label="Voice ID" hint={testVoiceError || (testingVoice ? '生成中...' : 'ElevenLabs voice id')}>
                          <div className="flex gap-2">
                            <Input
                              type="text"
                              value={config.ttsConfig?.voiceId || ''}
                              onChange={(e) => handleConfigChange('ttsConfig', { ...(config.ttsConfig || {}), voiceId: e.target.value })}
                              placeholder="21m00Tcm4TlvDq8ikWAM"
                            />
                            <button
                              type="button"
                              className="px-2 py-1 text-xs border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap"
                              disabled={testingVoice || !config.ttsConfig?.apiKey || !config.ttsConfig?.voiceId}
                              onClick={async () => {
                                setTestingVoice(true);
                                setTestVoiceError('');
                                try {
                                  const base64 = await tauri.elevenlabsTts({
                                    apiKey: config.ttsConfig.apiKey,
                                    voiceId: config.ttsConfig.voiceId,
                                    text: 'hello',
                                    modelId: config.ttsConfig.modelId || undefined,
                                  });
                                  if (!base64) throw new Error('返回为空');
                                  const audio = new Audio(`data:audio/mpeg;base64,${base64}`);
                                  await audio.play();
                                } catch (err) {
                                  setTestVoiceError(String(err?.message || err).slice(0, 80));
                                } finally {
                                  setTestingVoice(false);
                                }
                              }}
                            >
                              {testingVoice ? '测试中...' : '测试'}
                            </button>
                          </div>
                        </FormGroup>
                        <FormGroup label="Model" hint={ttsModelsError ? `刷新失败: ${ttsModelsError}（仍可使用兜底列表）` : `${ttsModels.length} 个模型可选`}>
                          <div className="flex gap-2">
                            <select
                              className="flex-1 px-2 py-1.5 text-sm border border-slate-200 rounded bg-white"
                              value={config.ttsConfig?.modelId || ''}
                              onChange={(e) => handleConfigChange('ttsConfig', { ...(config.ttsConfig || {}), modelId: e.target.value })}
                            >
                              <option value="">默认 (eleven_multilingual_v2)</option>
                              {ttsModels.map(m => (
                                <option key={m.model_id} value={m.model_id}>{m.name} ({m.model_id})</option>
                              ))}
                            </select>
                            <button
                              type="button"
                              className="px-2 py-1 text-xs border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-50"
                              disabled={loadingTtsModels || !config.ttsConfig?.apiKey}
                              title="拉取最新模型列表（需要 API key 有 models_read 权限）"
                              onClick={async () => {
                                setLoadingTtsModels(true);
                                setTtsModelsError('');
                                try {
                                  const list = await tauri.elevenlabsListModels(config.ttsConfig.apiKey);
                                  if (Array.isArray(list) && list.length > 0) {
                                    setTtsModels(list);
                                  } else {
                                    setTtsModelsError('返回为空');
                                  }
                                } catch (err) {
                                  // 失败保留原有列表（兜底或上次成功的）
                                  setTtsModelsError(String(err?.message || err).slice(0, 80));
                                } finally {
                                  setLoadingTtsModels(false);
                                }
                              }}
                            >
                              {loadingTtsModels ? '加载中...' : '刷新'}
                            </button>
                          </div>
                        </FormGroup>
                      </div>
                    )}
                  </Card>
                </div>
              )}

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
                const isTrainingEnabled = trainingTargets[t.id] || false;
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
                    paused={isPaused}
                    onPauseClick={() => toggleTargetPaused(t.id)}
                    trainingEnabled={trainingCollectionEnabled ? isTrainingEnabled : undefined}
                    onTrainingClick={trainingCollectionEnabled ? () => setTargetTrainingEnabled(t.id, !isTrainingEnabled) : null}
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
            <div className="flex flex-wrap items-center gap-1.5 px-3 py-1.5 border-b border-slate-100 bg-white/60 shrink-0">
              <span className="text-xs text-slate-400 mr-0.5 shrink-0">Show:</span>
              <ToggleBtn active={showChat} onClick={() => setShowChat(!showChat)} icon="💬" label="Chat" />
              <ToggleBtn active={showLlm} onClick={() => setShowLlm(!showLlm)} icon="🧠" label="LLM" />
              <ToggleBtn active={showTools} onClick={() => setShowTools(!showTools)} icon="🔧" label="Tools" />
              <ToggleBtn active={showSystem} onClick={() => setShowSystem(!showSystem)} icon="📋" label="System" />
              <ToggleBtn active={showIntent} onClick={() => setShowIntent(!showIntent)} icon="🧠" label="Intent" />
              <ToggleBtn active={showSubagent} onClick={() => setShowSubagent(!showSubagent)} icon="🤖" label="Subagent" />
              <ToggleBtn active={showReflect} onClick={() => setShowReflect(!showReflect)} icon="🪞" label="Reflect" />
              <ToggleBtn active={showUsage} onClick={() => setShowUsage(!showUsage)} icon="💾" label="Usage" />
              {/* Lurk mode buttons for selected target */}
              {selectedTarget && (() => {
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
                    {socialActive && activeSubagentCount > 0 && (
                      <span className="ml-1 px-2 py-0.5 text-[10px] font-medium rounded-full bg-blue-100 text-blue-700 border border-blue-200 shrink-0"
                        title={`${activeSubagentCount} CC subagent(s) running`}>
                        🤖 {activeSubagentCount}
                      </span>
                    )}
                    {socialActive && <>
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
                    </>}
                  </div>
                );
              })()}
            </div>

            {/* Custom Group Rules — editable per target */}
            {selectedTarget && (
              <CustomGroupRules
                target={selectedTarget}
                value={(config.customGroupRules || {})[selectedTarget] || ''}
                onChange={async (text) => {
                  const updated = { ...(config.customGroupRules || {}), [selectedTarget]: text };
                  // 1. 更新本地 state
                  setConfig(prev => ({ ...prev, customGroupRules: updated }));
                  // 2. 立即持久化到 DB（下次重启会自动加载）
                  if (selectedPetId) {
                    try {
                      const configToSave = { ...config, customGroupRules: updated, petId: selectedPetId };
                      await saveSocialConfig(selectedPetId, configToSave);
                    } catch (e) {
                      console.error('Failed to persist custom rules:', e);
                    }
                  }
                }}
              />
            )}

            {/* Intent Plan — pinned above logs when a target is selected */}
            {selectedTarget && (() => {
              const plan = intentPlans[selectedTarget];
              const actionLabel = (a) => {
                if (a.type === 'sticker') return `📎 sticker#${a.id}`;
                if (a.type === 'image') return `🖼️ ${a.file || 'image'}`;
                if (a.type === 'reply') return `💬 reply${a.numChunks > 1 ? ` ×${a.numChunks}` : ''}${a.replyLen ? ` ~${a.replyLen}字` : ''}`;
                if (a.type === 'intent') return `⏱ intent (${a.delaySeconds ?? 5}s)`;
                return `⏸ wait`;
              };
              if (!plan) return (
                <div className="shrink-0 border-b border-slate-100 bg-slate-50/80 px-3 py-1.5">
                  <span className="text-[9px] font-semibold text-slate-400 uppercase tracking-wide">Plan</span>
                  <span className="text-[9px] text-slate-400 ml-2">等待 Intent 评估…</span>
                </div>
              );
              const doneStickers = plan.done.filter(d => d.type === 'sticker').length;
              const doneReplies = plan.done.filter(d => d.type === 'reply').length;
              const doneImages = plan.done.filter(d => d.type === 'image').length;
              let stickerIdx = 0, replyIdx = 0, imageIdx = 0;
              const isDone = (a) => {
                if (a.type === 'sticker') return stickerIdx++ < doneStickers;
                if (a.type === 'reply') return replyIdx++ < doneReplies;
                if (a.type === 'image') return imageIdx++ < doneImages;
                return false;
              };
              const planHasAction = plan.actions.some(a => a.type === 'sticker' || a.type === 'reply' || a.type === 'image');
              return (
                <div className="shrink-0 border-b border-slate-200 bg-slate-50/80 px-3 py-1.5 space-y-1">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[9px] font-semibold text-slate-400 uppercase tracking-wide shrink-0">Plan</span>
                    {plan.actions
                      .filter(a => !(planHasAction && (a.type === 'wait' || a.type === 'intent')))
                      .map((a, i) => {
                        const done = isDone(a);
                        return (
                          <span key={i} className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${
                            done ? 'text-slate-400 bg-slate-100 border-slate-200 line-through' :
                            a.type === 'wait' || a.type === 'intent' ? 'text-slate-500 bg-white border-slate-200' :
                            'text-cyan-700 bg-cyan-50 border-cyan-200'
                          }`}>
                            {done ? '✓' : '○'} {actionLabel(a)}
                          </span>
                        );
                      })}
                    {/* Running subagent tasks for this target */}
                    {(() => {
                      const targetRunning = [];
                      for (const [tid, e] of subagentRegistry) {
                        if (e.target === selectedTarget && e.status === 'running') {
                          targetRunning.push({ tid, task: e.task, elapsed: Math.round((Date.now() - e.createdAt) / 1000) });
                        }
                      }
                      return targetRunning.map(r => (
                        <span key={r.tid} className="text-[10px] font-mono px-1.5 py-0.5 rounded border text-blue-600 bg-blue-50 border-blue-200 animate-pulse">
                          🤖 {r.task?.substring(0, 30)}{r.task?.length > 30 ? '…' : ''} ({r.elapsed}s)
                        </span>
                      ));
                    })()}
                  </div>
                  {plan.state && (
                    <div className="text-[9px] text-slate-400 font-mono whitespace-pre-wrap">{plan.state}</div>
                  )}
                </div>
              );
            })()}

            <PromptCachePanel logs={usageLogsAfterReset} />

            <TrainingDataCard
              petId={selectedPetId}
              trainingCollectionEnabled={trainingCollectionEnabled}
              trainingTargets={trainingTargets}
              onToggleGlobal={async (v) => {
                setTrainingCollectionEnabled(v);
                await tauri.updateSettings({ trainingCollectionEnabled: v }).catch(() => {});
                emit('social-set-training-collection-enabled', { enabled: v });
              }}
              onOpenFolder={async () => {
                try {
                  await tauri.workspaceOpenSubfolder(selectedPetId, 'social/training/intent');
                } catch (e) {
                  console.error('[TrainingData] open folder failed:', e);
                }
              }}
              onExport={() => setExportModalOpen(true)}
            />

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
                  ) : log.level === 'send' ? (
                    <SendLogEntry key={log.id ?? log.timestamp} log={log} logFilter={logFilter} />
                  ) : log.level === 'llm' ? (
                    <LlmLogEntry key={log.id ?? log.timestamp} log={log} logFilter={logFilter} />
                  ) : log.level === 'subagent' ? (
                    <SubagentLogEntry key={log.id ?? log.timestamp} log={log} logFilter={logFilter} />
                  ) : log.level === 'reflect' ? (
                    <ReflectLogEntry key={log.id ?? log.timestamp} log={log} logFilter={logFilter} />
                  ) : log.level === 'usage' ? (
                    <UsageLogEntry key={log.id ?? log.timestamp} log={log} logFilter={logFilter} />
                  ) : (
                    <div key={log.id ?? log.timestamp} className={`py-0.5 ${
                      log.level === 'error' ? 'text-red-600' :
                      log.level === 'warn' ? 'text-amber-600' :
                      log.level === 'memory' ? 'text-purple-600' :
                      log.level === 'intent' ? 'text-purple-500' :
                      log.level === 'llm' ? 'text-blue-500' :
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

    {/* Export Intent Training Data Modal */}
    {exportModalOpen && (
      <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
        <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
          <h3 className="font-semibold mb-3">Export Intent Training Data</h3>

          <label className="flex items-center gap-2 text-sm mt-2">
            <input
              type="checkbox"
              checked={exportOptions.redact}
              onChange={(e) => setExportOptions({ ...exportOptions, redact: e.target.checked })}
              disabled={exportRunning}
            />
            Redact QQ numbers (recommended)
          </label>
          <label className="flex items-center gap-2 text-sm mt-2">
            <input
              type="checkbox"
              checked={exportOptions.statusSuccessOnly}
              onChange={(e) => setExportOptions({ ...exportOptions, statusSuccessOnly: e.target.checked })}
              disabled={exportRunning}
            />
            Only successful evals
          </label>
          <label className="flex items-center gap-2 text-sm mt-2">
            <input
              type="checkbox"
              checked={exportOptions.terminationStrict}
              onChange={(e) => setExportOptions({ ...exportOptions, terminationStrict: e.target.checked })}
              disabled={exportRunning}
            />
            Only evals that reached write_intent_plan
          </label>

          {exportRunning && (
            <div className="mt-3 text-xs text-gray-500">Running export…</div>
          )}

          {exportResult && (
            <pre className="mt-3 text-xs bg-gray-100 p-2 rounded overflow-auto max-h-40 whitespace-pre-wrap">
              {exportResult.success ? '✓ Success' : '✗ Failed'}
              {exportResult.outputPath && `\nOutput: ${exportResult.outputPath}`}
              {exportResult.stdout && `\n\n${exportResult.stdout}`}
              {exportResult.stderr && `\n\nErrors:\n${exportResult.stderr}`}
            </pre>
          )}

          <div className="flex gap-2 mt-4">
            <button
              onClick={runExport}
              disabled={exportRunning}
              className="px-3 py-1 bg-blue-500 text-white rounded text-sm disabled:opacity-50"
            >
              {exportRunning ? 'Running…' : 'Run'}
            </button>
            <button
              onClick={() => { setExportModalOpen(false); setExportResult(null); }}
              disabled={exportRunning}
              className="px-3 py-1 border rounded text-sm"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}

// ==================== Helper Components ====================

/** Render tool call details — parse JSON and show content fields as readable text */
function ToolDetailsBlock({ details }) {
  let parsed = null;
  if (typeof details === 'string') {
    try { parsed = JSON.parse(details); } catch { /* raw text */ }
  } else if (typeof details === 'object') {
    parsed = details;
  }

  if (parsed && typeof parsed === 'object') {
    // Show each field: render 'content'/'newText'/'old_text'/'new_text' as readable text, others as labels
    const textKeys = ['content', 'newText', 'new_text', 'oldText', 'old_text', 'text', 'query'];
    const entries = Object.entries(parsed);
    return (
      <div className="text-purple-400 text-[10px] space-y-1">
        {entries.map(([key, val]) => {
          if (textKeys.includes(key) && typeof val === 'string') {
            return (
              <div key={key}>
                <span className="text-purple-300 font-semibold">{key}:</span>
                <div className="ml-2 whitespace-pre-wrap break-words text-slate-500">{val}</div>
              </div>
            );
          }
          const display = typeof val === 'string' ? val : JSON.stringify(val);
          return (
            <div key={key} className="truncate">
              <span className="text-purple-300 font-semibold">{key}:</span>{' '}
              <span className="text-slate-500">{display}</span>
            </div>
          );
        })}
      </div>
    );
  }

  // Fallback: raw text
  return (
    <div className="text-purple-400 whitespace-pre-wrap break-words text-[10px]">
      {typeof details === 'string' ? details : JSON.stringify(details, null, 2)}
    </div>
  );
}

function IntentLogEntry({ log, logFilter }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetails = !!log.details;

  // Try to parse plan data from details
  let plan = null;
  if (hasDetails && typeof log.details === 'string') {
    try {
      const parsed = JSON.parse(log.details);
      if (parsed && (parsed.actions || parsed.state)) plan = parsed;
    } catch { /* raw text */ }
  }

  const hasStateToShow = plan?.state && !plan?.actions?.every(a => a.type === 'sticker');

  const actionLabel = (a) => {
    if (a.type === 'sticker') return `📎 sticker#${a.id}`;
    if (a.type === 'image') return `🖼️ ${a.file || 'image'}`;
    if (a.type === 'reply') return `💬 reply${a.numChunks > 1 ? ` ×${a.numChunks}` : ''}${a.replyLen ? ` ~${a.replyLen}字` : ''}`;
    if (a.type === 'intent') return `⏱ intent (${a.delaySeconds ?? 5}s)`;
    return `⏸ wait`;
  };

  const hasAction = plan?.actions?.some(a => a.type === 'sticker' || a.type === 'reply');

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
      {/* Running subagent indicator for this target */}
      {log.target && (() => {
        let count = 0;
        const tasks = [];
        for (const [, e] of subagentRegistry) {
          if (e.target === log.target && e.status === 'running') {
            count++;
            tasks.push(e.task?.substring(0, 20));
          }
        }
        if (count === 0) return null;
        return (
          <span className="ml-1.5 text-[9px] text-blue-500 bg-blue-50 px-1.5 py-0.5 rounded border border-blue-200" title={tasks.join(', ')}>
            🤖 {count} task{count > 1 ? 's' : ''} running
          </span>
        );
      })()}
      {hasDetails && (
        <button
          onClick={() => setExpanded(v => !v)}
          className="ml-1.5 text-purple-400 hover:text-purple-300 transition-colors"
        >
          {expanded ? '▾' : '▸'}
        </button>
      )}
      {hasDetails && expanded && (
        <div className="mt-1 ml-4 pl-2 border-l-2 border-purple-300/40 space-y-1">
          {plan ? (
            <>
              {plan.actions && plan.actions.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {plan.actions
                    .filter(a => !(hasAction && a.type === 'wait'))
                    .map((a, i) => (
                      <span key={i} className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${
                        a.type === 'wait'
                          ? 'text-slate-500 bg-white border-slate-200'
                          : 'text-cyan-700 bg-cyan-50 border-cyan-200'
                      }`}>
                        {actionLabel(a)}
                      </span>
                    ))}
                </div>
              )}
              {hasStateToShow && (
                <div className="text-[9px] text-purple-400 font-mono whitespace-pre-wrap break-words">
                  {plan.state}
                </div>
              )}
            </>
          ) : (
            <ToolDetailsBlock details={log.details} />
          )}
        </div>
      )}
    </div>
  );
}

function UsageLogEntry({ log, logFilter }) {
  return (
    <div className="py-0.5 text-slate-600">
      <span className="text-slate-400">{new Date(log.timestamp).toLocaleTimeString()}</span>
      {' '}
      <span className="font-semibold text-emerald-600">[usage]</span>
      {log.target && logFilter === 'all' && (
        <span className="text-cyan-500 ml-1">[{log.target}]</span>
      )}
      {' '}
      <span className="font-mono">{log.message}</span>
    </div>
  );
}

function PromptCachePanel({ logs }) {
  const stats = useMemo(() => {
    const map = new Map();
    for (const log of logs) {
      if (log.level !== 'usage' || !log.details) continue;
      const d = log.details;
      const label = d.label;
      if (!label) continue;
      const cur = map.get(label) || { label, calls: 0, totalIn: 0, totalCached: 0, totalOut: 0 };
      cur.calls += 1;
      cur.totalIn += d.inputTokens || 0;
      cur.totalCached += d.cachedTokens || 0;
      cur.totalOut += d.outputTokens || 0;
      map.set(label, cur);
    }
    return Array.from(map.values()).sort((a, b) => b.calls - a.calls);
  }, [logs]);

  if (stats.length === 0) return null;
  return (
    <div className="border-b border-slate-100 px-3 py-1.5 bg-slate-50/50 text-xs font-mono">
      <div className="font-semibold text-slate-700 mb-1">Prompt Cache（本次会话）</div>
      <table className="w-full">
        <tbody>
          {stats.map(s => {
            const rate = s.totalIn > 0
              ? Math.min(100, Math.round((s.totalCached / s.totalIn) * 100)) + '%'
              : '—';
            const inK = s.totalIn >= 1000 ? Math.round(s.totalIn / 1000) + 'k' : String(s.totalIn);
            return (
              <tr key={s.label}>
                <td className="pr-3">{s.label}</td>
                <td className="pr-3 text-slate-500">{s.calls} calls</td>
                <td className="pr-3 text-slate-500">{inK} in</td>
                <td className="text-emerald-600">{rate} cached</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function useTrainingStats(petId, globalEnabled) {
  const [stats, setStats] = useState({ count: 0, bytes: 0 });

  useEffect(() => {
    if (!globalEnabled || !petId) return;
    const date = new Date().toISOString().slice(0, 10);
    const path = `social/training/intent/${date}.jsonl`;
    tauri.workspaceRead(petId, path).then(text => {
      if (!text) return;
      const lines = text.split('\n').filter(Boolean);
      setStats({ count: lines.length, bytes: new Blob([text]).size });
    }).catch(() => { /* file not yet created */ });
  }, [petId, globalEnabled]);

  return stats;
}

function TrainingDataCard({ petId, trainingCollectionEnabled, trainingTargets, onToggleGlobal, onOpenFolder, onExport }) {
  const enabledTargets = Object.entries(trainingTargets || {})
    .filter(([, v]) => v)
    .map(([id]) => id);

  const stats = useTrainingStats(petId, trainingCollectionEnabled);

  return (
    <div className="border-b border-slate-100 px-3 py-1.5 bg-slate-50/50 text-xs font-mono">
      <div className="font-semibold text-slate-700 mb-1">Training Data Collection</div>

      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={trainingCollectionEnabled}
          onChange={(e) => onToggleGlobal(e.target.checked)}
        />
        <span>Enable collection (global)</span>
      </label>

      <div className="text-slate-400 mt-1">
        Only targets marked below are collected. Raw data — redact at export time.
      </div>

      {trainingCollectionEnabled && (
        <>
          <div className="mt-2">
            <div className="font-medium text-slate-700">Enabled targets ({enabledTargets.length}):</div>
            {enabledTargets.length === 0 ? (
              <div className="text-slate-400 mt-0.5">None — toggle on a target card.</div>
            ) : (
              <ul className="text-slate-600 mt-0.5 space-y-0.5">
                {enabledTargets.map(id => (<li key={id}>· {id}</li>))}
              </ul>
            )}
          </div>

          <div className="text-xs text-gray-500 mt-2">
            Today: {stats.count} traces · {(stats.bytes / 1024).toFixed(1)} KB
          </div>

          <div className="mt-2 flex gap-2">
            <button
              onClick={onOpenFolder}
              className="px-2 py-0.5 rounded border border-slate-300 hover:bg-slate-100"
            >
              Open folder
            </button>
            <button
              onClick={onExport}
              className="px-2 py-0.5 rounded border border-slate-300 hover:bg-slate-100"
            >
              Export for Qwen
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function SendLogEntry({ log, logFilter }) {
  return (
    <div className="py-0.5 text-teal-600">
      <span className="text-slate-400">{new Date(log.timestamp).toLocaleTimeString()}</span>
      {' '}
      <span className="font-semibold">[send]</span>
      {log.target && logFilter === 'all' && (
        <span className="text-cyan-500 ml-1">[{log.target}]</span>
      )}
      {' '}
      {log.message}
    </div>
  );
}

function LlmLogEntry({ log, logFilter }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetails = !!log.details;
  return (
    <div className="py-0.5 text-blue-500">
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
          className="ml-1.5 text-blue-400 hover:text-blue-300 transition-colors"
        >
          {expanded ? '▾' : '▸'}
        </button>
      )}
      {hasDetails && expanded && (
        <div className="mt-0.5 ml-4 pl-2 border-l-2 border-blue-300/40 text-blue-400 whitespace-pre-wrap break-words">
          {typeof log.details === 'string' ? log.details : JSON.stringify(log.details, null, 2)}
        </div>
      )}
    </div>
  );
}

function CustomGroupRules({ target, value, onChange }) {
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState(value || '');
  const [showConfirm, setShowConfirm] = useState(false);
  const hasContent = value && value.trim();
  const isDirty = draft !== (value || '');

  // Sync draft when value changes externally (e.g. switching target)
  useEffect(() => { setDraft(value || ''); }, [value]);

  const handleApply = () => {
    setShowConfirm(true);
  };

  const confirmApply = () => {
    onChange(draft);
    // 通知运行中的 agent 热更新（立即生效）
    emit('social-set-custom-rule', { target, rules: draft });
    setShowConfirm(false);
  };

  return (
    <div className="shrink-0 border-b border-slate-100 bg-amber-50/30 px-3 py-1">
      <div
        className="flex items-center gap-1 cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="text-[9px] font-semibold text-amber-600 uppercase tracking-wide">⚠️ Custom Rules</span>
        {hasContent && !expanded && (
          <span className="text-[9px] text-amber-500 ml-1 truncate max-w-[300px]">{value.trim().split('\n')[0]}</span>
        )}
        <span className="text-slate-300 ml-auto text-[10px]">{expanded ? '▾' : '▸'}</span>
      </div>
      {expanded && (
        <div className="mt-1">
          <textarea
            className="w-full p-2 text-xs font-mono rounded border border-amber-200 bg-white resize-y min-h-[60px] max-h-[200px] focus:outline-none focus:ring-1 focus:ring-amber-300"
            placeholder="输入该群的自定义规则（最高优先级，bot 必须遵守）&#10;例如：不要主动提起政治话题&#10;对群主要尊敬"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="flex items-center gap-2 mt-1 mb-0.5">
            {isDirty && (
              <span className="text-[9px] text-amber-500">未保存的修改</span>
            )}
            <button
              onClick={handleApply}
              disabled={!isDirty}
              className={`ml-auto px-3 py-0.5 text-[10px] font-medium rounded border transition-colors ${
                isDirty
                  ? 'bg-amber-500 text-white border-amber-500 hover:bg-amber-600'
                  : 'bg-slate-100 text-slate-400 border-slate-200 cursor-not-allowed'
              }`}
            >
              应用规则
            </button>
          </div>
        </div>
      )}
      {/* 确认弹窗 */}
      {showConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="bg-white rounded-lg shadow-xl p-4 max-w-md w-full mx-4">
            <div className="text-sm font-semibold text-slate-800 mb-2">⚠️ 确认应用自定义规则</div>
            <div className="text-xs text-slate-600 mb-3">以下规则将立即注入到下一轮 Intent 评估中，优先级最高：</div>
            <div className="p-2 rounded bg-amber-50 border border-amber-200 text-xs font-mono whitespace-pre-wrap max-h-[200px] overflow-y-auto mb-3">
              {draft.trim() || '（空，将清除所有自定义规则）'}
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowConfirm(false)}
                className="px-3 py-1 text-xs rounded border border-slate-300 text-slate-600 hover:bg-slate-50"
              >
                取消
              </button>
              <button
                onClick={confirmApply}
                className="px-3 py-1 text-xs rounded bg-amber-500 text-white hover:bg-amber-600"
              >
                确认应用
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ReflectLogEntry({ log, logFilter }) {
  const [expanded, setExpanded] = useState(false);
  const ts = new Date(log.timestamp).toLocaleTimeString();

  let details = {};
  try { details = typeof log.details === 'string' ? JSON.parse(log.details) : (log.details || {}); } catch { details = {}; }

  const statusColor = details.status === 'failed' ? 'text-red-500'
    : details.status === 'dispatched' ? 'text-blue-500'
    : 'text-teal-600';

  return (
    <div className="py-0.5">
      <div
        className={`flex items-start gap-1 cursor-pointer hover:bg-slate-50 rounded px-1 -mx-1 ${statusColor}`}
        onClick={() => setExpanded(!expanded)}
      >
        <span className="text-slate-400 shrink-0 tabular-nums">{ts}</span>
        <span className="text-teal-500 shrink-0">[reflect]</span>
        {log.target && logFilter === 'all' && (
          <span className="text-slate-300 shrink-0">[{log.target}]</span>
        )}
        <span className="font-medium">🪞</span>
        <span className="flex-1 break-words">{log.message}</span>
        <span className="text-slate-300 shrink-0">{expanded ? '▾' : '▸'}</span>
      </div>
      {expanded && details && (
        <div className="ml-16 mt-0.5 p-2 rounded bg-teal-50 border border-teal-200 text-[10px] space-y-2">
          {details.elapsed != null && (
            <div><span className="text-teal-600 font-semibold">耗时: </span><span className="text-slate-600">{details.elapsed}s</span></div>
          )}
          {details.replyCount != null && (
            <div><span className="text-teal-600 font-semibold">Review 轮数: </span><span className="text-slate-600">{details.replyCount}</span></div>
          )}
          {details.lessons && (
            <div>
              <div className="text-teal-600 font-semibold mb-1">📋 Lessons 变化:</div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="text-slate-400 text-[9px] mb-0.5">Before:</div>
                  <div className="p-1.5 rounded bg-white border border-teal-100 whitespace-pre-wrap text-slate-500 max-h-40 overflow-y-auto">{details.lessons.before}</div>
                </div>
                <div>
                  <div className="text-slate-400 text-[9px] mb-0.5">After:</div>
                  <div className="p-1.5 rounded bg-white border border-teal-100 whitespace-pre-wrap text-slate-600 max-h-40 overflow-y-auto">{details.lessons.after}</div>
                </div>
              </div>
            </div>
          )}
          {details.principles && (
            <div>
              <div className="text-teal-600 font-semibold mb-1">⭐ Principles 变化:</div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="text-slate-400 text-[9px] mb-0.5">Before:</div>
                  <div className="p-1.5 rounded bg-white border border-teal-100 whitespace-pre-wrap text-slate-500 max-h-40 overflow-y-auto">{details.principles.before}</div>
                </div>
                <div>
                  <div className="text-slate-400 text-[9px] mb-0.5">After:</div>
                  <div className="p-1.5 rounded bg-white border border-teal-100 whitespace-pre-wrap text-slate-600 max-h-40 overflow-y-auto">{details.principles.after}</div>
                </div>
              </div>
            </div>
          )}
          {details.error && (
            <div className="text-red-500"><span className="font-semibold">错误: </span>{details.error}</div>
          )}
        </div>
      )}
    </div>
  );
}

function SubagentLogEntry({ log, logFilter }) {
  const [expanded, setExpanded] = useState(false);
  const ts = new Date(log.timestamp).toLocaleTimeString();

  let details = {};
  try { details = typeof log.details === 'string' ? JSON.parse(log.details) : (log.details || {}); } catch { details = {}; }

  const statusColor = details.status === 'timeout' ? 'text-amber-500'
    : details.status === 'failed' ? 'text-red-500'
    : details.status === 'dispatched' ? 'text-blue-500'
    : 'text-emerald-500';

  return (
    <div className="py-0.5">
      <div
        className={`flex items-start gap-1 cursor-pointer hover:bg-slate-50 rounded px-1 -mx-1 ${statusColor}`}
        onClick={() => setExpanded(!expanded)}
      >
        <span className="text-slate-400 shrink-0 tabular-nums">{ts}</span>
        <span className="text-slate-400 shrink-0">[subagent]</span>
        {log.target && logFilter === 'all' && (
          <span className="text-slate-300 shrink-0">[{log.target}]</span>
        )}
        <span className="font-medium">🤖</span>
        <span className="flex-1 break-words">{log.message}</span>
        <span className="text-slate-300 shrink-0">{expanded ? '▾' : '▸'}</span>
      </div>
      {expanded && details && (
        <div className="ml-16 mt-0.5 p-2 rounded bg-slate-50 border border-slate-200 text-[10px] space-y-1">
          {details.task && (
            <div><span className="text-slate-400 font-semibold">Task: </span><span className="text-slate-600">{details.task}</span></div>
          )}
          {details.elapsed != null && (
            <div><span className="text-slate-400 font-semibold">耗时: </span><span className="text-slate-600">{details.elapsed}s</span></div>
          )}
          {details.resultLen != null && (
            <div><span className="text-slate-400 font-semibold">结果: </span><span className="text-slate-600">{details.resultLen}字</span></div>
          )}
          {details.resultPreview && (
            <div className="mt-1 p-1.5 rounded bg-white border border-slate-150 whitespace-pre-wrap text-slate-600">{details.resultPreview}</div>
          )}
          {details.error && (
            <div className="text-red-500"><span className="font-semibold">错误: </span>{details.error}</div>
          )}
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

function SidebarItem({ active, onClick, label, count, lurkIcon, onLurkClick, paused, onPauseClick, trainingEnabled, onTrainingClick }) {
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
      {onTrainingClick && (
        <button
          onClick={(e) => { e.stopPropagation(); onTrainingClick(); }}
          className="shrink-0 hover:scale-125 transition-transform text-sm leading-none"
          title={trainingEnabled ? 'Training: ON' : 'Training: OFF'}
        >
          {trainingEnabled ? '📊' : '📋'}
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
