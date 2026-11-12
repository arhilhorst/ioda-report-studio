# Audience profiles · v1.0

<!--
How this file is used
- IODA Report Studio builds an audience prompt as:
    prompts/01_brief_writer.md  +  the shared section below  +  the chosen profile(s)  +  evidence packet.
- Each profile starts with a marker line: an HTML comment whose text is
    audience id="…" label="…" summary="…" length="…" tags="inline|trail"
  (copy an existing marker below). The profile is everything from its marker to the next marker. Keep that marker format when editing;
  the dashboard and cli/report.mjs parse it. Add a new audience by adding a new marker + section.
- tags="inline": evidence tags stay in the text (readers who check sources).
  tags="trail": the audience text stays clean; an Evidence trail table after it carries the tags,
  so the claim auditor (02_claim_auditor.md) can still check every claim.
-->

## Applying an audience profile

You are writing for the audience profile(s) listed under **AUDIENCE PROFILES**, not only for the default newsroom brief.

1. **Every rule in the writer prompt above still applies**: copy numbers from the packet, UTC only, "% of normal" never becomes "% of people", no cause or actor unless a `[CORROBORATED Ex]` source states it, classification wording, per-signal recovery, glitch handling.
2. **The profile's Format replaces the writer prompt's "Output format".** If more than one profile is listed, write one section per profile, in the order given, each starting with `# Audience: <label>` on its own line. In the writer prompt's final checklist, skip the items about the six headings, section 5 and the quotable line for any profile other than Newsroom reporter; every other checklist item still applies.
3. **Evidence.**
   - Profiles marked `tags: inline` keep evidence tags at the end of each factual sentence, as in the writer prompt.
   - Profiles marked `tags: trail` keep the audience text free of tags. Directly after the text, add `#### Evidence trail` with a table `| # | Claim (short quote) | Tag | Packet field |`, one row per factual claim. Every number, time, place, network name and classification in the audience text must have a row.
4. **Classification decides the wording for every audience.**
   - `corroborated`: "Internet disruption" or "outage".
   - `needs-confirmation`: "possible disruption", and say it is not yet confirmed.
   - `suspected-artifact`: say the drop is most likely an IODA measurement glitch and must not be reported as an outage. Do not write an alert, post or policy summary that treats it as real.
5. **Language.** Write the audience-facing text in the language named under REVIEWER INSTRUCTIONS (default: English). In every language keep times as `HH:MM UTC` (24-hour), and keep evidence tags, packet field names, signal names in the trail, and network names exactly as in the packet.
6. **Length limits are hard limits.** Count words (or characters, for social posts) before answering and cut until you are inside the limit.
7. **Attribution.** Any audience text that may be published ends with: `Data: IODA, Georgia Tech Internet Intelligence Lab.` (translated if the text is not in English).

<!-- audience id="newsroom" label="Newsroom reporter" summary="Full Template F brief with inline evidence tags (the default)" length="300–500 words" tags="inline" -->
### Profile: Newsroom reporter · tags: inline

**Reader:** a reporter or producer writing a story about the disruption, on deadline, who will check claims against sources.

**Format:** use the writer prompt's "Output format" exactly: Template F, the six numbered headings, inline evidence tags, the editorial-gate checklist and the quotable line. Nothing in this profile changes it.

<!-- audience id="wire" label="Breaking-news alert" summary="Headline and three sentences a news desk can publish fast" length="≤ 90 words" tags="trail" -->
### Profile: Breaking-news alert · tags: trail

**Reader:** a wire, live-blog or push-alert editor who needs publishable copy in minutes and will not read a long brief.

**They need, in this order:** what happened and where; when it started (UTC); how IODA knows; the single most important caveat.

**Format** (≤ 90 words, excluding the evidence trail):

```markdown
**<Headline: max 12 words. Starts with "Possible" for needs-confirmation. Never "shutdown" or "blackout" unless a CORROBORATED source says so.>**

<Sentence 1: place, start time in UTC, and what IODA measured (name at most two signals, in plain words).>
<Sentence 2: how deep and how long, or that it was still visible when the data ended.>
<Sentence 3: the main unknown, attributed, e.g. "IODA's data does not show what caused it.">

Data: IODA, Georgia Tech Internet Intelligence Lab.

#### Evidence trail
| # | Claim (short quote) | Tag | Packet field |
```

**Avoid:** adjectives ("massive", "sweeping"), percentages of people, local times, any sentence without a fact in it. For `suspected-artifact`, replace the alert with one sentence: "Not for publication: IODA data shows a drop that matches a platform-wide measurement glitch."

<!-- audience id="factcheck" label="Editor / fact-check desk" summary="Verdict on what can be reported, what cannot, and what to verify next" length="≤ 300 words" tags="inline" -->
### Profile: Editor / fact-check desk · tags: inline

**Reader:** an editor or fact-checker deciding whether, and how, the newsroom can report this disruption. They care about what is safe to say more than about narrative.

**Format** (≤ 300 words):

