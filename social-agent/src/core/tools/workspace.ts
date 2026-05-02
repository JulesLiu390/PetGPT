import type { Platform } from '../../platform/index.ts';
import type { ToolDefinition } from '../llm/index.ts';
import type { ToolHandler } from '../llm/tool-loop.ts';

/**
 * Workspace I/O tools — give the LLM the ability to read / write / edit / list
 * files inside a single pet's workspace directory.
 *
 * Path containment is enforced by platform.workspace (rejects ../ traversal).
 *
 * Tool args use camelCase (oldText/newText). Some Tauri-era code shipped
 * snake_case (old_text/new_text); we accept both for compatibility.
 */
export function createWorkspaceTools(platform: Platform, petId: string): {
  definitions: ToolDefinition[];
  handlers: Record<string, ToolHandler>;
} {
  const ws = platform.workspace;

  const handlers: Record<string, ToolHandler> = {
    async social_read(args: any) {
      const path = pickPath(args);
      if (!path) return errResult('path is required');
      try {
        if (!(await ws.exists(petId, path))) return errResult(`file not found: ${path}`);
        const text = await ws.read(petId, path);
        return { content: text };
      } catch (e: any) {
        return errResult(e?.message ?? String(e));
      }
    },

    async social_write(args: any) {
      const path = pickPath(args);
      const content = String(args?.content ?? '');
      if (!path) return errResult('path is required');
      try {
        await ws.write(petId, path, content);
        return { content: `wrote ${content.length} chars → ${path}` };
      } catch (e: any) {
        return errResult(e?.message ?? String(e));
      }
    },

    async social_edit(args: any) {
      const path    = pickPath(args);
      const oldText = String(args?.oldText ?? args?.old_text ?? '');
      const newText = String(args?.newText ?? args?.new_text ?? '');
      if (!path) return errResult('path is required');
      if (!oldText) return errResult('oldText is required (the text to replace)');

      try {
        if (!(await ws.exists(petId, path))) return errResult(`file not found: ${path}`);
        const current = await ws.read(petId, path);
        const occurrences = countOccurrences(current, oldText);
        if (occurrences === 0) return errResult(`oldText not found in ${path}`);
        if (occurrences > 1)   return errResult(`oldText appears ${occurrences} times in ${path}; include more surrounding context so the match is unique`);
        const updated = current.replace(oldText, newText);
        await ws.write(petId, path, updated);
        return { content: `edited ${path}: -${oldText.length} +${newText.length} chars (1 replacement)` };
      } catch (e: any) {
        return errResult(e?.message ?? String(e));
      }
    },

    async social_list(args: any) {
      const path = pickPath(args) || '.';
      try {
        if (!(await ws.exists(petId, path))) return errResult(`directory not found: ${path}`);
        const entries = await ws.list(petId, path);
        if (entries.length === 0) return { content: '(empty)' };
        return { content: entries.join('\n') };
      } catch (e: any) {
        return errResult(e?.message ?? String(e));
      }
    },
  };

  const definitions: ToolDefinition[] = [
    {
      name: 'social_read',
      description: 'Read the full contents of a UTF-8 text file in the pet workspace. Returns the file content on success, an error message if the file does not exist.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the pet workspace root. Example: "social/group/INTENT_902317662.md"' },
        },
        required: ['path'],
      },
    },
    {
      name: 'social_write',
      description: 'Overwrite (or create) a UTF-8 text file in the pet workspace. The full content replaces the prior file. Parent directories are created automatically.',
      inputSchema: {
        type: 'object',
        properties: {
          path:    { type: 'string', description: 'Path relative to the pet workspace root.' },
          content: { type: 'string', description: 'Full file content. Will entirely replace existing contents.' },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'social_edit',
      description: 'Replace exactly one occurrence of `oldText` with `newText` inside an existing file. Fails if the old text is not present, or if it appears more than once. For multi-line replacements, include enough surrounding context to make the match unique.',
      inputSchema: {
        type: 'object',
        properties: {
          path:    { type: 'string', description: 'Path relative to the pet workspace root.' },
          oldText: { type: 'string', description: 'Exact text to be replaced. Must occur exactly once in the file.' },
          newText: { type: 'string', description: 'Replacement text.' },
        },
        required: ['path', 'oldText', 'newText'],
      },
    },
    {
      name: 'social_list',
      description: 'List immediate entries (files and subdirectories) of a directory in the pet workspace.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path relative to the pet workspace root. Defaults to "." (workspace root).' },
        },
      },
    },
  ];

  return { definitions, handlers };
}

// ─────────────────── helpers ───────────────────

function pickPath(args: any): string {
  return String(args?.path ?? '').trim();
}

function errResult(msg: string) {
  return { content: `Error: ${msg}`, isError: true };
}

function countOccurrences(text: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = text.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}
