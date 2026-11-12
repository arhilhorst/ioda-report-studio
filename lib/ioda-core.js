/*
 * IODA Report Studio — core library
 * ---------------------------------
 * One file shared by the browser dashboard (index.html) and the Node CLI
 * (cli/*.mjs). No dependencies. Plain script: in the browser it defines
 * `window.IODACore`; in Node it is `require()`-able.
 *
 * Pipeline:
 *   IODA API v2  ->  parseSeries  ->  analyzeSignal (baseline + drop segments)
 *     ->  buildCandidates (merge simultaneous drops)  ->  enrich (IODA alerts,
 *     platform-artifact check, related ASNs/regions, severity score)
 *     ->  buildPacket (evidence packet for the LLM)  ->  renderDraftBrief
 *     (deterministic Template F)  /  buildRecord (IODA documentation row)
 *
 * Every number in a packet is computed from IODA's own raw series or IODA's own
 * outage events. Nothing is estimated from chart images.
 */
(function (root) {
  'use strict';

  const VERSION = '0.2.0';
  const API = 'https://api.ioda.inetintel.cc.gatech.edu/v2';
  const DASH = 'https://ioda.inetintel.cc.gatech.edu';

  /* Signals the studio analyses. `minDrop` is the smallest relative fall that
   * can count as a drop; `k` is the robust z-score (MAD units) a value must
   * fall below the baseline median. Both must hold. Google traffic instead uses
   * IODA's own SARIMA forecast threshold, which already models daily cycles. */
  const SIGNALS = {
    bgp: {
      label: 'BGP (routing)', short: 'BGP', tag: 'BGP',
      unit: 'visible /24 address blocks',
      means: 'How many of the location\'s address blocks are announced in global Internet routing tables.',
      mustNot: 'Not proof that apps or websites work, and not a share of people.',
      minDrop: 0.03, k: 4,
    },
    'ping-slash24': {
      label: 'Active probing', short: 'Probing', tag: 'AP',
      unit: '/24 blocks answering pings',
      means: 'How many of the location\'s address blocks answer IODA\'s pings.',
      mustNot: 'Not a percentage of people online.',
      minDrop: 0.10, k: 4,
    },
    'merit-nt': {
      label: 'Network telescope', short: 'Telescope', tag: 'Telescope',
      unit: 'unique source IPs in unsolicited traffic',
      means: 'Background traffic (scans, misconfigurations, malware) reaching Merit\'s network telescope from the location.',
      mustNot: 'Not a count of affected customers. Very noisy on its own.',
      minDrop: 0.40, k: 3,
    },
    gtr: {
      label: 'Google traffic', short: 'Google', tag: 'Google',
      unit: 'Google Search traffic vs IODA forecast',
      means: 'Requests to Google Search from the location, compared with IODA\'s forecast for that hour.',
      mustNot: 'Not equivalent to users online. Can also move when only Google is blocked.',
      minDrop: 0.30, k: 4,
    },
  };
  const CORE_SIGNALS = ['bgp', 'ping-slash24', 'merit-nt', 'gtr'];

  const DEFAULTS = {
    baselineDays: 7,             // baseline = the N days before `from`
    maxPoints: 3000,             // per series, server-side downsampling cap
    gapSteps: 2,                 // undropped points tolerated inside one drop
    minSegmentMinutes: 20,       // shorter drops are ignored
    mergeToleranceMinutes: 30,   // drops this close in time are "simultaneous"
    artifactWindowMinutes: 20,   // +/- window for the platform-artifact check
    artifactCountryThreshold: 20,// >= this many countries dropping at once = suspected IODA artifact
    maxArtifactChecks: 6,        // API calls are rate-sensitive; check the top N candidates
    relatedLimit: 8,             // ASNs / regions listed per candidate
  };

  const ENTITY_TYPES = ['country', 'region', 'asn'];

  /* ----------------------------------------------------------------- utils */

  const nowSec = () => Math.floor(Date.now() / 1000);
  const pad = (n) => String(n).padStart(2, '0');

  function fmtUTC(ts, withSeconds) {
    if (ts == null || !isFinite(ts)) return 'n/a';
    const d = new Date(ts * 1000);
    const base = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
    return (withSeconds ? `${base}:${pad(d.getUTCSeconds())}` : base) + ' UTC';
  }
  function fmtDay(ts) {
    const d = new Date(ts * 1000);
    return `${d.getUTCDate()} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  }
  function fmtDuration(sec) {
    if (sec == null || !isFinite(sec)) return 'n/a';
    if (sec < 3600) return `${Math.round(sec / 60)} min`;
    const h = sec / 3600;
    return h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} days (${Math.round(h)} h)`;
  }
  const cleanName = (n) => String(n || '').replace(/\s*\(\)\s*$/, '');
  const pct = (r) => (r == null || !isFinite(r) ? 'n/a' : `${Math.round(r * 100)}%`);

  function median(arr) {
    const a = arr.filter((x) => x != null && isFinite(x)).sort((x, y) => x - y);
    if (!a.length) return null;
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }
  function mad(arr, med) {
    const dev = arr.filter((x) => x != null && isFinite(x)).map((x) => Math.abs(x - med));
    const m = median(dev);
    return m == null ? null : 1.4826 * m;
  }
  function parseUTC(s) {
    // Accepts unix seconds, or ISO-ish "2026-10-27T17:30Z" / "2026-10-27 17:30" (treated as UTC).
    if (typeof s === 'number') return s;
    if (/^\d{9,11}$/.test(String(s).trim())) return Number(s);
    let t = String(s).trim().replace(' ', 'T');
    if (!/[zZ]|[+-]\d\d:?\d\d$/.test(t)) t += 'Z';
    const ms = Date.parse(t);
    if (isNaN(ms)) throw new Error(`Could not read the time "${s}". Use e.g. 2026-10-27T17:30Z.`);
    return Math.floor(ms / 1000);
  }
  function dashboardUrl(entityType, entityCode, from, until) {
    return `${DASH}/${entityType}/${encodeURIComponent(entityCode)}?from=${from}&until=${until}`;
  }

  /* ------------------------------------------------------------ API client */

  function makeClient(opts) {
    const o = opts || {};
    const doFetch = o.fetch || ((...a) => root.fetch(...a));
    const log = o.log || (() => {});
    async function get(path, params) {
      const q = new URLSearchParams();
      Object.entries(params || {}).forEach(([k, v]) => { if (v != null && v !== '') q.set(k, v); });
      const url = `${API}${path}${q.toString() ? '?' + q : ''}`;
      log(`GET ${url}`);
      let res;
      try { res = await doFetch(url, { signal: o.signal }); }
      catch (e) { const err = new Error(`Could not reach the IODA API (${e.message}).`); err.network = true; throw err; }
      let body;
      try { body = await res.json(); }
      catch (e) { throw new Error(`The IODA API answered HTTP ${res.status} without JSON for ${path}. Try a shorter time range.`); }
      if (!res.ok || body.error) throw new Error(`IODA API: ${body.error || 'HTTP ' + res.status} (${path})`);
      return { url, data: body.data };
    }
    return {
      get,
      searchEntities: (search, entityType, limit) => get('/entities/query', { search, entityType, limit: limit || 12 }),
      entity: (entityType, entityCode) => get('/entities/query', { entityType, entityCode }),
      countryOfAsn: (asn) => get('/entities/query', { entityType: 'country', relatedTo: `asn/${asn}` }),
      signals: (entityType, entityCode, from, until, maxPoints) =>
        get(`/signals/raw/${entityType}/${encodeURIComponent(entityCode)}`, { from, until, maxPoints }),
      events: (params) => get('/outages/events', Object.assign({ extendWindow: 0, limit: 2000 }, params)),
      summary: (params) => get('/outages/summary', Object.assign({ extendWindow: 0 }, params)),
    };
  }

  /* --------------------------------------------------------- series parsing */

  /* The raw-signals endpoint returns, per datasource, {from, step, values[]}.
   * Most values are numbers; `gtr-sarima` values are [{agg_values:{observed,
   * predicted, threshold}}]. We keep the four core signals and attach the
   * SARIMA forecast to Google traffic. Output is compact and JSON-safe so it
   * can be saved in case files. */
  function parseSeries(rawData) {
    const list = (rawData && rawData[0]) || [];
    const pick = (ds, subtype) =>
      list.find((s) => s.datasource === ds && (!subtype || s.subtype === subtype)) ||
      list.find((s) => s.datasource === ds);
    const out = {};
    for (const ds of CORE_SIGNALS) {
      const s = ds === 'gtr' ? pick('gtr', 'WEB_SEARCH') : pick(ds);
      if (!s || !Array.isArray(s.values)) continue;
      const entry = {
        ds, from: s.from, step: s.step, nativeStep: s.nativeStep, subtype: s.subtype || null,
        v: s.values.map((x) => (typeof x === 'number' ? x : null)),
      };
      if (ds === 'gtr') {
        const sar = pick('gtr-sarima', s.subtype);
        if (sar && Array.isArray(sar.values)) {
          const byTs = new Map();
          sar.values.forEach((x, i) => {
            const av = Array.isArray(x) && x[0] && x[0].agg_values;
            if (av) byTs.set(sar.from + i * sar.step, av);
          });
          entry.e = entry.v.map((_, i) => { const av = byTs.get(s.from + i * s.step); return av ? av.predicted : null; });
          entry.th = entry.v.map((_, i) => { const av = byTs.get(s.from + i * s.step); return av ? av.threshold : null; });
        }
      }
      if (entry.v.some((x) => x != null)) out[ds] = entry;
    }
    return out;
  }

  const seriesPoints = (s) =>
    s.v.map((v, i) => ({ t: s.from + i * s.step, v, e: s.e ? s.e[i] : null, th: s.th ? s.th[i] : null }));

  /* -------------------------------------------------------- signal analysis */

  function analyzeSignal(series, from, until, cfg) {
    const c = Object.assign({}, DEFAULTS, cfg);
    const meta = SIGNALS[series.ds];
    const pts = seriesPoints(series).filter((p) => p.v != null);
    const inWin = pts.filter((p) => p.t >= from && p.t <= until);
    const res = {
      ds: series.ds, label: meta.label, unit: meta.unit, step: series.step,
      method: null, baseline: null, status: 'ok', note: null,
      window: null, ratios: [], segments: [],
    };
    if (inWin.length < 3) { res.status = 'no-data'; res.note = 'IODA has too few data points for this signal in the window.'; return res; }

    let basePts = pts.filter((p) => p.t < from);
    let baselineScope = `${c.baselineDays}-day median before the window`;
    if (basePts.length < 12) { basePts = inWin; baselineScope = 'median of the window itself (no earlier data)'; }

    const useForecast = series.ds === 'gtr' && inWin.some((p) => p.e != null && p.th != null);
    let ratioOf, isDrop;
    if (useForecast) {
      res.method = 'below IODA SARIMA forecast threshold';
      res.baseline = { scope: 'IODA SARIMA forecast for each half hour', median: median(basePts.map((p) => p.e)), mad: null, points: basePts.length };
      ratioOf = (p) => (p.e ? p.v / p.e : null);
      isDrop = (p) => p.th != null && p.e != null && p.v < p.th && p.v / p.e < 1 - meta.minDrop;
    } else {
      const med = median(basePts.map((p) => p.v));
      if (!med) { res.status = 'no-data'; res.note = 'Baseline is zero; this signal cannot be compared.'; return res; }
      const m = mad(basePts.map((p) => p.v), med) || 0;
      // A drop must be BOTH k robust deviations below the median AND minDrop under it.
      const thr = Math.min(med - meta.k * m, med * (1 - meta.minDrop));
      res.method = `below baseline median - ${meta.k}xMAD and >= ${Math.round(meta.minDrop * 100)}% under baseline`;
      res.baseline = { scope: baselineScope, median: med, mad: m, threshold: thr, points: basePts.length };
      ratioOf = (p) => p.v / med;
      isDrop = (p) => p.v < thr;
    }

    res.ratios = inWin.map((p) => ({ t: p.t, r: ratioOf(p) }));
    const minP = inWin.reduce((a, p) => { const r = ratioOf(p); return r != null && (a == null || r < a.r) ? { t: p.t, r, v: p.v } : a; }, null);
    const last = inWin[inWin.length - 1];
    res.window = { min: minP, latest: { t: last.t, r: ratioOf(last), v: last.v }, points: inWin.length };

    // Drop segments
    const minLen = Math.max(c.minSegmentMinutes * 60, series.step);
    let seg = null, gap = 0;
    const segs = [];
    for (let i = 0; i < inWin.length; i++) {
      const p = inWin[i];
      if (isDrop(p)) {
        const r = ratioOf(p);
        if (!seg) seg = { start: p.t, lastDrop: p.t, min: { t: p.t, r, v: p.v }, recovery: null };
        seg.lastDrop = p.t; gap = 0;
        if (r != null && r < seg.min.r) seg.min = { t: p.t, r, v: p.v };
      } else if (seg) {
        gap++;
        if (gap === 1) seg.recovery = p.t;
        if (gap > c.gapSteps) { segs.push(seg); seg = null; gap = 0; }
      }
    }
    if (seg) { if (gap === 0) seg.recovery = null; segs.push(seg); }
    res.segments = segs
      .map((s) => {
        const ongoing = s.recovery == null || s.recovery <= s.lastDrop;
        const end = ongoing ? s.lastDrop + series.step : s.recovery;
        return { ds: series.ds, start: s.start, end, ongoing, duration: end - s.start, minRatio: s.min.r, minAt: s.min.t, minValue: s.min.v };
      })
      .filter((s) => s.duration >= minLen);
    return res;
  }

  /* ---------------------------------------------------- candidate outages */

  function buildCandidates(signalResults, cfg) {
    const c = Object.assign({}, DEFAULTS, cfg);
    const tol = c.mergeToleranceMinutes * 60;
    const segs = signalResults.flatMap((s) => s.segments).sort((a, b) => a.start - b.start);
    const clusters = [];
    for (const s of segs) {
      const cur = clusters[clusters.length - 1];
      if (cur && s.start <= cur.end + tol) { cur.segs.push(s); cur.end = Math.max(cur.end, s.end); }
      else clusters.push({ start: s.start, end: s.end, segs: [s] });
    }
    return clusters.map((cl, i) => {
      const bySignal = {};
      for (const s of cl.segs) {
        const b = bySignal[s.ds];
        if (!b) bySignal[s.ds] = Object.assign({}, s);
        else {
          b.start = Math.min(b.start, s.start); b.end = Math.max(b.end, s.end);
          b.ongoing = b.ongoing || s.ongoing; b.duration = b.end - b.start;
          if (s.minRatio < b.minRatio) { b.minRatio = s.minRatio; b.minAt = s.minAt; b.minValue = s.minValue; }
        }
      }
      const signals = CORE_SIGNALS.filter((ds) => bySignal[ds]).map((ds) => bySignal[ds]);
      const severity = signals.reduce((a, s) => a + (1 - Math.max(0, s.minRatio)) * (s.duration / 3600), 0);
      return {
        id: `C${i + 1}`, begin: cl.start, end: cl.end, duration: cl.end - cl.start,
        ongoing: signals.some((s) => s.ongoing), signals, signalCount: signals.length,
        severity: Math.round(severity * 100) / 100,
        iodaAlerts: {}, detector: {}, artifact: { checked: false }, related: { asns: [], regions: [] },
        classification: null,
      };
    });
  }

  /* Classification rule (v0.1.1):
   *  - suspected-artifact: the same signal dropped in >= artifactCountryThreshold
   *    other countries within +/- artifactWindowMinutes (an IODA-side fault).
   *  - corroborated: 2+ signals dropped together AND at least one of them is an
   *    infrastructure signal (BGP or active probing). Telescope + Google alone
   *    produced a false positive in validation (Ireland, 18 Oct 2026, 05:00 UTC).
   *  - needs-confirmation: everything else (1 signal, or no infrastructure signal).
   *    IODA's guidance: report only with an outside confirmation. */
  const INFRA_SIGNALS = ['bgp', 'ping-slash24'];
  function classify(cand) {
    if (cand.artifact && cand.artifact.verdict === 'suspected-artifact') return 'suspected-artifact';
    const infra = cand.signals.some((s) => INFRA_SIGNALS.includes(s.ds));
    return cand.signalCount >= 2 && infra ? 'corroborated' : 'needs-confirmation';
  }
  const CLASS_LABEL = {
    'corroborated': 'Outage: 2+ IODA signals dropped together, incl. routing or probing',
    'needs-confirmation': 'Needs confirmation: 1 signal, or no routing/probing drop',
    'suspected-artifact': 'Likely IODA measurement glitch',
  };

  function attachAlerts(cand, events, availableSignals) {
    for (const ds of CORE_SIGNALS) {
      if (!availableSignals.includes(ds)) { cand.iodaAlerts[ds] = 'NA'; cand.detector[ds] = 'NA'; continue; }
      cand.iodaAlerts[ds] = events.some((e) => e.datasource === ds && e.start < cand.end && e.start + e.duration > cand.begin);
      cand.detector[ds] = cand.signals.some((s) => s.ds === ds);
    }
  }

  /* --------------------------------------------------------- orchestration */

  /**
   * Run the whole pipeline for one entity and window.
   * @returns {Promise<object>} a "result" object: JSON-safe, can be saved as a case file.
   */
  async function investigate(params, opts) {
    const o = opts || {};
    const c = Object.assign({}, DEFAULTS, o.cfg);
    const progress = o.onProgress || (() => {});
    const api = makeClient({ fetch: o.fetch, signal: o.signal, log: o.log });
    const entityType = params.entityType;
    const entityCode = String(params.entityCode).trim();
    const from = parseUTC(params.from);
    const until = parseUTC(params.until);
    if (!ENTITY_TYPES.includes(entityType)) throw new Error(`Entity type must be one of ${ENTITY_TYPES.join(', ')}.`);
    if (!(until > from)) throw new Error('The end of the window must be after the start.');
    if (until - from > 45 * 86400) throw new Error('Keep the window to 45 days or less so the API can answer.');
    const baselineFrom = from - c.baselineDays * 86400;
    const requests = [];
    const track = (r) => { requests.push(r.url); return r.data; };

    progress('Looking up the entity');
    let entity = { code: entityCode, name: entityCode, type: entityType, attrs: {} };
    try {
      const d = track(await api.entity(entityType, entityCode));
      if (d && d[0]) entity = { code: d[0].code, name: cleanName(d[0].name), type: d[0].type, attrs: d[0].attrs || {} };
    } catch (e) { /* name lookup is optional */ }
    let country = entityType === 'country' ? { code: entity.code, name: entity.name } : null;
    if (entityType === 'asn') {
      try { const d = track(await api.countryOfAsn(entityCode)); if (d && d[0]) country = { code: d[0].code, name: d[0].name }; } catch (e) { /* optional */ }
    }

    progress('Downloading raw signals');
    const raw = track(await api.signals(entityType, entityCode, baselineFrom, until, c.maxPoints));
    const series = parseSeries(raw);
    const available = Object.keys(series);
    if (!available.length) throw new Error(`IODA returned no signal data for ${entityType} ${entityCode} in this window.`);

    progress('Analysing signals');
    const signals = CORE_SIGNALS.filter((ds) => series[ds]).map((ds) => analyzeSignal(series[ds], from, until, c));
    const candidates = buildCandidates(signals, c);

    progress('Fetching IODA outage events');
    let events = [];
    try {
      const d = track(await api.events({ entityType, entityCode, from, until }));
      events = (d || []).map((e) => ({ datasource: e.datasource, method: e.method, start: e.start, duration: e.duration, score: e.score }));
    } catch (e) { /* events are optional */ }
    let severityScore = null;
    try {
      const d = track(await api.summary({ entityType, entityCode, from, until }));
      if (d && d[0]) severityScore = { overall: d[0].scores.overall, bySource: d[0].scores, eventCount: d[0].event_cnt };
    } catch (e) { /* optional */ }

    candidates.forEach((cand) => attachAlerts(cand, events, available));

    // Platform-artifact check: did many countries "drop" in the same minutes?
    const ranked = candidates.slice().sort((a, b) => b.severity - a.severity).slice(0, c.maxArtifactChecks);
    for (const [i, cand] of ranked.entries()) {
      progress(`Checking for IODA-wide glitches (${i + 1}/${ranked.length})`);
      try { cand.artifact = await checkArtifact(api, cand, entity, c, track); }
      catch (e) { cand.artifact = { checked: false, error: e.message }; }
      try { await checkMinimaForGlitches(api, cand, entity, signals, c, track); }
      catch (e) { /* optional refinement */ }
    }

    // Related networks/regions for country-level candidates worth reporting.
    if (entityType === 'country') {
      const worth = ranked.filter((cd) => cd.artifact.verdict !== 'suspected-artifact').slice(0, 3);
      for (const cand of worth) {
        progress(`Finding affected networks for ${cand.id}`);
        cand.related = await relatedFor(api, entity.code, cand, c, track);
      }
    }
    candidates.forEach((cand) => { cand.classification = classify(cand); });

    return {
      schema: 'ioda-report-studio-result/1',
      generator: `IODA Report Studio ${VERSION}`,
      generatedAt: new Date().toISOString(),
      query: { entityType, entityCode: entity.code, from, until, baselineFrom, baselineDays: c.baselineDays },
      config: c,
      entity, country,
      dashboardUrl: dashboardUrl(entityType, entity.code, from, until),
      requests,
      series,
      signals,
      events,
      severityScore,
      candidates,
    };
  }

  async function checkArtifact(api, cand, entity, c, track) {
    const w = c.artifactWindowMinutes * 60;
    const starts = cand.signals.map((s) => s.start);
    const from = Math.min(...starts) - w;
    const until = Math.min(Math.max(...starts) + w, from + 6 * 3600);
    const d = track(await api.events({ entityType: 'country', from, until, limit: 5000 }));
    let worst = { ds: null, countries: 0, at: null };
    for (const s of cand.signals) {
      const set = new Set();
      for (const e of d || []) {
        if (e.datasource !== s.ds || Math.abs(e.start - s.start) > w) continue;
        if (entity.type === 'country' && e.location === `country/${entity.code}`) continue;
        set.add(e.location);
      }
      if (set.size > worst.countries) worst = { ds: s.ds, countries: set.size, at: s.start };
    }
    return {
      checked: true,
      maxSimultaneousCountries: worst.countries,
      datasource: worst.ds,
      at: worst.at,
      threshold: c.artifactCountryThreshold,
      verdict: worst.countries >= c.artifactCountryThreshold ? 'suspected-artifact' : 'clear',
    };
  }

  async function countCountriesAt(api, ds, at, entity, c, track) {
    const w = c.artifactWindowMinutes * 60;
    // `until` reaches 6 h past `at` because the API clips event durations to the query window.
    const d = track(await api.events({ entityType: 'country', from: at - w, until: at + 6 * 3600, limit: 5000 }));
    const set = new Set();
    const durations = [];
    for (const e of d || []) {
      if (e.datasource !== ds || Math.abs(e.start - at) > w) continue;
      if (entity.type === 'country' && e.location === `country/${entity.code}`) continue;
      if (!set.has(e.location)) durations.push(e.duration);
      set.add(e.location);
    }
    return { countries: set.size, start: at - w, end: at + Math.max(w, median(durations) || 0) };
  }

  /* A real outage can still have its LOWEST reading land on a platform-wide
   * glitch minute (validation: Guam, 18 Oct 2026 00:00 UTC). When that happens
   * we keep the raw minimum but also report the lowest reading outside the
   * glitch minutes, and the brief quotes that one. */
  async function checkMinimaForGlitches(api, cand, entity, signalResults, c, track) {
    const w = c.artifactWindowMinutes * 60;
    for (const s of cand.signals) {
      if (Math.abs(s.minAt - s.start) <= w) continue; // already covered by the start check
      const g = await countCountriesAt(api, s.ds, s.minAt, entity, c, track);
      if (g.countries < c.artifactCountryThreshold) continue;
      const sr = signalResults.find((x) => x.ds === s.ds);
      // Exclude the whole glitch span: from just before it starts to the median length of the other countries' events.
      const keep = (sr ? sr.ratios : []).filter((p) => p.t >= s.start && p.t < s.end && p.r != null && (p.t < g.start || p.t >= g.end));
      const alt = keep.reduce((a, p) => (a == null || p.r < a.r ? p : a), null);
      s.minGlitch = { countries: g.countries, at: s.minAt, rawMinRatio: s.minRatio, excludedUntil: g.end };
      if (alt) { s.minRatio = alt.r; s.minAt = alt.t; }
    }
  }

  async function relatedFor(api, countryCode, cand, c, track) {
    const out = { asns: [], regions: [] };
    const q = { relatedTo: `country/${countryCode}`, from: cand.begin, until: cand.end, limit: c.relatedLimit };
    try {
      const d = track(await api.summary(Object.assign({ entityType: 'asn' }, q)));
      out.asns = (d || []).map((x) => ({ code: x.entity.code, name: cleanName(x.entity.name), org: (x.entity.attrs && x.entity.attrs.org) || '', score: Math.round(x.scores.overall) }));
    } catch (e) { /* optional */ }
    try {
      const d = track(await api.summary(Object.assign({ entityType: 'region' }, q)));
      out.regions = (d || []).map((x) => ({ code: x.entity.code, name: x.entity.name, score: Math.round(x.scores.overall) }));
    } catch (e) { /* optional */ }
    return out;
  }

  /* Default candidate for a brief: real (non-glitch) drops first, then the
   * most signals, then the largest depth x duration. */
  function pickFocus(result, wanted) {
    if (wanted) return result.candidates.find((c) => c.id === wanted) || null;
    const real = result.candidates.filter((c) => c.classification !== 'suspected-artifact');
    const pool = real.length ? real : result.candidates;
    return pool.slice().sort((a, b) => (b.signalCount - a.signalCount) || (b.severity - a.severity))[0] || null;
  }

  /* ------------------------------------------------------- evidence packet */

  function signalBrief(s) {
    const m = SIGNALS[s.ds];
    return {
      datasource: s.ds,
      name: m.label,
      measures: m.means,
      unit: m.unit,
      mustNotBeReadAs: m.mustNot,
      status: s.status,
      baseline: s.baseline ? { scope: s.baseline.scope, median: round(s.baseline.median) } : null,
      detectionRule: s.method,
      lowestInWindow: s.window && s.window.min ? { atUTC: fmtUTC(s.window.min.t), percentOfBaseline: Math.round(s.window.min.r * 100) } : null,
      latestInWindow: s.window ? { atUTC: fmtUTC(s.window.latest.t), percentOfBaseline: Math.round(s.window.latest.r * 100) } : null,
      dataStepMinutes: Math.round(s.step / 60),
    };
  }
  const round = (x) => (x == null ? null : Math.round(x * 100) / 100);

  function candidateTimeline(cand, events) {
    const items = [];
    for (const s of cand.signals) {
      const m = SIGNALS[s.ds];
      items.push({ t: s.start, utc: fmtUTC(s.start), what: `${m.label} starts to fall below its normal level`, tag: 'IODA-DATA', source: 'S1' });
      items.push({ t: s.minAt, utc: fmtUTC(s.minAt), what: `${m.label} reaches its lowest point: ${pct(s.minRatio)} of normal`, tag: 'IODA-DATA', source: 'S1' });
      if (s.minGlitch) items.push({ t: s.minGlitch.at, utc: fmtUTC(s.minGlitch.at), what: `${m.label} reads ${pct(s.minGlitch.rawMinRatio)} of normal, but ${s.minGlitch.countries} other countries dropped in the same minutes (IODA measurement glitch); this reading is excluded`, tag: 'IODA-ALERT', source: 'S2' });
      items.push(s.ongoing
        ? { t: s.end, utc: fmtUTC(s.end), what: `${m.label} still below normal at the end of the data window`, tag: 'IODA-DATA', source: 'S1' }
        : { t: s.end, utc: fmtUTC(s.end), what: `${m.label} back above the drop threshold`, tag: 'IODA-DATA', source: 'S1' });
    }
    for (const e of events) {
      if (e.start < cand.end && e.start + e.duration > cand.begin) {
        items.push({ t: e.start, utc: fmtUTC(e.start), what: `IODA's automatic detector opens a ${SIGNALS[e.datasource] ? SIGNALS[e.datasource].label : e.datasource} alert (logged length ${fmtDuration(e.duration)})`, tag: 'IODA-ALERT', source: 'S2' });
      }
    }
    return items.sort((a, b) => a.t - b.t).map(({ t, ...rest }) => rest);
  }

  function interpretations(cand) {
    const has = (ds) => cand.signals.some((s) => s.ds === ds);
    const out = [];
    if (cand.classification === 'suspected-artifact') {
      out.push(`At the same minutes, ${cand.artifact.maxSimultaneousCountries} other countries showed a ${SIGNALS[cand.artifact.datasource].label} drop. A drop that wide and that sudden is far more likely to be a fault in IODA's measurement system than a real outage.`);
      return out;
    }
    for (const s of cand.signals.filter((x) => x.minGlitch)) {
      out.push(`${SIGNALS[s.ds].label}'s single lowest reading (${pct(s.minGlitch.rawMinRatio)}) landed on a minute when ${s.minGlitch.countries} other countries also dropped. That reading is excluded; the brief quotes the lowest reading outside the glitch (${pct(s.minRatio)}).`);
    }
    if (has('bgp') && has('ping-slash24')) {
      const deep = cand.signals.filter((s) => INFRA_SIGNALS.includes(s.ds)).every((s) => s.minRatio < 0.5);
      out.push(deep
        ? 'Most of the address space was withdrawn from routing and stopped answering pings at the same time. That pattern is typical of network-level shutdowns or major operator failures; the data alone does not say which.'
        : 'Part of the address space was withdrawn from routing and stopped answering pings at the same time. A partial drop like this can come from one operator failing, a regional cut, or a targeted restriction; the data alone does not say which.');
    }
    else if (has('ping-slash24') && !has('bgp')) out.push('Networks stayed announced in routing but stopped answering pings. That pattern is often seen with power cuts or local access failures. The cause is not established.');
    else if (has('bgp') && !has('ping-slash24')) out.push('Some address blocks were withdrawn from routing while probing did not fall in step. The disruption may affect only part of the address space.');
    if (has('gtr') && cand.signalCount === 1) out.push('Only Google traffic fell below forecast. This can mean users lost access, or that only Google services were affected. Treat as weak evidence until confirmed.');
    if (has('merit-nt') && cand.signalCount === 1) out.push('Only the network telescope dropped. This signal is noisy; it should not be reported without another signal or an outside source.');
    if (cand.signalCount >= 2 && !has('bgp') && !has('ping-slash24')) out.push('Only the two noisiest signals (telescope and Google traffic) dropped; routing and probing held steady. In testing this pattern produced false alarms, so it needs outside confirmation.');
    if (cand.classification === 'needs-confirmation') out.push('IODA\'s own guidance counts an outage only when 2+ signals drop together, or 1 signal plus an outside confirmation (for example Cloudflare Radar or on-the-ground reporting).');
    return out;
  }

  function scopeOf(result) {
    return { country: 'Country', region: 'Region', asn: 'ASN' }[result.query.entityType];
  }

  function buildPacket(result, candidateId, notes) {
    const cand = result.candidates.find((c) => c.id === candidateId) || null;
    const q = result.query;
    const sources = [
      { id: 'S1', type: 'IODA raw signals (API v2)', url: `${API}/signals/raw/${q.entityType}/${q.entityCode}?from=${q.baselineFrom}&until=${q.until}` },
      { id: 'S2', type: 'IODA outage events (API v2)', url: `${API}/outages/events?entityType=${q.entityType}&entityCode=${q.entityCode}&from=${q.from}&until=${q.until}&extendWindow=0` },
      { id: 'S3', type: 'IODA dashboard chart', url: result.dashboardUrl },
    ];
    const ext = (notes && notes.external) || [];
    ext.forEach((n, i) => sources.push({ id: `E${i + 1}`, type: 'External source (added by a human)', url: n.url || '', note: n.text || '' }));

    const packet = {
      schema: 'ioda-evidence-packet/1',
      generator: result.generator,
      generatedAt: result.generatedAt,
      readMe: 'All values come from IODA API data. Percentages are of each signal\'s own normal level, never of people. Times are UTC.',
      location: {
        name: result.entity.name, code: result.entity.code, type: q.entityType, scope: scopeOf(result),
        country: result.country ? result.country.name : null,
        organisation: (result.entity.attrs && result.entity.attrs.org) || null,
        ipAddressCount: (result.entity.attrs && result.entity.attrs.ip_count) || null,
      },
      window: {
        fromUTC: fmtUTC(q.from), untilUTC: fmtUTC(q.until),
        baseline: `${q.baselineDays} days before the window (${fmtUTC(q.baselineFrom)} to ${fmtUTC(q.from)})`,
      },
      iodaSeverityScore: result.severityScore ? Math.round(result.severityScore.overall) : null,
      signals: result.signals.map(signalBrief),
      candidatesInWindow: result.candidates.map((c) => ({
        id: c.id, classification: c.classification, beginUTC: fmtUTC(c.begin), endUTC: c.ongoing ? 'ongoing at end of window' : fmtUTC(c.end),
        signals: c.signals.map((s) => SIGNALS[s.ds].short),
      })),
      focus: null,
      sources,
      externalNotes: ext,
      unknowns: [
        'Cause of the disruption (IODA measures connectivity, not intent or cause).',
        'Number or share of people affected.',
        'Whether service was restored for users (signal recovery is not user recovery).',
      ],
    };
    if (cand) {
      packet.focus = {
        id: cand.id,
        classification: cand.classification,
        classificationLabel: CLASS_LABEL[cand.classification],
        beginUTC: fmtUTC(cand.begin),
        endUTC: cand.ongoing ? null : fmtUTC(cand.end),
        ongoingAtEndOfWindow: cand.ongoing,
        duration: fmtDuration(cand.duration),
        signalsThatDropped: cand.signals.map((s) => ({
          signal: SIGNALS[s.ds].label,
          startUTC: fmtUTC(s.start),
          lowestPercentOfNormal: Math.round(s.minRatio * 100),
          lowestAtUTC: fmtUTC(s.minAt),
          recoveredUTC: s.ongoing ? null : fmtUTC(s.end),
          duration: fmtDuration(s.duration),
          ...(s.minGlitch ? { excludedGlitchReading: { atUTC: fmtUTC(s.minGlitch.at), percentOfNormal: Math.round(s.minGlitch.rawMinRatio * 100), otherCountriesAtSameMinute: s.minGlitch.countries } } : {}),
        })),
        signalsThatDidNotDrop: result.signals.filter((s) => s.status === 'ok' && !cand.signals.some((x) => x.ds === s.ds)).map((s) => SIGNALS[s.ds].label),
        iodaAutomaticAlerts: Object.fromEntries(Object.entries(cand.iodaAlerts).map(([k, v]) => [SIGNALS[k].label, v])),
        platformGlitchCheck: cand.artifact.checked
          ? { otherCountriesDroppingAtSameMinutes: cand.artifact.maxSimultaneousCountries, threshold: cand.artifact.threshold, verdict: cand.artifact.verdict }
          : { verdict: 'not checked' },
        relatedNetworks: cand.related.asns.map((a) => `${a.name}${a.org ? ' (' + a.org + ')' : ''}`),
        relatedRegions: cand.related.regions.map((r) => r.name),
        timeline: candidateTimeline(cand, result.events),
        interpretationsToCheck: interpretations(cand),
      };
      if (!ext.length) packet.unknowns.push('No outside source (operator statement, Cloudflare Radar, local reporting) has been added yet.');
    }
    return packet;
  }

  async function fingerprint(obj) {
    const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
    const subtle = root.crypto && root.crypto.subtle;
    if (!subtle) return null;
    const buf = await subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
  }

  /* ------------------------------------------------ deterministic draft */

  function renderDraftBrief(result, candidateId, notes) {
    const p = buildPacket(result, candidateId, notes);
    const f = p.focus;
    const L = p.location;
    const lines = [];
    const where = L.type === 'asn' ? `${L.name}${L.organisation ? ' (' + L.organisation + ')' : ''}${L.country ? ', ' + L.country : ''}` : L.name;
    if (!f) {
      lines.push(`# ${where}: no outage candidate found`, '');
      lines.push(`_IODA Report Studio draft · ${p.generatedAt} · DRAFT, not reviewed_`, '');
      lines.push(`Between ${p.window.fromUTC} and ${p.window.untilUTC}, none of IODA's signals for ${where} fell below the drop thresholds used by this tool. [IODA-DATA S1]`, '');
      lines.push(`Open the IODA chart to check by eye: ${result.dashboardUrl}`);
      return lines.join('\n');
    }
    const cand = result.candidates.find((c) => c.id === candidateId);
    const title = {
      'corroborated': `Internet disruption in ${where}`,
      'needs-confirmation': `Possible Internet disruption in ${where}`,
      'suspected-artifact': `${where}: drop most likely an IODA measurement glitch`,
    }[f.classification];
    const dropped = f.signalsThatDropped.map((s) => `${s.signal} fell to ${s.lowestPercentOfNormal}% of normal`).join('; ');
    const endTxt = f.ongoingAtEndOfWindow ? 'The disruption was still visible when the data window ended' : `All measured signals were back above their drop thresholds by ${f.endUTC}`;

    lines.push(`# ${title}, ${fmtDay(cand.begin)}`, '');
    lines.push(`_IODA Report Studio deterministic draft · generated ${p.generatedAt} · Status: **DRAFT, not reviewed by a human or by IODA**_`, '');

    lines.push('## 1. Summary: what happened?', '');
    if (f.classification === 'suspected-artifact') {
      lines.push(`On ${fmtDay(cand.begin)}, IODA data for ${where} shows a drop starting ${f.beginUTC}: ${dropped}. [IODA-DATA S1] In the same minutes, ${cand.artifact.maxSimultaneousCountries} other countries showed the same kind of drop, so this is most likely a fault in IODA's measurement system rather than a real outage. [INTERPRETED] Do not report it as an outage without independent confirmation.`, '');
    } else {
      lines.push(`IODA measurements show ${f.signalsThatDropped.length === 1 ? 'one signal' : f.signalsThatDropped.length + ' independent signals'} for ${where} dropping from ${f.beginUTC}: ${dropped}. [IODA-DATA S1] ${endTxt}. [IODA-DATA S1]${f.classification === 'needs-confirmation' ? ' The evidence is too thin to call this an outage yet: it needs outside confirmation before it is reported. [INTERPRETED]' : ''}`, '');
      lines.push('These figures describe network measurements. They are not counts or percentages of people offline.', '');
    }

    lines.push('## 2. Outage details: where and when?', '');
    lines.push('| Field | Value | Evidence |', '| --- | --- | --- |');
    lines.push(`| Location / network | ${where} | ${L.scope} view in IODA [S3] |`);
    lines.push(`| Observed start | ${f.beginUTC} (first signal to drop) | [IODA-DATA S1] |`);
    lines.push(`| Recovery / last update | ${f.ongoingAtEndOfWindow ? 'Not recovered by ' + p.window.untilUTC : f.endUTC + ' (last signal back above threshold)'} | [IODA-DATA S1] |`);
    lines.push(`| Duration | ${f.duration} | [IODA-DATA S1] |`);
    lines.push(`| Signals that dropped | ${f.signalsThatDropped.map((s) => s.signal).join(', ')} | [IODA-DATA S1] |`);
    lines.push(`| Signals that did not drop | ${f.signalsThatDidNotDrop.join(', ') || 'none'} | [IODA-DATA S1] |`);
    lines.push(`| IODA automatic alerts | ${Object.entries(f.iodaAutomaticAlerts).map(([k, v]) => `${k}: ${v === 'NA' ? 'no signal' : v ? 'yes' : 'no'}`).join(' · ')} | [IODA-ALERT S2] |`);
    if (p.iodaSeverityScore != null) lines.push(`| IODA severity score (whole window) | ${p.iodaSeverityScore.toLocaleString('en-US')} (unitless, for ranking only) | [IODA-ALERT S2] |`);
    if (f.relatedRegions.length) lines.push(`| Regions also showing drops | ${f.relatedRegions.join(', ')} | [IODA-ALERT] |`);
    if (f.relatedNetworks.length) lines.push(`| Networks (ASNs) also showing drops | ${f.relatedNetworks.join('; ')} | [IODA-ALERT] |`);
    lines.push(`| Platform-glitch check | ${f.platformGlitchCheck.verdict === 'not checked' ? 'Not checked' : f.platformGlitchCheck.otherCountriesDroppingAtSameMinutes + ' other countries dropped in the same minutes (threshold ' + f.platformGlitchCheck.threshold + ')'} | [IODA-ALERT] |`, '');

    lines.push('## 3. Connectivity chart: how do we know?', '');
    lines.push(`Original IODA chart for this window: ${result.dashboardUrl} [S3]`, '');
    lines.push('| Signal | What it measures | Lowest in window | Must not be read as |', '| --- | --- | --- | --- |');
    for (const s of p.signals.filter((x) => x.status === 'ok')) {
      lines.push(`| ${s.name} | ${s.measures} | ${s.lowestInWindow ? s.lowestInWindow.percentOfBaseline + '% of normal at ' + s.lowestInWindow.atUTC : 'n/a'} | ${s.mustNotBeReadAs} |`);
    }
    lines.push('', `"Normal" is the ${result.query.baselineDays}-day median before the window (Google traffic: IODA's own forecast).`, '');

    lines.push('## 4. Timeline (UTC)', '');
    for (const t of f.timeline) lines.push(`- **${t.utc}**: ${t.what}. [${t.tag} ${t.source}]`);
    lines.push('');

    lines.push('## 5. Confirmed vs unconfirmed: what is still unknown?', '');
    lines.push('**Measured by IODA**', '');
    for (const s of f.signalsThatDropped) lines.push(`- ${s.signal} fell to ${s.lowestPercentOfNormal}% of its normal level (lowest at ${s.lowestAtUTC}). [IODA-DATA S1]`);
    lines.push('', '**Interpretation that a human must check**', '');
    for (const t of f.interpretationsToCheck) lines.push(`- ${t} [INTERPRETED]`);
    lines.push('', '**Missing**', '');
    for (const u of p.unknowns) lines.push(`- ${u} [MISSING]`);
    if (p.externalNotes.length) {
      lines.push('', '**Added by a human from outside sources**', '');
      p.externalNotes.forEach((n, i) => lines.push(`- ${n.text}${n.url ? ' (' + n.url + ')' : ''} [CORROBORATED E${i + 1}]`));
    }
    lines.push('');

    lines.push('## 6. Sources & editorial gate', '');
    for (const s of p.sources) lines.push(`- [${s.id}] ${s.type}: ${s.url}${s.note ? ' — ' + s.note : ''}`);
    lines.push('');
    lines.push('- [x] Raw IODA series downloaded and analysed (this draft)');
    lines.push(`- [${f.platformGlitchCheck.verdict === 'not checked' ? ' ' : 'x'}] Checked against simultaneous drops in other countries`);
    lines.push(`- [${p.externalNotes.length ? 'x' : ' '}] Independent outside confirmation added`);
    lines.push('- [ ] Named human reviewer has read every claim against the sources');
    lines.push('- [ ] IODA team review before any public release');
    return lines.join('\n');
  }

  /* --------------------------------------------- IODA documentation record */

  const RECORD_COLUMNS = [
    'Begin time', 'End time', 'Country',
    'IODA BGP Auto Alert', 'IODA AP Auto Alert', 'IODA Telescope Auto Alert',
    'IODA BGP visible by human', 'IODA AP visible by human', 'IODA Telescope visible by human',
    'Outage score', 'Scope', 'Region', 'AS', 'IODA URL', 'Cause', 'Confirmation Status', 'More Info',
  ];
  const tf = (v) => (v === 'NA' ? 'NA' : v ? 'TRUE' : 'FALSE');

  function recordTime(ts) {
    // IODA spreadsheet format: DD/MM/YYYY HH:MM:ss AM/PM (UTC)
    const d = new Date(ts * 1000);
    let h = d.getUTCHours(); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
    return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${pad(h)}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${ap}`;
  }

  function buildRecord(result, candidateId) {
    const cand = result.candidates.find((c) => c.id === candidateId);
    if (!cand) return null;
    const q = result.query;
    const pad1h = 3600;
    return {
      'Begin time': recordTime(cand.begin),
      'End time': cand.ongoing ? '' : recordTime(cand.end),
      'Country': result.country ? result.country.name : '',
      'IODA BGP Auto Alert': tf(cand.iodaAlerts.bgp),
      'IODA AP Auto Alert': tf(cand.iodaAlerts['ping-slash24']),
      'IODA Telescope Auto Alert': tf(cand.iodaAlerts['merit-nt']),
      'IODA BGP visible by human': tf(cand.detector.bgp),
      'IODA AP visible by human': tf(cand.detector['ping-slash24']),
      'IODA Telescope visible by human': tf(cand.detector['merit-nt']),
      'Outage score': result.severityScore ? Math.round(result.severityScore.overall) : '',
      'Scope': scopeOf(result),
      'Region': q.entityType === 'region' ? result.entity.name : cand.related.regions.map((r) => r.name).join(', '),
      'AS': q.entityType === 'asn' ? result.entity.name : cand.related.asns.map((a) => a.name).join(', '),
      'IODA URL': dashboardUrl(q.entityType, q.entityCode, cand.begin - pad1h, (cand.ongoing ? q.until : cand.end) + pad1h),
      'Cause': '',
      'Confirmation Status': '',
      'More Info': `Report Studio ${cand.id}: ${CLASS_LABEL[cand.classification]}. "Visible by human" columns are pre-filled by the detector and must be checked by a person.` +
        (cand.iodaAlerts.gtr === true ? ' IODA Google-traffic alert also active.' : ''),
    };
  }

  function toCSV(rows) {
    const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    return [RECORD_COLUMNS.map(esc).join(','), ...rows.map((r) => RECORD_COLUMNS.map((c) => esc(r[c])).join(','))].join('\n');
  }

  /* ------------------------------------------------------- prompt bundle */

  function buildPromptBundle(promptMarkdown, packet, extra) {
    const parts = [promptMarkdown.trim(), '', '---', '', '# INPUT: EVIDENCE PACKET', '', '```json', JSON.stringify(packet, null, 2), '```'];
    if (extra && extra.trim()) parts.push('', '# INPUT: REVIEWER INSTRUCTIONS', '', extra.trim());
    parts.push('', 'Write the brief now, following every rule above.');
    return parts.join('\n');
  }

  function buildAuditBundle(auditMarkdown, packet, draft, audienceProfilesText) {
    const parts = [auditMarkdown.trim(), '', '---', '', '# INPUT: EVIDENCE PACKET', '', '```json', JSON.stringify(packet, null, 2), '```', ''];
    if (audienceProfilesText) parts.push('# INPUT: AUDIENCE PROFILES', '', audienceProfilesText.trim(), '');
    parts.push('# INPUT: DRAFT BRIEF TO AUDIT', '', '````markdown', draft.trim(), '````', '', 'Audit the draft now.');
    return parts.join('\n');
  }

  /* ---------------------------------------------------- audience prompts */

  /* prompts/03_audiences.md holds a shared preamble and one profile per
   * audience. Each profile starts with an HTML comment marker:
   *   audience id="wire" label="Breaking-news alert" summary="…" length="…" tags="trail"
   * Returns {preamble, profiles:[{id,label,summary,length,tags,body}]}. */
  function parseAudiences(md) {
    const re = /<!--\s*audience\s+([\s\S]*?)-->/g;
    const marks = [];
    let m;
    while ((m = re.exec(md))) {
      const attrs = {};
      m[1].replace(/(\w+)="([^"]*)"/g, (_, k, v) => { attrs[k] = v; return ''; });
      if (attrs.id) marks.push({ start: m.index, end: re.lastIndex, attrs });
    }
    if (!marks.length) throw new Error('No audience profiles found in the audience file (marker comments are missing).');
    const preamble = md.slice(0, marks[0].start).replace(/<!--[\s\S]*?-->/g, '').replace(/^#\s[^\n]*\n/m, '').trim();
    const profiles = marks.map((mk, i) => ({
      id: mk.attrs.id,
      label: mk.attrs.label || mk.attrs.id,
      summary: mk.attrs.summary || '',
      length: mk.attrs.length || '',
      tags: mk.attrs.tags === 'trail' ? 'trail' : 'inline',
      body: md.slice(mk.end, i + 1 < marks.length ? marks[i + 1].start : md.length).trim(),
    }));
    return { preamble, profiles };
  }

  function pickProfiles(audienceDoc, ids) {
    const chosen = (ids || []).map((id) => audienceDoc.profiles.find((p) => p.id === id)).filter(Boolean);
    if (!chosen.length) throw new Error('Pick at least one audience.');
    return chosen;
  }

  /* The text an auditor needs to judge format and length (null for the default newsroom brief). */
  function audienceProfilesText(audienceDoc, ids) {
    const chosen = pickProfiles(audienceDoc, ids);
    if (chosen.length === 1 && chosen[0].id === 'newsroom') return null;
    return [audienceDoc.preamble, '', ...chosen.map((p) => p.body)].join('\n\n');
  }

  /**
   * Prompt for one or more audiences: writer rules + shared audience rules + chosen profiles
   * + evidence packet + reviewer instructions. Newsroom-only gives the plain writer prompt.
   * @param {object} opts {language, extra}
   */
  function buildAudienceBundle(writerMarkdown, audienceDoc, ids, packet, opts) {
    const o = opts || {};
    const chosen = pickProfiles(audienceDoc, ids);
    const newsroomOnly = chosen.length === 1 && chosen[0].id === 'newsroom';
    const instructions = [];
    if (o.language && !/^english$/i.test(o.language.trim())) instructions.push(`Write the audience-facing text in ${o.language.trim()}. Keep times, evidence tags, packet field names and network names as the rules say.`);
    if (o.extra && o.extra.trim()) instructions.push(o.extra.trim());

    const parts = [writerMarkdown.trim(), '', '---', ''];
    if (!newsroomOnly) {
      parts.push('# AUDIENCE PROFILES', '', `Write for: ${chosen.map((p) => p.label).join(', ')}.`, '', audienceDoc.preamble, '');
      chosen.forEach((p) => parts.push(p.body, ''));
      parts.push('---', '');
    }
    parts.push('# INPUT: EVIDENCE PACKET', '', '```json', JSON.stringify(packet, null, 2), '```');
    if (instructions.length) parts.push('', '# INPUT: REVIEWER INSTRUCTIONS', '', instructions.join('\n'));
    const ask = newsroomOnly
      ? 'Write the brief now, following every rule above.'
      : chosen.length === 1
        ? `Write the ${chosen[0].label} version now, following every rule above and its profile.`
        : `Write one section per audience, in this order: ${chosen.map((p) => p.label).join('; ')}. Start each with "# Audience: <label>". Follow every rule above and each profile.`;
    parts.push('', ask);
    return parts.join('\n');
  }

  const api = {
    VERSION, API, DASH, SIGNALS, CORE_SIGNALS, DEFAULTS, ENTITY_TYPES, CLASS_LABEL, RECORD_COLUMNS,
    fmtUTC, fmtDay, fmtDuration, pct, cleanName, parseUTC, nowSec, median, dashboardUrl,
    makeClient, parseSeries, seriesPoints, analyzeSignal, buildCandidates, classify, investigate, pickFocus,
    buildPacket, renderDraftBrief, buildRecord, toCSV, buildPromptBundle, buildAuditBundle, fingerprint,
    parseAudiences, buildAudienceBundle, audienceProfilesText,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.IODACore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
