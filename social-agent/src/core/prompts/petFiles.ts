import type { Platform } from '../../platform/index.ts';

/**
 * Pet-level static files (SOUL.md / USER.md / MEMORY.md) + content truncation.
 * Ported from src/utils/promptBuilder.js (Tauri side).
 *
 * Factory takes platform once; returned readers close over it.
 */

export const MAX_FILE_CHARS = 20000;
const HEAD_RATIO = 0.7;
const TAIL_RATIO = 0.2;

/**
 * Truncate over-long file content. Keeps head (70%) + tail (20%) with a
 * marker between, so the LLM sees both opening context and recent edits.
 */
export function truncateContent(content: string | null | undefined, maxChars: number = MAX_FILE_CHARS): string {
  if (!content || content.length <= maxChars) return content ?? '';

  const headLen = Math.floor(maxChars * HEAD_RATIO);
  const tailLen = Math.floor(maxChars * TAIL_RATIO);

  const head = content.slice(0, headLen);
  const tail = content.slice(-tailLen);

  return `${head}\n\n[...内容被截断，完整内容请使用 read 工具查看原文件...]\n（截断：保留了 ${headLen}+${tailLen} 字符，共 ${content.length} 字符）\n\n${tail}`;
}

export interface PetFileReaders {
  readSoul:   (petId: string) => Promise<string | null>;
  readUser:   (petId: string) => Promise<string | null>;
  readMemory: (petId: string) => Promise<string | null>;
}

export function createPetFileReaders(platform: Platform): PetFileReaders {
  const safeRead = async (petId: string, path: string): Promise<string | null> => {
    try {
      const content = await platform.workspace.read(petId, path);
      return content || null;
    } catch {
      return null;
    }
  };

  return {
    readSoul:   (petId: string) => safeRead(petId, 'SOUL.md'),
    readUser:   (petId: string) => safeRead(petId, 'USER.md'),
    readMemory: (petId: string) => safeRead(petId, 'MEMORY.md'),
  };
}
