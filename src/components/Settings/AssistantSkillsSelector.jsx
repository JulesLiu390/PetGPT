import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FaPuzzlePiece, FaSpinner, FaTriangleExclamation } from 'react-icons/fa6';
import { FiRefreshCw } from 'react-icons/fi';
import { Alert, Badge, Button } from '../UI/ui';
import * as tauri from '../../utils/tauri';
import {
  listSkills,
  loadSkillConfig,
  setSkillEnabled,
} from '../../utils/skills/index.js';
import {
  buildSkillRows,
  isAssistantSkillConfigUpdate,
  summarizeSkillRows,
  toErrorMessage,
} from './skillsPanelModel.js';

const SelectorToggle = ({ checked, busy, disabled, name, onChange }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={`${checked ? 'Disable' : 'Enable'} ${name}`}
    disabled={busy || disabled}
    onClick={() => onChange(!checked)}
    className="inline-flex shrink-0 items-center gap-2 rounded-xl px-2 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
  >
    {busy ? (
      <FaSpinner className="h-4 w-4 animate-spin text-slate-400" />
    ) : (
      <span
        aria-hidden="true"
        className={`relative h-5 w-9 rounded-full transition-colors ${checked ? 'bg-emerald-500' : 'bg-slate-300'}`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${checked ? 'translate-x-[18px]' : 'translate-x-0.5'}`}
        />
      </span>
    )}
    {checked ? 'Enabled' : 'Disabled'}
  </button>
);

const AssistantSkillsSelector = ({ petId }) => {
  const [skills, setSkills] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busySkillIds, setBusySkillIds] = useState(() => new Set());
  const [error, setError] = useState('');
  const requestIdRef = useRef(0);
  const settingsTimerRef = useRef(null);
  const summary = useMemo(() => summarizeSkillRows(skills), [skills]);

  const loadSkills = useCallback(async ({ background = false, quiet = false } = {}) => {
    if (!petId) return;
    const requestId = ++requestIdRef.current;
    if (!quiet) setError('');
    if (background && !quiet) setRefreshing(true);
    else if (!quiet) setLoading(true);

    try {
      const [descriptors, config] = await Promise.all([
        listSkills(petId),
        loadSkillConfig(petId),
      ]);
      if (requestId !== requestIdRef.current) return;
      setSkills(buildSkillRows(descriptors, config?.enabledSkillIds));
    } catch (loadError) {
      if (requestId !== requestIdRef.current) return;
      if (!quiet) {
        setSkills([]);
        setError(toErrorMessage(loadError, 'Failed to load Skills for this Assistant.'));
      }
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [petId]);

  useEffect(() => {
    loadSkills();
  }, [loadSkills]);

  useEffect(() => {
    if (!petId) return undefined;
    const unlisten = tauri.onSettingsUpdated((payload) => {
      if (!isAssistantSkillConfigUpdate(payload, petId)) return;
      if (settingsTimerRef.current) clearTimeout(settingsTimerRef.current);
      settingsTimerRef.current = setTimeout(() => loadSkills({ quiet: true }), 40);
    });
    return () => {
      if (settingsTimerRef.current) clearTimeout(settingsTimerRef.current);
      settingsTimerRef.current = null;
      if (unlisten) unlisten();
    };
  }, [petId, loadSkills]);

  const handleToggle = async (skill, enabled) => {
    setError('');
    setBusySkillIds(current => new Set(current).add(skill.id));
    try {
      await setSkillEnabled(petId, skill.id, enabled, skill.scopes);
      setSkills(current => current.map(item => item.id === skill.id ? { ...item, enabled } : item));
    } catch (toggleError) {
      setError(toErrorMessage(toggleError, `Failed to ${enabled ? 'enable' : 'disable'} ${skill.name}.`));
    } finally {
      setBusySkillIds(current => {
        const next = new Set(current);
        next.delete(skill.id);
        return next;
      });
    }
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium text-slate-700">
            <FaPuzzlePiece className="h-4 w-4 text-violet-500" />
            Skills
          </div>
          <div className="mt-1 text-xs text-slate-500">
            {summary.enabled} of {summary.total} enabled. Changes are saved immediately.
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          onClick={() => loadSkills({ background: true })}
          disabled={loading || refreshing}
          title="Refresh Skills"
        >
          <FiRefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {error && <Alert tone="red" className="mt-3">{error}</Alert>}

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-6 text-xs text-slate-400">
          <FaSpinner className="h-4 w-4 animate-spin" />
          Loading Skills...
        </div>
      ) : skills.length === 0 ? (
        <div className="mt-3 rounded-xl border border-dashed border-slate-200 bg-white px-4 py-5 text-center text-xs text-slate-500">
          No Skills are available. Add one from the global Skills page first.
        </div>
      ) : (
        <div className="mt-3 max-h-64 divide-y divide-slate-100 overflow-y-auto rounded-xl border border-slate-200 bg-white">
          {skills.map(skill => (
            <div
              key={skill.id}
              className={`flex items-center gap-2.5 px-3 py-2 ${skill.isValid ? '' : 'bg-rose-50/50'}`}
            >
              <div className={`shrink-0 ${skill.isValid ? 'text-violet-500' : 'text-rose-500'}`}>
                {skill.isValid
                  ? <FaPuzzlePiece className="h-4 w-4" />
                  : <FaTriangleExclamation className="h-4 w-4" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <div className="truncate text-xs font-semibold text-slate-800" title={skill.name}>{skill.name}</div>
                  <Badge tone={skill.sourceLabel === 'Global' ? 'green' : 'purple'}>{skill.sourceLabel}</Badge>
                </div>
                {!skill.isValid && (
                  <div className="mt-0.5 truncate text-[10px] text-rose-600" title={skill.validationErrors.join(' · ')}>
                    {skill.validationErrors[0] || 'Invalid Skill'}
                  </div>
                )}
              </div>
              <SelectorToggle
                checked={skill.enabled}
                busy={busySkillIds.has(skill.id)}
                disabled={!skill.isValid && !skill.enabled}
                name={skill.name}
                onChange={enabled => handleToggle(skill, enabled)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default AssistantSkillsSelector;
