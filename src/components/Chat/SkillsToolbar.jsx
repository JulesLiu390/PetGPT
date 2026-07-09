import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FaPuzzlePiece, FaSpinner, FaTriangleExclamation } from 'react-icons/fa6';
import { FiCheck, FiRefreshCw } from 'react-icons/fi';
import * as tauri from '../../utils/tauri';
import { listSkills, loadSkillConfig, setSkillEnabled } from '../../utils/skills/index.js';
import { buildSkillsToolbarRows, canToggleToolbarSkill, isSkillsConfigUpdate } from './skillsToolbarModel.js';

const POPOVER_WIDTH = 320;

export default function SkillsToolbar({ petId, variant = 'icon', onEnabledCountChange }) {
  const [isOpen, setIsOpen] = useState(false);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [error, setError] = useState('');
  const [busyIds, setBusyIds] = useState(() => new Set());
  const [position, setPosition] = useState({ left: 8, bottom: 56, width: POPOVER_WIDTH, maxHeight: 320 });
  const buttonRef = useRef(null);
  const popoverRef = useRef(null);
  const requestIdRef = useRef(0);
  const settingsTimerRef = useRef(null);

  const refresh = useCallback(async ({ quiet = false } = {}) => {
    const currentPetId = String(petId || '').trim();
    const requestId = ++requestIdRef.current;
    if (!currentPetId) {
      setRows([]);
      setError('');
      setLoading(false);
      setHasLoaded(true);
      return;
    }

    if (!quiet) setLoading(true);
    setError('');
    try {
      const [skills, config] = await Promise.all([
        listSkills(currentPetId),
        loadSkillConfig(currentPetId),
      ]);
      if (requestId !== requestIdRef.current) return;
      setRows(buildSkillsToolbarRows(skills, config));
    } catch (refreshError) {
      if (requestId !== requestIdRef.current) return;
      setRows([]);
      setError(refreshError?.message || String(refreshError));
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
        setHasLoaded(true);
      }
    }
  }, [petId]);

  // Keep the compact count current when switching assistants.
  useEffect(() => {
    setIsOpen(false);
    setRows([]);
    setBusyIds(new Set());
    setHasLoaded(false);
    refresh();
  }, [petId, refresh]);

  // Always rescan when opening so files added outside PetGPT appear immediately.
  useEffect(() => {
    if (isOpen) refresh();
  }, [isOpen, refresh]);

  // Management and Chat share skills_config_${petId}; react to either window.
  useEffect(() => {
    if (!petId) return undefined;
    const unlisten = tauri.onSettingsUpdated((payload) => {
      if (!isSkillsConfigUpdate(payload, petId)) return;
      if (settingsTimerRef.current) clearTimeout(settingsTimerRef.current);
      settingsTimerRef.current = setTimeout(() => refresh({ quiet: true }), 40);
    });
    return () => {
      if (settingsTimerRef.current) clearTimeout(settingsTimerRef.current);
      if (unlisten) unlisten();
    };
  }, [petId, refresh]);

  const updatePosition = useCallback(() => {
    if (!buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    const width = Math.max(240, Math.min(POPOVER_WIDTH, window.innerWidth - 16));
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    setPosition({
      left,
      bottom: window.innerHeight - rect.top + 8,
      width,
      maxHeight: Math.max(180, rect.top - 24),
    });
  }, []);

  useEffect(() => {
    if (!isOpen) return undefined;
    updatePosition();
    const handlePointerDown = (event) => {
      if (buttonRef.current?.contains(event.target) || popoverRef.current?.contains(event.target)) return;
      setIsOpen(false);
    };
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [isOpen, updatePosition]);

  const enabledCount = useMemo(() => rows.filter(row => row.enabled).length, [rows]);

  useEffect(() => {
    if (hasLoaded) onEnabledCountChange?.(enabledCount);
  }, [enabledCount, hasLoaded, onEnabledCountChange]);

  const handleToggle = async (skill) => {
    if (!petId || !canToggleToolbarSkill(skill) || busyIds.has(skill.id)) return;
    const nextEnabled = !skill.enabled;
    setBusyIds(current => new Set(current).add(skill.id));
    setError('');
    try {
      await setSkillEnabled(petId, skill.id, nextEnabled, skill.scopes);
      setRows(current => current.map(row => row.id === skill.id
        ? { ...row, enabled: nextEnabled }
        : row));
    } catch (toggleError) {
      setError(toggleError?.message || String(toggleError));
    } finally {
      setBusyIds(current => {
        const next = new Set(current);
        next.delete(skill.id);
        return next;
      });
    }
  };

  const popover = isOpen ? createPortal(
    <div
      ref={popoverRef}
      role="dialog"
      aria-label="Chat Skills"
      className="fixed z-[9999] flex flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xl"
      style={{
        left: `${position.left}px`,
        bottom: `${position.bottom}px`,
        width: `${position.width}px`,
        maxHeight: `${position.maxHeight}px`,
      }}
    >
      <div className="flex shrink-0 items-center justify-between border-b border-gray-100 px-3 py-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-gray-700">Skills</div>
          <div className="text-[10px] text-gray-400">{enabledCount} enabled · {rows.length} available</div>
        </div>
        <button
          type="button"
          onClick={() => refresh()}
          disabled={loading}
          className="rounded-md p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 disabled:opacity-50"
          title="Refresh Skills"
        >
          <FiRefreshCw className={loading ? 'animate-spin' : ''} size={14} />
        </button>
      </div>

      {error && (
        <div className="shrink-0 border-b border-red-100 bg-red-50 px-3 py-2 text-[11px] text-red-600">
          {error}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {loading && rows.length === 0 ? (
          <div className="flex items-center justify-center gap-2 px-3 py-6 text-xs text-gray-400">
            <FaSpinner className="animate-spin" /> Loading Skills…
          </div>
        ) : rows.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-gray-400">
            No Skills available for this assistant.
          </div>
        ) : rows.map(skill => {
          const busy = busyIds.has(skill.id);
          return (
            <button
              key={skill.id}
              type="button"
              role="switch"
              aria-checked={skill.enabled}
              disabled={!canToggleToolbarSkill(skill) || busy}
              onClick={() => handleToggle(skill)}
              className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
              title={!skill.valid ? skill.validationErrors.join('\n') : skill.description}
            >
              <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${skill.enabled ? 'bg-violet-100 text-violet-600' : 'bg-gray-100 text-gray-400'}`}>
                {busy
                  ? <FaSpinner className="animate-spin" size={12} />
                  : skill.valid
                    ? <FaPuzzlePiece size={13} />
                    : <FaTriangleExclamation size={13} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-xs font-medium text-gray-700">{skill.name}</span>
                  <span className={`shrink-0 rounded px-1 py-0.5 text-[8px] font-semibold uppercase ${skill.source === 'global' ? 'bg-blue-50 text-blue-500' : 'bg-amber-50 text-amber-600'}`}>
                    {skill.source === 'global' ? 'Global' : 'Assistant'}
                  </span>
                </span>
                <span className="mt-0.5 block truncate text-[10px] text-gray-400">
                  {skill.valid ? (skill.description || skill.id) : (skill.validationErrors[0] || 'Invalid Skill')}
                </span>
              </span>
              <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${skill.enabled ? 'border-violet-500 bg-violet-500 text-white' : 'border-gray-300 text-transparent'}`}>
                <FiCheck size={12} />
              </span>
            </button>
          );
        })}
      </div>
    </div>,
    document.body,
  ) : null;

  return (
    <div className={variant === 'drawer' ? 'relative min-w-0' : 'relative shrink-0'}>
      <button
        ref={buttonRef}
        type="button"
        disabled={!petId}
        onClick={() => setIsOpen(open => !open)}
        className={variant === 'drawer'
          ? `group flex w-full min-w-0 items-center gap-2.5 rounded-xl border px-3 py-2 text-left transition-all disabled:cursor-not-allowed disabled:opacity-40 ${isOpen || enabledCount > 0
            ? 'border-violet-200 bg-violet-50 text-violet-700'
            : 'border-white/60 bg-white/65 text-slate-600 hover:border-slate-200 hover:bg-white'
          }`
          : `relative flex h-8 w-8 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${isOpen || enabledCount > 0 ? 'bg-violet-100 text-violet-600' : 'text-gray-500 hover:bg-gray-300/50'}`}
        title={petId ? `Skills (${enabledCount} enabled)` : 'Select an assistant to use Skills'}
        aria-label={`Skills (${enabledCount} enabled)`}
        aria-expanded={isOpen}
      >
        <span className={variant === 'drawer'
          ? `flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${enabledCount > 0 ? 'bg-violet-100 text-violet-600' : 'bg-slate-100 text-slate-500 group-hover:bg-slate-200'}`
          : ''}
        >
          <FaPuzzlePiece className="h-4 w-4" />
        </span>
        {variant === 'drawer' && (
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-semibold">Skills</span>
            <span className="block truncate text-[10px] text-slate-400">Reusable workflows</span>
          </span>
        )}
        {variant === 'drawer' ? (
          <span className="shrink-0 rounded-full bg-violet-100 px-1.5 py-0.5 text-[9px] font-semibold text-violet-600">
            {enabledCount}
          </span>
        ) : enabledCount > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full border border-white bg-violet-500 px-1 text-[9px] font-bold leading-none text-white">
            {enabledCount > 99 ? '99+' : enabledCount}
          </span>
        )}
      </button>
      {popover}
    </div>
  );
}