```markdown
### Verdict
<Exactly one of: "REPORTABLE AS AN OUTAGE" (corroborated) · "REPORTABLE ONLY AS A POSSIBLE DISRUPTION" (needs-confirmation, or corroborated with no outside source) · "DO NOT REPORT: LIKELY IODA GLITCH" (suspected-artifact). One sentence of reason, tagged.>

### Safe to say
<3–5 bullet sentences a reporter can use as written, each tagged.>

### Not supported by this evidence
<Bullets: cause, actor, people affected, restoration for users, plus anything a reporter is likely to over-claim for this case. Tag each [MISSING].>

### Evidence strength
| Signal | Dropped? | Lowest (% of normal) | IODA alert? |
| --- | --- | --- | --- |

### Verify next
<3–5 concrete steps, e.g. compare the same UTC window on Cloudflare Radar; ask the operators named in relatedNetworks for a statement; search local-language news for the place and date; open the IODA chart (S3) and check the drop by eye. Steps are suggestions, not facts: no tags needed.>
```

<!-- audience id="policy" label="Policy & human-rights" summary="Neutral, citable record for ministries, NGOs and shutdown trackers" length="≤ 300 words" tags="trail" -->
### Profile: Policy & human-rights documentation · tags: trail

**Reader:** staff at a government body, NGO, UN office or digital-rights group who document Internet disruptions (for example for shutdown trackers or reports) and may cite this text.

**Tone:** neutral and formal. No advocacy and no attribution of responsibility, even if the context seems obvious, unless a `[CORROBORATED Ex]` source states it, and then attribute it to that source by name ("According to …").

**Format** (≤ 300 words, excluding the evidence trail):

```markdown
### Summary
<2–3 sentences: place, scope, start and end (or status) in UTC, what was measured.>

### Key facts
| Item | Detail |
| --- | --- |
| Location | … |
| Scope | Country / Region / Network (ASN) |
| Start (UTC) | … |
| End (UTC) or status | … |
| Duration | … |
| Signals affected | … (lowest level as % of normal) |
| Networks or regions also affected | … or "None identified in IODA data" |
| Confidence | High: 2+ IODA signals incl. routing or probing · Low: needs outside confirmation · Not an outage: measurement glitch |

### Not established by this data
<Bullets: cause, responsible party, number of people affected, restoration for users, anything else in packet.unknowns.>

### Suggested citation
IODA (Georgia Tech Internet Intelligence Lab), <location>, <window from–until UTC>, <S3 url>, accessed <date from packet.generatedAt>.

#### Evidence trail
| # | Claim (short quote) | Tag | Packet field |
```

<!-- audience id="public" label="General public & social" summary="Plain-language explainer plus one social post" length="≤ 120 words + 280 characters" tags="trail" -->
### Profile: General public & social media · tags: trail

**Reader:** members of the public, possibly in the affected place, reading on a phone, with no technical background.

**Plain-language rules:**
- Reading level of a general newspaper (short sentences, common words).
- Explain "% of normal" once in everyday words, e.g. "only about 4 in every 100 of the networks that usually answer IODA's tests were answering". Never turn it into a share of people or homes.
- Write "UTC (Coordinated Universal Time)" the first time a time appears.
- No jargon: no "BGP", "/24", "ASN" or "telescope" in the explainer or post. Say "Internet routes", "networks", "network provider".

**Format:**

```markdown
### Explainer (≤ 120 words)
<What happened, when, how IODA knows (one sentence), and what is not known.>
Data: IODA, Georgia Tech Internet Intelligence Lab.

### Social post (≤ 280 characters, including the link)
<One post. Include the IODA chart link (S3). No emojis. No hashtags except, optionally, the place name. Never "blackout".>

#### Evidence trail
| # | Claim (short quote) | Tag | Packet field |
```

For `suspected-artifact`, write no post. Write a two-sentence explainer saying IODA saw a brief drop in many countries at once, which points to a measurement problem rather than a real outage.

<!-- audience id="technical" label="Network operators & researchers" summary="Per-signal measurements, detector settings and open technical questions" length="≤ 350 words" tags="inline" -->
### Profile: Network operators & measurement researchers · tags: inline

**Reader:** network engineers, Internet-measurement researchers and the IODA team. They know BGP, active probing and darknet telescopes, and want precise values and methods, not explanations.

**Format** (≤ 350 words, technical terms allowed):

```markdown
### Summary
<2 sentences: entity (type/code), window, classification, signals that dropped.>

### Per-signal measurements
| Signal | Baseline (scope, median, unit) | Drop start (UTC) | Lowest % of baseline (UTC) | Recovered (UTC) | IODA alert | Step (min) |
| --- | --- | --- | --- | --- | --- | --- |

### Detection and checks
<Bullets: each signal's detectionRule; platformGlitchCheck result and threshold; any excludedGlitchReading; signals that did not drop. Tagged.>

### Related networks and regions
<From relatedNetworks / relatedRegions, or "None returned for this window". Tagged [IODA-ALERT].>

### Open technical questions
<2–4 bullets a researcher would check next, e.g. per-ASN breakdown of the routing drop; prefix-level visibility; latency and loss on the remaining probed blocks; comparison with another measurement platform. Questions, not facts: no tags needed.>
```
