import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CAPABILITY_ISLAND_MIN_WIDTH,
  buildActiveCapabilityTags,
  getCapabilityIslandMinWidth,
} from '../capabilityIslandModel.js';

test('computes minimum width from island content only', () => {
  assert.equal(CAPABILITY_ISLAND_MIN_WIDTH, 460);
  assert.equal(getCapabilityIslandMinWidth(280), 460);
  assert.equal(getCapabilityIslandMinWidth(500), 580);
  assert.equal(getCapabilityIslandMinWidth(Number.NaN), 460);
});

test('shows active non-persistent capabilities in the compact status area', () => {
  const tags = buildActiveCapabilityTags({
    enabledMcpServers: new Set(['search', 'files']),
    activeSubagentCount: 1,
  });

  assert.deepEqual(tags.map(tag => tag.id), [
    'mcp:files',
    'mcp:search',
    'subagents',
  ]);
});

test('collapses additional MCP servers into one compact tag', () => {
  const tags = buildActiveCapabilityTags({ enabledMcpServers: ['zeta', 'alpha', 'beta', 'alpha'] });
  assert.deepEqual(tags.map(tag => tag.label), ['alpha', 'beta', '+1 MCP']);
});

test('returns no tags when all optional capabilities are inactive', () => {
  assert.deepEqual(buildActiveCapabilityTags(), []);
});
