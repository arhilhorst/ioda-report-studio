#!/usr/bin/env node
// Build a full report bundle for one entity + window from the live IODA API.
//
//   node cli/report.mjs --type country --code HT --from 2026-10-27T00:00Z --until 2026-10-29T12:00Z
//   node cli/report.mjs --type asn --code 12066 --from 2026-11-09T00:00Z --until 2026-11-12T00:00Z --candidate C1
//
// Writes to out/<code>-<from>/:
//   result.json         full analysis (also loadable in the dashboard as a case file)
//   packet.json         evidence packet for the focus candidate
//   draft.md            deterministic Template F brief (no LLM)
//   prompt-bundle.md    prompts/01_brief_writer.md + packet, ready to paste into any LLM
//   record.csv          one row in IODA's outage-documentation format per candidate
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const core = require('../lib/ioda-core.js');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { const k = argv[i].slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; out[k] = v; }
  }
  return out;
}

export const pickFocus = core.pickFocus;

export async function writeBundle(result, outDir, focusId) {
  await mkdir(outDir, { recursive: true });
  const prompt = await readFile(join(ROOT, 'prompts/01_brief_writer.md'), 'utf8');
  const packet = core.buildPacket(result, focusId);
  packet.fingerprint = await core.fingerprint(packet);
  await writeFile(join(outDir, 'result.json'), JSON.stringify(result));
  await writeFile(join(outDir, 'packet.json'), JSON.stringify(packet, null, 2));
  await writeFile(join(outDir, 'draft.md'), core.renderDraftBrief(result, focusId));
  await writeFile(join(outDir, 'prompt-bundle.md'), core.buildPromptBundle(prompt, packet));
  const rows = result.candidates.map((c) => core.buildRecord(result, c.id));
  await writeFile(join(outDir, 'record.csv'), core.toCSV(rows));
  return packet;
}

async function main() {
  const a = args(process.argv.slice(2));
  if (!a.type || !a.code || !a.from || !a.until) {
    console.error('Usage: node cli/report.mjs --type country|region|asn --code <code> --from <UTC> --until <UTC> [--candidate C1] [--out dir]');
    process.exit(2);
  }
  const result = await core.investigate(
    { entityType: a.type, entityCode: a.code, from: a.from, until: a.until },
    { onProgress: (m) => console.error(`· ${m}`) },
  );
  const focus = pickFocus(result, a.candidate);
  const tag = new Date(result.query.from * 1000).toISOString().slice(0, 16).replace(/[:]/g, '');
  const outDir = resolve(a.out || join(ROOT, 'out', `${a.type}-${result.entity.code}-${tag}`));
  await writeBundle(result, outDir, focus && focus.id);

  console.log(`\n${result.entity.name} · ${core.fmtUTC(result.query.from)} → ${core.fmtUTC(result.query.until)}`);
  for (const c of result.candidates) {
    console.log(`  ${c.id}  ${core.fmtUTC(c.begin)}  ${core.fmtDuration(c.duration).padEnd(10)} ${c.classification.padEnd(18)} ${c.signals.map((s) => `${core.SIGNALS[s.ds].short} ${core.pct(s.minRatio)}`).join(', ')}`
      + (c.artifact.checked ? `  [${c.artifact.maxSimultaneousCountries} countries at once]` : ''));
  }
  if (!result.candidates.length) console.log('  No drops crossed the thresholds.');
  console.log(`\nFocus: ${focus ? focus.id : 'none'} · bundle written to ${outDir}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`Error: ${e.message}`); process.exit(1); });
}
