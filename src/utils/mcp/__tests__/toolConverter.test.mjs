import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSchemaForGeminiCompat, convertToOpenAITools, convertToGeminiTools } from '../toolConverter.js';

test('pass-through for simple schemas', () => {
  const s = { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] };
  assert.deepEqual(sanitizeSchemaForGeminiCompat(s), s);
});

test('anyOf [string-enum, null] → flatten with nullable', () => {
  const out = sanitizeSchemaForGeminiCompat({
    type: 'object',
    properties: {
      time_range: {
        anyOf: [{ enum: ['day', 'week'], type: 'string' }, { type: 'null' }],
        default: null,
        description: 'time window'
      }
    }
  });
  assert.deepEqual(out.properties.time_range, {
    type: 'string',
    enum: ['day', 'week'],
    nullable: true,
    default: null,
    description: 'time window'
  });
});

test('anyOf [boolean, null] → flatten', () => {
  const out = sanitizeSchemaForGeminiCompat({
    type: 'object',
    properties: {
      exact_match: { anyOf: [{ type: 'boolean' }, { type: 'null' }] }
    }
  });
  assert.deepEqual(out.properties.exact_match, { type: 'boolean', nullable: true });
});

test('anyOf with null first → still flatten', () => {
  const out = sanitizeSchemaForGeminiCompat({
    type: 'object',
    properties: {
      x: { anyOf: [{ type: 'null' }, { type: 'integer' }] }
    }
  });
  assert.equal(out.properties.x.type, 'integer');
  assert.equal(out.properties.x.nullable, true);
});

test('anyOf [X, Y] without null → pick first branch, warn', () => {
  const origWarn = console.warn;
  let warned = false;
  console.warn = () => { warned = true; };
  try {
    const out = sanitizeSchemaForGeminiCompat({
      type: 'object',
      properties: { u: { anyOf: [{ type: 'integer' }, { type: 'string' }] } }
    });
    assert.equal(out.properties.u.type, 'integer');
    assert.equal(warned, true);
  } finally { console.warn = origWarn; }
});

test('oneOf and allOf treated same as anyOf', () => {
  const outOne = sanitizeSchemaForGeminiCompat({
    type: 'object',
    properties: { x: { oneOf: [{ type: 'string' }, { type: 'null' }] } }
  });
  assert.equal(outOne.properties.x.type, 'string');
  assert.equal(outOne.properties.x.nullable, true);

  const outAll = sanitizeSchemaForGeminiCompat({
    type: 'object',
    properties: { x: { allOf: [{ type: 'string' }, { type: 'null' }] } }
  });
  assert.equal(outAll.properties.x.type, 'string');
});

test('nested object properties recursed', () => {
  const out = sanitizeSchemaForGeminiCompat({
    type: 'object',
    properties: {
      nested: {
        type: 'object',
        properties: {
          opt_int: { anyOf: [{ type: 'integer' }, { type: 'null' }] }
        }
      }
    }
  });
  assert.deepEqual(out.properties.nested.properties.opt_int, {
    type: 'integer',
    nullable: true
  });
});

test('array items recursed', () => {
  const out = sanitizeSchemaForGeminiCompat({
    type: 'object',
    properties: {
      tags: {
        type: 'array',
        items: { anyOf: [{ type: 'string' }, { type: 'null' }] }
      }
    }
  });
  assert.deepEqual(out.properties.tags.items, { type: 'string', nullable: true });
});

test('does not mutate input', () => {
  const input = {
    type: 'object',
    properties: { x: { anyOf: [{ type: 'string' }, { type: 'null' }] } }
  };
  const before = JSON.stringify(input);
  sanitizeSchemaForGeminiCompat(input);
  assert.equal(JSON.stringify(input), before);
});

test('null-ish inputs passed through', () => {
  assert.equal(sanitizeSchemaForGeminiCompat(null), null);
  assert.equal(sanitizeSchemaForGeminiCompat(undefined), undefined);
});

test('convertToOpenAITools applies sanitizer', () => {
  const tools = [{
    name: 'search',
    description: 'search',
    inputSchema: {
      type: 'object',
      properties: { t: { anyOf: [{ type: 'string' }, { type: 'null' }] } }
    }
  }];
  const out = convertToOpenAITools(tools);
  const t = out[0].function.parameters.properties.t;
  assert.equal(t.type, 'string');
  assert.equal(t.nullable, true);
  assert.equal('anyOf' in t, false);
});

test('convertToGeminiTools applies sanitizer (no anyOf in output)', () => {
  const tools = [{
    name: 'search',
    description: 'search',
    inputSchema: {
      type: 'object',
      properties: { t: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
      required: []
    }
  }];
  const out = convertToGeminiTools(tools);
  // convertToGeminiTools does its own conversion — we just need to verify
  // anyOf doesn't survive. Check the raw output structure.
  const serialized = JSON.stringify(out);
  assert.equal(serialized.includes('anyOf'), false);
});
