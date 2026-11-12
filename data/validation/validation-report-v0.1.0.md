# Detector validation report

Generated 2026-11-12T18:05:10.617Z by IODA Report Studio 0.1.0 against the live IODA API v2.

**16 of 17 checks passed.**

| Case | Checks passed |
| --- | --- |
| AF-2025-09-29 | 5/5 |
| IR-2026-01-08 | 5/5 |
| HT-2026-10-27 | 3/3 |
| GLITCH-2026-10-18 | 0/1 |
| GU-2026-10-17 | 3/3 |

## AF-2025-09-29: Afghanistan nationwide shutdown

Window 2025-09-29 00:00 UTC → 2025-10-02 00:00 UTC · [IODA chart](https://ioda.inetintel.cc.gatech.edu/country/AF?from=1759104000&until=1759363200)

**What IODA published**

- First connectivity drop around 11:00 UTC on Sep 29 (IODA Afghanistan report [A1])
- Sustained nationwide drop around 12:30 UTC (article intro says 12:30 a.m.; later timeline says 12:30 PM UTC) (IODA Afghanistan report [A1])
- Active Probing fell below 5% (IODA Afghanistan report [A1])
- Traffic restored around 11:45 UTC on Oct 1 (IODA / Cloudflare as cited in [A1])

**What the detector found** (1 candidate; focus C1)

| Signal | Drop starts | Lowest | Recovers |
| --- | --- | --- | --- |
| BGP (routing) | 2025-09-29 12:10 UTC | 15.4% at 2025-09-29 18:40 UTC | 2025-10-01 13:10 UTC |
| Active probing | 2025-09-29 11:30 UTC | 3.8% at 2025-09-29 15:30 UTC | 2025-10-01 12:50 UTC |
| Google traffic | 2025-09-29 12:00 UTC | 0.3% at 2025-09-29 19:00 UTC | 2025-09-30 17:00 UTC |

Classification: **corroborated**. Glitch check: 0 other countries in the same minutes.

| Check | Result | Detector output |
| --- | --- | --- |
| Classified as corroborated | PASS | corroborated |
| Dropped signals include bgp + ping-slash24 | PASS | bgp, ping-slash24, gtr |
| Probing drop starts 2025-09-29 10:30Z – 2025-09-29 13:30Z | PASS | 2025-09-29 11:30 UTC |
| Probing lowest point < 5% of normal | PASS | 3.8% at 2025-09-29 15:30 UTC |
| Probing recovers within ±3 h of 2025-10-01 11:45Z | PASS | 2025-10-01 12:50 UTC (1.1 h from published) |

## IR-2026-01-08: Iran international shutdown and staged recovery

Window 2026-01-08 00:00 UTC → 2026-01-30 00:00 UTC · [IODA chart](https://ioda.inetintel.cc.gatech.edu/country/IR?from=1767830400&until=1769731200)

**What IODA published**

- Shutdown at 20:00 Iran time = 16:30 UTC on Jan 8 (IODA comparative analysis [I1])
- Active Probing later near 3% (IODA [I1])
- Telescope near zero by 18:45 UTC Jan 8 (IODA [I1])
- Telescope shows renewed traffic Jan 24; Active Probing recovers sharply Jan 27 (IODA [I1], updated page)

**What the detector found** (1 candidate; focus C1)

| Signal | Drop starts | Lowest | Recovers |
| --- | --- | --- | --- |
| BGP (routing) | 2026-01-08 18:00 UTC | 86.2% at 2026-01-08 21:00 UTC | 2026-01-18 18:30 UTC |
| Active probing | 2026-01-08 16:30 UTC | 3.3% at 2026-01-23 13:45 UTC | 2026-01-28 09:30 UTC |
| Network telescope | 2026-01-08 18:15 UTC | 0.0% at 2026-01-08 18:45 UTC | 2026-01-24 16:15 UTC |
| Google traffic | 2026-01-08 18:30 UTC | 0.0% at 2026-01-16 02:00 UTC | 2026-01-22 01:30 UTC |

Classification: **corroborated**. Glitch check: 1 other countries in the same minutes.

| Check | Result | Detector output |
| --- | --- | --- |
| Classified as corroborated | PASS | corroborated |
| Probing drop starts 2026-01-08 15:30Z – 2026-01-08 18:30Z | PASS | 2026-01-08 16:30 UTC |
| Probing lowest point < 6% of normal | PASS | 3.3% at 2026-01-23 13:45 UTC |
| Telescope lowest point < 15% of normal | PASS | 0.0% at 2026-01-08 18:45 UTC |
| Probing recovers within ±36 h of 2026-01-27 12:00Z | PASS | 2026-01-28 09:30 UTC (21.5 h from published) |

## HT-2026-10-27: Haiti multi-signal disruption

Window 2026-10-27 00:00 UTC → 2026-10-29 12:00 UTC · [IODA chart](https://ioda.inetintel.cc.gatech.edu/country/HT?from=1793059200&until=1793275200)

**What IODA published**

- Google traffic fell for 12 h from 17:30 UTC Oct 27; BGP dropped for 21 h from 17:50 UTC (IODA events via our Nov 12 2026 journalist brief)

**What the detector found** (2 candidates; focus C2)

| Signal | Drop starts | Lowest | Recovers |
| --- | --- | --- | --- |
| BGP (routing) | 2026-10-27 17:50 UTC | 87.4% at 2026-10-27 17:50 UTC | 2026-10-28 14:35 UTC |
| Active probing | 2026-10-27 17:20 UTC | 79.5% at 2026-10-28 07:30 UTC | 2026-10-28 14:40 UTC |
| Google traffic | 2026-10-27 18:00 UTC | 47.1% at 2026-10-27 21:00 UTC | 2026-10-28 11:00 UTC |

Classification: **corroborated**. Glitch check: 1 other countries in the same minutes.

| Check | Result | Detector output |
| --- | --- | --- |
| Classified as corroborated | PASS | corroborated |
| Dropped signals include bgp | PASS | bgp, ping-slash24, gtr |
| BGP drop starts 2026-10-27 16:30Z – 2026-10-28 06:00Z | PASS | 2026-10-27 17:50 UTC |

## GLITCH-2026-10-18: Negative control: platform-wide probing glitch (189 countries at 00:00 UTC Oct 18)

Window 2026-10-17 12:00 UTC → 2026-10-18 12:00 UTC · [IODA chart](https://ioda.inetintel.cc.gatech.edu/country/IE?from=1792238400&until=1792324800)

**What IODA published**

- 189 countries showed a 1-hour probing event starting at the same minute (IODA events API, our Nov 12 2026 analysis)

**What the detector found** (4 candidates; focus C3)

| Signal | Drop starts | Lowest | Recovers |
| --- | --- | --- | --- |
| Network telescope | 2026-10-18 05:40 UTC | 37.7% at 2026-10-18 05:40 UTC | 2026-10-18 06:00 UTC |
| Google traffic | 2026-10-18 05:00 UTC | 50.5% at 2026-10-18 05:00 UTC | 2026-10-18 06:00 UTC |

Classification: **corroborated**. Glitch check: 0 other countries in the same minutes.

| Check | Result | Detector output |
| --- | --- | --- |
| No real outage reported (glitch flagged) | FAIL | C1:single-signal (0 countries); C2:suspected-artifact (188 countries); C3:corroborated (0 countries); C4:single-signal (0 countries) |

## GU-2026-10-17: Exploratory: Guam probing-only disruption

Window 2026-10-16 12:00 UTC → 2026-10-21 12:00 UTC · [IODA chart](https://ioda.inetintel.cc.gatech.edu/country/GU?from=1792152000&until=1792584000)

**What IODA published**

- Probing daily median fell to 51% on Oct 18 and 76% on Oct 19; routing unaffected (IODA raw signals via our Nov 12 2026 journalist brief)

**What the detector found** (3 candidates; focus C1)

| Signal | Drop starts | Lowest | Recovers |
| --- | --- | --- | --- |
| Active probing | 2026-10-17 16:20 UTC | 19.6% at 2026-10-18 00:00 UTC | 2026-10-20 06:30 UTC |
| Google traffic | 2026-10-17 20:30 UTC | 65.3% at 2026-10-18 21:30 UTC | 2026-10-18 23:00 UTC |

Classification: **corroborated**. Glitch check: 0 other countries in the same minutes.

| Check | Result | Detector output |
| --- | --- | --- |
| Dropped signals include ping-slash24 | PASS | ping-slash24, gtr |
| Dropped signals exclude bgp | PASS | ping-slash24, gtr |
| Probing lowest point < 60% of normal | PASS | 19.6% at 2026-10-18 00:00 UTC |
