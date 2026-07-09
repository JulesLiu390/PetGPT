import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  FaCheck,
  FaFolderOpen,
  FaPlus,
  FaPuzzlePiece,
  FaSpinner,
  FaTrash,
  FaTriangleExclamation,
} from 'react-icons/fa6';
import { FiRefreshCw } from 'react-icons/fi';
import { Alert, Badge, Button, Card, Input, Textarea } from '../UI/ui';
import * as tauri from '../../utils/tauri';
import {
  createGlobalSkillTemplate,
  deleteGlobalSkill,
  listGlobalSkills,
  openGlobalSkillsFolder,
} from '../../utils/skills/index.js';
import {
  buildSkillRows,
  normalizeSkillNameInput,
  toErrorMessage,
  validateSkillName,
} from './skillsPanelModel.js';

const SkillCard = ({ skill, deleting, onDelete }) => (
  <div className={`rounded-xl border bg-white p-4 shadow-sm ${skill.isValid ? 'border-slate-200' : 'border-rose-200'}`}>
    <div className="flex items-start gap-3">
      <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${skill.isValid ? 'bg-violet-50 text-violet-600' : 'bg-rose-50 text-rose-600'}`}>
        {skill.isValid ? (
          <FaPuzzlePiece className="h-5 w-5" />
        ) : (
          <FaTriangleExclamation className="h-5 w-5" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-slate-900" title={skill.name}>
              {skill.name}
            </div>
            {skill.id !== skill.name && (
              <div className="mt-0.5 truncate font-mono text-[11px] text-slate-400" title={skill.id}>
                {skill.id}
              </div>
            )}
          </div>
          <Button
            type="button"
            variant="danger"
            onClick={() => onDelete(skill)}
            disabled={deleting}
            title={`Delete ${skill.name}`}
            aria-label={`Delete ${skill.name}`}
          >
            {deleting ? <FaSpinner className="h-3.5 w-3.5 animate-spin" /> : <FaTrash className="h-3.5 w-3.5" />}
            Delete
          </Button>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Badge tone="purple">{skill.version ? `v${skill.version}` : 'Unversioned'}</Badge>
          <Badge tone={skill.isValid ? 'green' : 'red'}>
            {skill.isValid ? 'Valid' : 'Needs attention'}
          </Badge>
        </div>

        <p className="mt-2 text-xs leading-relaxed text-slate-600">
          {skill.description}
        </p>

        {skill.path && (
          <div className="mt-2 truncate font-mono text-[10px] text-slate-400" title={skill.path}>
            {skill.path}
          </div>
        )}

        {skill.validationErrors.length > 0 && (
          <Alert tone="red" className="mt-3">
            <div className="font-semibold">Validation errors</div>
            <ul className="mt-1 list-disc space-y-1 pl-4">
              {skill.validationErrors.map(message => <li key={message}>{message}</li>)}
            </ul>
          </Alert>
        )}
      </div>
    </div>
  </div>
);

const SkillsPanel = () => {
  const [skills, setSkills] = useState([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [templateName, setTemplateName] = useState('my-skill');
  const [templateDisplayName, setTemplateDisplayName] = useState('My Skill');
  const [templateDescription, setTemplateDescription] = useState('Describe what this skill does and when it should be used.');
  const [deletingSkillIds, setDeletingSkillIds] = useState(() => new Set());
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const requestIdRef = useRef(0);

  const scanSkills = useCallback(async ({ background = false } = {}) => {
    const requestId = ++requestIdRef.current;
    setError('');
    if (!background) setNotice('');
    if (background) setRefreshing(true);
    else setLoading(true);

    try {
      const descriptors = await listGlobalSkills();
      if (requestId !== requestIdRef.current) return;
      setSkills(buildSkillRows(descriptors, [], { defaultSource: 'global' }));
    } catch (scanError) {
      if (requestId !== requestIdRef.current) return;
      setSkills([]);
      setError(toErrorMessage(scanError, 'Failed to scan the global skills library.'));
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    scanSkills();
  }, [scanSkills]);

  const handleCreateTemplate = async (event) => {
    event.preventDefault();
    const skillId = templateName.trim();
    const nameError = validateSkillName(skillId);
    if (nameError) {
      setError(nameError);
      return;
    }

    setCreating(true);
    setError('');
    setNotice('');
    try {
      const result = await createGlobalSkillTemplate(
        skillId,
        templateDisplayName.trim(),
        templateDescription.trim(),
      );
      setShowCreate(false);
      setTemplateName('my-skill');
      setTemplateDisplayName('My Skill');
      setTemplateDescription('Describe what this skill does and when it should be used.');
      setNotice(result?.message || `Added ${skillId} to the global skills library.`);
      await scanSkills({ background: true });
    } catch (createError) {
      setError(toErrorMessage(createError, 'Failed to create the global skill template.'));
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (skill) => {
    const confirmed = await tauri.confirm(
      `Delete the global skill “${skill.name}” (${skill.id})?\n\nAssistants using it will no longer be able to load it. This cannot be undone.`,
      { title: 'Delete Global Skill', kind: 'warning' },
    );
    if (!confirmed) return;

    setError('');
    setNotice('');
    setDeletingSkillIds(current => new Set(current).add(skill.id));
    try {
      await deleteGlobalSkill(skill.id);
      setNotice(`Deleted ${skill.name} from the global skills library.`);
      await scanSkills({ background: true });
    } catch (deleteError) {
      setError(toErrorMessage(deleteError, `Failed to delete ${skill.name}.`));
    } finally {
      setDeletingSkillIds(current => {
        const next = new Set(current);
        next.delete(skill.id);
        return next;
      });
    }
  };

  const handleOpenFolder = async () => {
    setError('');
    try {
      await openGlobalSkillsFolder();
    } catch (openError) {
      setError(toErrorMessage(openError, 'Failed to open the global skills folder.'));
    }
  };

  return (
    <>
      <div className="border-b border-slate-100 px-4 pb-3 pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-base font-semibold text-slate-800">Global Skills ({skills.length})</div>
            <div className="mt-0.5 text-xs text-slate-500">
              Manage reusable workflows. Enable them separately from each Assistant's edit screen.
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="secondary" onClick={() => scanSkills({ background: true })} disabled={refreshing || loading}>
              <FiRefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            <Button type="button" variant="secondary" onClick={handleOpenFolder}>
              <FaFolderOpen className="h-4 w-4" />
              Open folder
            </Button>
            <Button type="button" variant="primary" onClick={() => setShowCreate(true)} disabled={showCreate}>
              <FaPlus className="h-4 w-4" />
              Add Skill
            </Button>
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 space-y-3 overflow-y-auto px-4 py-3">
        {error && <Alert tone="red">{error}</Alert>}
        {notice && (
          <Alert tone="green">
            <span className="inline-flex items-center gap-2"><FaCheck />{notice}</span>
          </Alert>
        )}

        {showCreate && (
          <Card title="Add global Skill" description="Creates <skill-id>/SKILL.md in the shared global library.">
            <form className="space-y-3" onSubmit={handleCreateTemplate}>
              <div>
                <label htmlFor="skill-template-name" className="mb-1.5 block text-xs font-semibold text-slate-700">
                  Skill ID
                </label>
                <Input
                  id="skill-template-name"
                  value={templateName}
                  onChange={event => setTemplateName(normalizeSkillNameInput(event.target.value))}
                  placeholder="my-skill"
                  autoFocus
                />
                <div className="mt-1.5 text-xs text-slate-500">Lowercase letters, numbers, and hyphens; up to 64 characters.</div>
              </div>
              <div>
                <label htmlFor="skill-template-display-name" className="mb-1.5 block text-xs font-semibold text-slate-700">
                  Display name
                </label>
                <Input
                  id="skill-template-display-name"
                  value={templateDisplayName}
                  onChange={event => setTemplateDisplayName(event.target.value)}
                  placeholder="My Skill"
                />
              </div>
              <div>
                <label htmlFor="skill-template-description" className="mb-1.5 block text-xs font-semibold text-slate-700">
                  Description
                </label>
                <Textarea
                  id="skill-template-description"
                  rows={3}
                  value={templateDescription}
                  onChange={event => setTemplateDescription(event.target.value)}
                  placeholder="What this skill does and when it should be used"
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="secondary" onClick={() => setShowCreate(false)} disabled={creating}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  disabled={creating || !templateName || !templateDisplayName.trim() || !templateDescription.trim()}
                >
                  {creating ? <FaSpinner className="h-4 w-4 animate-spin" /> : <FaPlus className="h-4 w-4" />}
                  Add Skill
                </Button>
              </div>
            </form>
          </Card>
        )}

        {loading ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <FiRefreshCw className="mb-4 h-8 w-8 animate-spin text-slate-300" />
            <div className="text-sm text-slate-400">Scanning global skills...</div>
          </div>
        ) : skills.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-white py-12 text-center">
            <FaPuzzlePiece className="mb-4 h-12 w-12 text-slate-300" />
            <div className="font-medium text-slate-600">No global skills found</div>
            <div className="mt-1 max-w-sm px-6 text-sm text-slate-400">
              Create a template or add a compatible skill folder, then refresh the scan.
            </div>
            <div className="mt-4 flex gap-2">
              <Button type="button" variant="primary" onClick={() => setShowCreate(true)}>
                <FaPlus className="h-4 w-4" />
                Add Skill
              </Button>
              <Button type="button" variant="secondary" onClick={handleOpenFolder}>
                <FaFolderOpen className="h-4 w-4" />
                Open folder
              </Button>
            </div>
          </div>
        ) : (
          skills.map(skill => (
            <SkillCard
              key={skill.id}
              skill={skill}
              deleting={deletingSkillIds.has(skill.id)}
              onDelete={handleDelete}
            />
          ))
        )}
      </div>
    </>
  );
};

export default SkillsPanel;
