const normalizeNames = (value) => {
  const names = value instanceof Set ? [...value] : (Array.isArray(value) ? value : []);
  return [...new Set(names.map(name => String(name || '').trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
};

export const CAPABILITY_ISLAND_MIN_WIDTH = 460;

/**
 * The chat window minimum depends only on the island content and its own fixed
 * gutters. It deliberately excludes centered page whitespace and sidebar width.
 */
export function getCapabilityIslandMinWidth(contentWidth, fixedGutter = 80) {
  const content = Number.isFinite(Number(contentWidth)) ? Math.max(0, Number(contentWidth)) : 0;
  const gutter = Number.isFinite(Number(fixedGutter)) ? Math.max(0, Number(fixedGutter)) : 0;
  return Math.max(CAPABILITY_ISLAND_MIN_WIDTH, Math.ceil(content + gutter));
}

/** Build the compact, always-visible tags for capabilities active in this chat. */
export function buildActiveCapabilityTags({
  enabledMcpServers = [],
  activeSubagentCount = 0,
} = {}) {
  const tags = [];
  const mcpNames = normalizeNames(enabledMcpServers);
  for (const name of mcpNames.slice(0, 2)) {
    tags.push({ id: `mcp:${name}`, label: name, tone: 'blue', title: `MCP server enabled: ${name}` });
  }
  if (mcpNames.length > 2) {
    tags.push({
      id: 'mcp:more',
      label: `+${mcpNames.length - 2} MCP`,
      tone: 'blue',
      title: `${mcpNames.length - 2} more MCP servers enabled`,
    });
  }
  if (activeSubagentCount > 0) {
    tags.push({
      id: 'subagents',
      label: `CC ${activeSubagentCount}`,
      tone: 'emerald',
      title: `${activeSubagentCount} CC subagent${activeSubagentCount === 1 ? '' : 's'} running`,
    });
  }
  return tags;
}
