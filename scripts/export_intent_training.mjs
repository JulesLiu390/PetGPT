#!/usr/bin/env node
/**
 * Export Intent training JSONL to Unsloth HF messages + tools format.
 *
 * Usage:
 *   node scripts/export_intent_training.mjs --input <dir> --output <file> [flags]
 */
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';

export function parseArgs(argv) {
  const args = {
    input: null, output: null,
    status: null, termination: null,
    redact: false,
    from: null, to: null,
    includeTargets: null, excludeTargets: null,
    template: 'hf-messages',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--input': args.input = argv[++i]; break;
      case '--output': args.output = argv[++i]; break;
      case '--status': args.status = argv[++i]; break;
      case '--termination': args.termination = argv[++i]; break;
      case '--redact': args.redact = true; break;
      case '--from': args.from = argv[++i]; break;
      case '--to': args.to = argv[++i]; break;
      case '--include-targets': args.includeTargets = argv[++i].split(','); break;
      case '--exclude-targets': args.excludeTargets = argv[++i].split(','); break;
      case '--template': args.template = argv[++i]; break;
      default: if (a.startsWith('--')) throw new Error(`Unknown flag: ${a}`);
    }
  }
  if (!args.input) throw new Error('--input required');
  if (!args.output) throw new Error('--output required');
  return args;
}

export async function loadRecords(inputDir) {
  const files = (await readdir(inputDir)).filter(f => f.endsWith('.jsonl'));
  const records = [];
  for (const f of files) {
    const date = f.replace('.jsonl', ''); // YYYY-MM-DD
    const text = await readFile(join(inputDir, f), 'utf8');
    for (const line of text.split('\n').filter(Boolean)) {
      try {
        const r = JSON.parse(line);
        r._file_date = date;
        records.push(r);
      } catch (_) { /* skip malformed */ }
    }
  }
  return records;
}

function shortHash(s, len = 8) {
  return createHash('sha256').update(String(s)).digest('hex').slice(0, len);
}

/**
 * Redact QQ numbers (5-12 digits) in a string using a stable mapping.
 * Updates `mapping.qq` in place; returns redacted string.
 */
export function redactString(s, mapping) {
  if (typeof s !== 'string') return s;
  return s.replace(/\b(\d{5,12})\b/g, (_, qq) => {
    if (!mapping.qq[qq]) mapping.qq[qq] = `U_${shortHash(qq, 8)}`;
    return mapping.qq[qq];
  });
}

/**
 * Apply redaction to all string fields in a record (deep-copied).
 * Updates `mapping` (shared across calls for cross-record stability).
 */
export function redactRecord(record, mapping) {
  const copy = JSON.parse(JSON.stringify(record));
  copy.target_id = redactString(copy.target_id, mapping);
  copy.system = redactString(copy.system, mapping);
  for (const m of copy.messages || []) {
    if (typeof m.content === 'string') {
      m.content = redactString(m.content, mapping);
    }
    for (const tc of m.tool_calls || []) {
      if (typeof tc.function?.arguments === 'string') {
        tc.function.arguments = redactString(tc.function.arguments, mapping);
      }
    }
  }
  return copy;
}

export function createRedactionMapping() {
  return { qq: {}, nick: {}, group: {} };
}

export function applyFilters(records, args) {
  return records.filter(r => {
    if (args.status && r.status !== args.status) return false;
    if (args.termination && r.termination !== args.termination) return false;
    if (args.from && r._file_date < args.from) return false;
    if (args.to && r._file_date > args.to) return false;
    if (args.includeTargets && !args.includeTargets.includes(r.target_id)) return false;
    if (args.excludeTargets && args.excludeTargets.includes(r.target_id)) return false;
    return true;
  });
}

export function convertToHFMessages(record) {
  const messages = [];

  // 1. System
  if (record.system) {
    messages.push({ role: 'system', content: record.system });
  }

  // 2. Build tool_call_id → name map (for tool role 'name' inference)
  const idToName = {};
  for (const m of record.messages || []) {
    for (const tc of m.tool_calls || []) {
      const id = tc.id || tc.tool_call_id;
      const name = tc.function?.name;
      if (id && name) idToName[id] = name;
    }
  }

  // 3. Walk original messages
  for (const m of record.messages || []) {
    if (m.role === 'user') {
      messages.push({ role: 'user', content: m.content ?? '' });
    } else if (m.role === 'assistant') {
      // Merge reasoning_content into content as <think> block
      const think = m.reasoning_content
        ? `<think>\n${m.reasoning_content}\n</think>`
        : '';
      const body = m.content ?? '';
      const content = think && body ? `${think}\n${body}` : (think || body);

      // Normalize tool_calls: arguments must be object
      const toolCalls = (m.tool_calls || []).map(tc => {
        const argsRaw = tc.function?.arguments;
        let args = argsRaw;
        if (typeof argsRaw === 'string') {
          args = JSON.parse(argsRaw);  // throws on bad JSON → caller drops record
        }
        return {
          id: tc.id,
          type: 'function',
          function: { name: tc.function.name, arguments: args },
        };
      });

      const msg = { role: 'assistant', content };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      messages.push(msg);
    } else if (m.role === 'tool') {
      messages.push({
        role: 'tool',
        tool_call_id: m.tool_call_id,
        name: idToName[m.tool_call_id] || 'unknown_tool',
        content: m.content ?? '',
      });
    }
  }

  // 4. Tools schema → HF shape
  const tools = (record.tools || []).map(t => {
    if (t.type === 'function' && t.function) return t;
    return {
      type: 'function',
      function: {
        name: t.name || '',
        description: t.description || '',
        parameters: t.parameters || { type: 'object', properties: {} },
      },
    };
  });

  return { messages, tools };
}

export async function main(argv) {
  const args = parseArgs(argv);
  const records = await loadRecords(args.input);
  const filtered = applyFilters(records, args);

  const mapping = createRedactionMapping();
  const filteredAndRedacted = args.redact
    ? filtered.map(r => redactRecord(r, mapping))
    : filtered;

  if (!existsSync(dirname(args.output))) {
    await mkdir(dirname(args.output), { recursive: true });
  }

  const outputLines = [];
  let droppedInvalid = 0;
  for (const r of filteredAndRedacted) {
    try {
      const hf = args.template === 'raw' ? r : convertToHFMessages(r);
      outputLines.push(JSON.stringify(hf));
    } catch (e) {
      droppedInvalid++;
    }
  }

  await writeFile(args.output, outputLines.join('\n') + (outputLines.length ? '\n' : ''));

  if (args.redact) {
    const mapPath = join(dirname(args.output), 'redaction_map.json');
    await writeFile(mapPath, JSON.stringify(mapping, null, 2));
    console.log(`Redaction map: ${mapPath}  (KEEP LOCAL, add to .gitignore)`);
  }

  console.log(`Input records: ${records.length}`);
  console.log(`After filter:  ${filtered.length}`);
  console.log(`Output:        ${outputLines.length}  (dropped ${droppedInvalid} invalid)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}
