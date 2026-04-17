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

// Placeholder — implemented in Task 11
export function convertToHFMessages(record) {
  throw new Error('convertToHFMessages not yet implemented');
}

export async function main(argv) {
  const args = parseArgs(argv);
  const records = await loadRecords(args.input);
  const filtered = applyFilters(records, args);

  if (!existsSync(dirname(args.output))) {
    await mkdir(dirname(args.output), { recursive: true });
  }

  const outputLines = [];
  let droppedInvalid = 0;
  for (const r of filtered) {
    try {
      const hf = args.template === 'raw' ? r : convertToHFMessages(r);
      outputLines.push(JSON.stringify(hf));
    } catch (e) {
      droppedInvalid++;
    }
  }

  await writeFile(args.output, outputLines.join('\n') + (outputLines.length ? '\n' : ''));

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
