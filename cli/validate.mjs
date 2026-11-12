#!/usr/bin/env node
// Validate the detector against outages IODA has already published.
//
//   node cli/validate.mjs            # all cases in data/reference_cases.json
//   node cli/validate.mjs IR-2026-01-08
//
// For each case: pulls raw IODA data, runs the pipeline, saves a case file to
// data/cases/<id>.json (the dashboard's bundled demo data), and checks the
// detector's output against the published claims. Writes
// data/validation/validation-report.md.
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickFocus } from './report.mjs';

const require = createRequire(import.meta.url);
const core = require('../lib/ioda-core.js');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const H = 3600;

function focusOf(result) { return pickFocus(result); }

function runCheck(check, result) {
  const f = focusOf(result);
  const sig = (ds) => f && f.signals.find((s) => s.ds === ds);
  const t = (s) => core.parseUTC(s);
  switch (check.type) {
    case 'classification':
      return { pass: !!f && f.classification === check.expect, got: f ? f.classification : 'no candidate' };
    case 'signalsInclude': {
      const got = f ? f.signals.map((s) => s.ds) : [];
      return { pass: check.expect.every((d) => got.includes(d)), got: got.join(', ') || 'none' };
    }
    case 'signalsExclude': {
      const got = f ? f.signals.map((s) => s.ds) : [];
      return { pass: check.expect.every((d) => !got.includes(d)), got: got.join(', ') || 'none' };
    }
    case 'startBetween': {
      const s = sig(check.signal);
      return { pass: !!s && s.start >= t(check.from) && s.start <= t(check.until), got: s ? core.fmtUTC(s.start) : 'signal did not drop' };
    }
    case 'minBelowPct': {
      const s = sig(check.signal);
      return { pass: !!s && s.minRatio * 100 < check.pct, got: s ? `${(s.minRatio * 100).toFixed(1)}% at ${core.fmtUTC(s.minAt)}` : 'signal did not drop' };
    }
    case 'recoveryNear': {
      const s = sig(check.signal);
      if (!s) return { pass: false, got: 'signal did not drop' };
      if (s.ongoing) return { pass: false, got: 'still down at end of window' };
      return { pass: Math.abs(s.end - t(check.at)) <= check.toleranceHours * H, got: `${core.fmtUTC(s.end)} (${((s.end - t(check.at)) / H).toFixed(1)} h from published)` };
    }
    case 'minNotNear': {
      const s = sig(check.signal);
      if (!s) return { pass: false, got: 'signal did not drop' };
      return { pass: Math.abs(s.minAt - t(check.at)) > check.toleranceMinutes * 60, got: `lowest at ${core.fmtUTC(s.minAt)}${s.minGlitch ? `; excluded ${(s.minGlitch.rawMinRatio * 100).toFixed(1)}% at ${core.fmtUTC(s.minGlitch.at)} (${s.minGlitch.countries} countries)` : ''}` };
    }
    case 'noRealOutage': {
      // Pass when nothing is presented as a confirmed outage AND the glitch itself is flagged.
      const claimed = result.candidates.filter((c) => c.classification === 'corroborated');
      const flagged = result.candidates.some((c) => c.classification === 'suspected-artifact');
      return { pass: claimed.length === 0 && flagged, got: result.candidates.map((c) => `${c.id}:${c.classification}${c.artifact.checked ? ' (' + c.artifact.maxSimultaneousCountries + ' countries)' : ''}`).join('; ') || 'none' };
    }
    default:
      return { pass: false, got: `unknown check ${check.type}` };
  }
}

