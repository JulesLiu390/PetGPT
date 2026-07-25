/**
 * 给“模型可见”的工具结果追加运行时注释。
 * 日志/UI 仍可继续使用原始 formattedResult，避免把运行时账本混进展示内容。
 */
export function appendToolResultAnnotation(formattedResult, annotation) {
  const base = typeof formattedResult === 'string'
    ? formattedResult
    : JSON.stringify(formattedResult);
  const note = typeof annotation === 'string' ? annotation.trim() : '';
  if (!note) return base;
  return base ? `${base}\n\n${note}` : note;
}