function describe(check) {
  switch (check.type) {
    case 'classification': return `Classified as ${check.expect}`;
    case 'signalsInclude': return `Dropped signals include ${check.expect.join(' + ')}`;
    case 'signalsExclude': return `Dropped signals exclude ${check.expect.join(' + ')}`;
    case 'startBetween': return `${core.SIGNALS[check.signal].short} drop starts ${check.from.replace('T', ' ')} – ${check.until.replace('T', ' ')}`;
    case 'minBelowPct': return `${core.SIGNALS[check.signal].short} lowest point < ${check.pct}% of normal`;
    case 'recoveryNear': return `${core.SIGNALS[check.signal].short} recovers within ±${check.toleranceHours} h of ${check.at.replace('T', ' ')}`;
    case 'noRealOutage': return 'No real outage reported (glitch flagged)';
    case 'minNotNear': return `${core.SIGNALS[check.signal].short} lowest point is not the glitch minute ${check.at.replace('T', ' ')}`;
    default: return check.type;
  }
}

async function main() {
  const only = process.argv.slice(2);
  const ref = JSON.parse(await readFile(join(ROOT, 'data/reference_cases.json'), 'utf8'));
  await mkdir(join(ROOT, 'data/cases'), { recursive: true });
  await mkdir(join(ROOT, 'data/validation'), { recursive: true });
  const md = ['# Detector validation report', '', `Generated ${new Date().toISOString()} by IODA Report Studio ${core.VERSION} against the live IODA API v2.`, ''];
  let passed = 0, total = 0;
  const summary = [];

  for (const c of ref.cases) {
    if (only.length && !only.includes(c.id)) continue;
    console.error(`\n=== ${c.id}`);
    const result = await core.investigate(
      { entityType: c.entityType, entityCode: c.entityCode, from: c.from, until: c.until },
      { onProgress: (m) => console.error(`· ${m}`) },
    );
    result.caseInfo = { id: c.id, title: c.title, published: c.published };
    await writeFile(join(ROOT, 'data/cases', `${c.id}.json`), JSON.stringify(result));

    const f = focusOf(result);
    md.push(`## ${c.id}: ${c.title}`, '');
    md.push(`Window ${core.fmtUTC(result.query.from)} → ${core.fmtUTC(result.query.until)} · [IODA chart](${result.dashboardUrl})`, '');
    md.push('**What IODA published**', '');
    c.published.forEach((p) => md.push(`- ${p.claim} (${p.source})`));
    md.push('', `**What the detector found** (${result.candidates.length} candidate${result.candidates.length === 1 ? '' : 's'}; focus ${f ? f.id : 'none'})`, '');
    if (f) {
      md.push('| Signal | Drop starts | Lowest | Recovers |', '| --- | --- | --- | --- |');
      f.signals.forEach((s) => md.push(`| ${core.SIGNALS[s.ds].label} | ${core.fmtUTC(s.start)} | ${(s.minRatio * 100).toFixed(1)}% at ${core.fmtUTC(s.minAt)}${s.minGlitch ? ` (glitch reading ${(s.minGlitch.rawMinRatio * 100).toFixed(1)}% at ${core.fmtUTC(s.minGlitch.at)} excluded)` : ''} | ${s.ongoing ? 'still down' : core.fmtUTC(s.end)} |`));
      md.push('', `Classification: **${f.classification}**. Glitch check: ${f.artifact.checked ? f.artifact.maxSimultaneousCountries + ' other countries in the same minutes' : 'not run'}.`, '');
    }
    md.push('| Check | Result | Detector output |', '| --- | --- | --- |');
    let casePass = 0;
    for (const chk of c.checks) {
      const r = runCheck(chk, result);
      total++; if (r.pass) { passed++; casePass++; }
      md.push(`| ${describe(chk)} | ${r.pass ? 'PASS' : 'FAIL'} | ${r.got} |`);
    }
    md.push('');
    summary.push(`| ${c.id} | ${casePass}/${c.checks.length} |`);
    console.error(`  ${casePass}/${c.checks.length} checks passed`);
  }
  md.splice(4, 0, `**${passed} of ${total} checks passed.**`, '', '| Case | Checks passed |', '| --- | --- |', ...summary, '');
  await writeFile(join(ROOT, 'data/validation/validation-report.md'), md.join('\n'));
  console.log(`\n${passed}/${total} checks passed · data/validation/validation-report.md`);
}

main().catch((e) => { console.error(`Error: ${e.message}`); process.exit(1); });
