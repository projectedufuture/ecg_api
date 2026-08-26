# ECG Admin Panel — Backend API

REST API backend for the ECG Wearable Wellness Platform admin panel.

## Tech Stack

- **Runtime:** Node.js 20
- **Framework:** Express.js
- **Database:** MongoDB (Mongoose ODM)
- **Auth:** JWT (access + refresh token rotation)
- **Security:** Helmet, CORS, express-mongo-sanitize, rate limiting, bcrypt

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Create your .env (copy and edit)
cp .env.example .env

# 3. Make sure MongoDB is running, then seed the database
node seed.js

# 4. Start the server
npm run dev     # development (nodemon)
npm start       # production
```

The server runs on `http://localhost:3001` by default.

## Seed Data

The seed script creates data that matches the frontend mock data exactly:

| Collection | Count | Notes |
|------------|-------|-------|
| Admins     | 2     | super_admin + client_admin |
| Users      | 47    | Same names, emails, IDs as frontend |
| Devices    | 32    | Same IDs, firmware, license status |
| Sessions   | 64    | Same durations, data sources, HR data |
| Licenses   | 32    | One per device, matching status |
| Readings   | 38,400 | 600 per session (ECG + temperature) |

**Default credentials:**
- Super Admin: `admin@ecgplatform.com` / `Admin123!`
- Client Admin: `client@ecgplatform.com` / `Client123!`

## API Endpoints

All endpoints under `/api/admin`. All require JWT except login.

### Auth
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/admin/login` | Login, returns accessToken + sets refresh cookie |
| POST | `/api/admin/token/refresh` | Rotate tokens via httpOnly cookie |
| POST | `/api/admin/logout` | Clear refresh token |

### Users
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/admin/users` | Paginated list (search, filter, sort) |
| GET | `/api/admin/users/:id` | User detail with devices + sessions |
| PUT | `/api/admin/users/:id/deactivate` | Deactivate user (audit logged) |
| PUT | `/api/admin/users/:id/reactivate` | Reactivate user (audit logged) |

### Sessions (Readings)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/admin/readings` | Paginated session list |
| GET | `/api/admin/readings/:sessionId` | Full session with ECG/temp arrays |

### Reports
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/admin/readings/:sessionId/reports/ecg-rr` | Stored ECG/RR analysis for a session |
| POST | `/api/admin/readings/:sessionId/reports/ecg-rr/recalculate` | Recompute and persist it (idempotent) |
| GET | `/api/admin/readings/:sessionId/reports/hrv` | Stored time-domain HRV analysis |
| GET | `/api/admin/readings/:sessionId/reports/hrv/trend` | The user's HRV across their sessions |
| GET | `/api/admin/readings/:sessionId/reports/rhythm` | Rhythm screening for a session |
| GET | `/api/admin/readings/:sessionId/reports/respiration` | Respiration rate estimate |
| GET | `/api/admin/readings/:sessionId/reports/spo2` | SpO₂ trends and desaturation screening |
| GET | `/api/admin/readings/:sessionId/reports/temperature` | Temperature trends and excursions |
| GET | `/api/admin/readings/:sessionId/reports/combined` | Cross-signal relationships |

See [ECG/RR analysis](#ecgrr-analysis) and [HRV analysis](#hrv-analysis) below.

### Devices
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/admin/devices` | Paginated device list |
| GET | `/api/admin/devices/:id` | Device detail with license + sessions |
| PUT | `/api/admin/devices/:id/deactivate` | Deactivate (audit logged) |
| PUT | `/api/admin/devices/:id/reactivate` | Reactivate (audit logged) |
| POST | `/api/admin/devices/register` | Register new device (super_admin only) |

### Licenses
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/admin/licenses` | Paginated license list |
| POST | `/api/admin/licenses/generate` | Generate key for a device |
| PUT | `/api/admin/licenses/:id/activate` | Activate license |
| PUT | `/api/admin/licenses/:id/deactivate` | Deactivate license |

### Dashboard
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/admin/dashboard` | Summary metrics + trends |

### Export
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/admin/export/:type` | CSV download (users, devices, licenses, sessions) |

## Response Format

All endpoints return:

```json
{
  "success": true,
  "data": { ... },
  "error": null,
  "pagination": {
    "page": 1,
    "limit": 25,
    "total": 47,
    "totalPages": 2
  }
}
```

## RBAC

- **super_admin:** Full access to all data across all clients
- **client_admin:** Automatically scoped to their own `clientId`

## Project Structure

```
backend/
├── src/
│   ├── config/          db.js, env.js
│   ├── middleware/       auth.js, rbac.js, rateLimiter.js, auditLogger.js
│   ├── models/          Admin, User, Session, Reading, Device, License, AuditLog,
│   │                    EcgRrAnalysis, EcgRrEvent, HrvAnalysis,
│   │                    RhythmAnalysis, RhythmEvent, RespirationAnalysis,
│   │                    Spo2Analysis, Spo2Event, TemperatureAnalysis,
│   │                    TemperatureEvent, CombinedAnalysis
│   ├── routes/          adminAuth, users, sessions (+ reports), devices, licenses,
│   │                    dashboard, export
│   ├── controllers/     Matching controllers for each route
│   ├── services/        ecgRrService.js
│   ├── utils/           tokenUtils.js, csvExport.js, ecgRrAnalysis.js,
│   │                    hrvAnalysis.js, rhythmScreening.js,
│   │                    respirationAnalysis.js, signalSpectrum.js,
│   │                    spo2Analysis.js, temperatureAnalysis.js,
│   │                    combinedAnalysis.js, rPeakIngest.js
│   └── server.js
├── tests/               node:test unit tests (npm test)
├── seed.js
├── .env.example
└── package.json
```

## ECG/RR analysis

The first physiological report. It derives RR intervals from the R peaks the
wearable detects, screens them, and stores a per-session result that the Reports
UI reads.

### Device payload

Beat fields are **optional and additive** on every reading accepted by
`POST /api/app/readings` and `POST /api/app/sync`. Firmware that does not report
beats keeps working unchanged and is simply skipped by the RR pipeline.

```json
{
  "timestamp": "2026-08-24T10:30:00.800Z",
  "ecgValue": 985,
  "temperature": 36.6,
  "hr": 75,
  "spo2": 98,

  "beat": true,
  "rPeakTimestamp": 125430,
  "beatConfidence": 0.95,
  "leadOff": false
}
```

| Field | Device frame | Meaning |
|-------|--------------|---------|
| `beat` | `BEAT:<0\|1>` | The detector fired on this sample |
| `rPeakTimestamp` | `R_TIME:<ms>` | R peak on the device's monotonic ms clock |
| `beatConfidence` | — | Detector confidence, 0..1 |
| `leadOff` | `LEAD:<0\|1>` | Electrode off / poor contact |

`rPeakTimestamp` is what RR intervals are differenced from, because a monotonic
device counter avoids the wall-clock jitter `timestamp` carries. When a beat
arrives without one, the reading's own ISO `timestamp` is used instead — no
separate clock is introduced. The raw names (`BEAT`, `R_TIME`, `LEAD_OFF`) and
`leadOn` are also accepted, so the ESP-style frame can be forwarded with minimal
translation.

### Pipeline

```
R peaks → RR intervals → quality validation → HR / beat-to-beat / regularity
        → long-RR screening → persist (EcgRrAnalysis + EcgRrEvent) → report API
```

Analysis runs **once per recording**, not per request (`PUT /api/app/sessions/:id`
when a live recording stops, and after an offline sync). A late upload of new
beats drops the stored result so the next report request recomputes it, and a
session with no stored analysis is analysed lazily on first request. The GET
endpoint therefore normally just reads.

`src/utils/ecgRrAnalysis.js` holds all of the maths and no I/O, so it is unit
tested directly (`npm test`). Every threshold lives in the `THRESHOLDS` object at
the top of that file with the reasoning documented inline.

### RR quality classes

An unusual interval on a wearable is at least as likely to be a detection
artifact as a physiological event, so each interval is classified before it is
trusted, and artifact candidates are excluded from the statistics and the charts:

`valid` · `short_rr_candidate` · `long_rr_candidate` · `possible_missed_beat` ·
`possible_double_detection` · `invalid`

An interval near an integer multiple of the reference RR is reported as a
possible *missed detection* rather than a pause; a short interval that pairs with
its neighbour back into one beat is reported as a possible *double detection*.

### Scope

Screening and data quality only. The module describes the timing of detected R
peaks and deliberately never emits a rhythm classification (AF, arrhythmia,
ectopy) or the word "healthy". HRV parameters, waveform morphology, SpO₂ and
temperature analysis are out of scope here.

### Report availability

When a recording cannot support analysis the response sets `available: false`
with an `unavailableReason` (`no_data`, `insufficient_data`,
`poor_signal_quality`) and **omits the statistical blocks entirely** rather than
sending zeroes, so the UI shows the reason instead of an empty report. Beat
accounting and signal quality are still returned, because they are what explains
the outcome.

## HRV analysis

Time-domain heart rate variability, computed in the same pass as the ECG/RR
report and shown as the second section of a session report.

### It consumes the shared NN sequence — it does not derive its own

`prepareNnSequence()` in `ecgRrAnalysis.js` is the single source of truth for a
recording's heartbeats: it builds the RR intervals, classifies each one, and
returns the accepted subset as **NN intervals** (normal-to-normal). The service
calls it once and hands the result to both analysers:

```js
const prepared = prepareNnSequence(rPeaks);
const ecgRr = analyseEcgRr(prepared, { recordingDurationSec });
const hrv   = analyseHrv(prepared, { recordingDurationSec, priorSessions });
```

`analyseHrv()` accepts nothing else — passing raw R peaks or ECG samples throws.
There is no second R-peak detector and no path from raw ECG to HRV. Consequences:

- R-peak detection, artifact handling and missed/double-beat rules are identical
  for both reports.
- Mean/min/max NN in the HRV report always equal mean/min/max RR in the ECG/RR
  report, because they are the same numbers over the same set.
- Movement artifacts on a garment recording are excluded from HRV by the same
  filter that excludes them from the ECG/RR statistics.

On a wearable, `Raw ECG → HRV` would be wrong: an artifact becomes a false R
peak, which becomes a false RR, which silently corrupts SDNN and RMSSD. The
pipeline is always `Raw ECG → R peak → RR → validation → NN → HRV`.

### Metrics

| Metric | Definition |
|--------|------------|
| SDNN | Standard deviation of the NN intervals (ms) |
| RMSSD | Root mean square of successive NN differences (ms) |
| pNN50 | Share of successive **absolute** NN differences > 50 ms (%) |
| Mean / Min / Max NN | Over the accepted intervals (ms) |

Two details worth knowing:

- **SDNN uses the sample (n−1) estimator**, per HRV convention. The ECG/RR
  report's "RR SD" uses the population estimator, so over the same intervals the
  two differ marginally — by well under a percent at realistic interval counts.
  Documented rather than hidden so the two reports can be reconciled.
- **Successive differences never span a rejected interval.** When an artifact is
  removed, the intervals either side of it are not actually consecutive;
  differencing across the splice would invent variability exactly where the
  signal was worst, inflating RMSSD and pNN50. Such pairs are skipped and counted
  (`successivePairsSkipped`) rather than used.

### Duration is always reported

HRV interpretation depends heavily on how long was analysed, so every response
carries `recording.durationSec`, `recording.analysisDurationSec` and the valid NN
count. `analysisDurationSec` is the time the **accepted** intervals cover, not
the wall-clock recording length.

Recordings under the conventional 300 s short-term window are flagged
`shortRecording` (and under 120 s, `ultraShortRecording`). All three metrics are
still returned for a 30–60 s recording, but the UI labels them as ultra-short and
not interchangeable with standard short-term HRV.

### Availability

Rather than reporting `SDNN = 0`, the analysis is withheld with a status and a
message when the recording cannot support it:

| Status | Cause |
|--------|-------|
| `no_data` | No accepted NN intervals at all |
| `insufficient_data` | Fewer than 20 NN intervals, fewer than 10 unbroken successive pairs, or under 10 s analysed |
| `poor_signal_quality` | More than 50% of candidate intervals were artifact |

`quality` (`Good` / `Acceptable` / `Limited` / `Insufficient`) combines artifact
share, NN count, analysed duration and the upstream ECG signal quality — a poor
ECG trace caps HRV confidence at `Limited` no matter how many intervals there are.

### Personal baseline

Compared only against the same user's own earlier sessions, never a population
norm. Needs at least 3 prior successful analyses and uses the median of up to 10,
so one artifact-heavy session cannot drag the reference around. A change under
15% is reported as in line with the personal pattern rather than as a change.

The stored baseline reflects the sessions that existed when the analysis ran; if
earlier recordings are backfilled later, recalculating the session picks them up.

### Scope

Measurement and description only. The module never labels a value healthy,
abnormal, stressed or high/low, and the patient-facing text never mentions vagal
tone — the technical summary notes the parasympathetic association RMSSD is
commonly given, explicitly hedged on recording conditions. Frequency-domain HRV,
non-linear metrics and any diagnostic classification are out of scope.

## Rhythm screening

Flags potentially unusual heart-rate and RR-timing patterns for review. A
screening layer, not an ECG interpretation system.

Consumes the shared NN sequence and **reuses** the ECG/RR events — long-RR,
missed-beat and double-detection findings are carried over, never recomputed, so
there is exactly one pause detector in the codebase. Heart rate is derived from
the validated RR intervals (`60000 / NN`), not from the device's `HR` field,
because RR timing has higher resolution and `HR:0` is a sentinel.

### Findings

| Finding | Basis |
|---------|-------|
| Elevated heart-rate period | Sustained run above 100 BPM |
| Low heart-rate period | Sustained run below 60 BPM |
| Irregular RR period | Sliding-window CV ≥ 12% over a contiguous stretch |
| Possible long RR / missed beat / double detection | Carried over from ECG/RR |

The 100/60 BPM bounds are **resting screening references, not abnormality
thresholds** — activity raises heart rate and trained individuals rest below 60.
Every HR period is emitted with `requiresContext: true` and is called an
"elevated"/"low" period, never tachycardia or bradycardia. Artifact findings carry
`requiresQualityReview: true` so they are not read as physiological.

Events are **aggregated into periods**: a run must last ≥10 s and ≥8 beats to be
reported, so a two-minute elevated stretch is one event, not hundreds.

A quality gate runs first: below 60% usable beats no conclusion is drawn at all,
and the report returns `poor_signal_quality` with null statistics.

Nothing in the module can emit a rhythm diagnosis. There is no code path
producing AF, flutter, ectopy, block, PVC or PAC from RR timing.

## Respiration rate

Two independent estimators, cross-checked:

- **ECG-derived (EDR)** — respiratory sinus arrhythmia. The NN tachogram is
  resampled to 4 Hz, detrended, Hann-windowed, and a targeted DFT over
  0.1–0.5 Hz locates the dominant respiratory peak. `rate = f × 60`.
- **PPG-derived** — baseline modulation of the raw IR waveform, decimated to
  4 Hz (which also removes the ~1 Hz cardiac component), same spectral path.

Peak **prominence** (peak power ÷ mean band power) is what separates a real
respiratory rhythm from noise, and it drives the per-estimate quality grade.
Spectral resolution (~1/T) is reported alongside every rate, so the number is
never presented as more precise than the record length allows.

### Cross-check

Agreement within 3 breaths/min → the two estimates are averaged. Beyond that the
rate is **withheld** (`status: disagreement`) rather than picking one, because
choosing arbitrarily would present a coin flip as a measurement. With only one
estimator available the rate is reported and labelled `ecg_only` / `ppg_only`.

12–20 breaths/min is a **plausibility check** for resting adults, not an
abnormality threshold; a rate outside it lowers confidence and is labelled, never
flagged as abnormal. Outside 5–35 the estimate is suppressed entirely.

### Gates

Needs ≥60 s of clean signal (resolution ≈ 1 breath/min) and ≥40 NN intervals;
above 30% artifact the estimate is withheld. The windowed trend keeps unreliable
windows with `usable: false` and a null rate rather than interpolating across
them, so the chart shows where the estimate could not be trusted.

Respiration is **never** inferred from the SpO₂ percentage — that value carries no
waveform. When no raw PPG exists the report says exactly that.

## Device payload: RR, QUALITY and raw PPG

| Field | Device | Meaning |
|-------|--------|---------|
| `rrIntervalMs` | `RR:<ms>` | Last known RR, repeated every packet |
| `ecgQuality` | `QUALITY:<0\|1>` | 0 = firmware considers the ECG unusable |
| `ppgIr` / `ppgRed` | `IR` / `RED` | Raw PPG waveform |

**`BEAT:0` packets never create an RR interval.** The firmware repeats its last
`RR` on every packet, so appending it per packet would flood the sequence with
duplicates and corrupt every rhythm and HRV statistic. Only an explicit `BEAT:1`
(or a precise `R_TIME`) marks a new beat.

### Sentinels and assumptions

`HR:0`, `SPO2:0` and `RR:-1` mean "not measured" and are stored as null, so no
average can be dragged toward zero by them.

Two interpretations are **assumptions, not confirmed facts**, both isolated to one
constant each in `src/utils/rPeakIngest.js`:

- `LEAD:1` is read as *electrode connected*, inferred from the sample frame
  `LEAD:1, BEAT:1` (a beat cannot be detected on a detached electrode). Flip
  `LEAD_ONE_MEANS_CONNECTED` if the firmware means the opposite. Explicit
  `leadOff` / `leadOn` fields always override it.
- `QUALITY:0` means unusable ECG.

Confirm both against the firmware source before relying on them.

## SpO₂ analysis

Saturation trends and desaturation screening from the stored `spo2` readings.

`SPO2:0` is the firmware's "not measured" sentinel and is excluded, as is
anything outside 50–100%, so no average is ever dragged toward zero by a gap.

**Desaturation detection** compares each sample against a 120 s **rolling median**
baseline — a median so a dip cannot drag its own baseline down and hide itself,
and rolling so a slow drift over a long recording is followed rather than read as
one enormous event. A drop of ≥3% must persist 10–180 s to count; results are
reported at both the 3% and the stricter 4% criterion so a reviewer sees each.

Every event records whether saturation **recovered** to baseline. One that never
does is flagged for a sensor check rather than a physiological drop: that pattern
is much more often a contact change. Time below 90% and 88% is reported over the
usable portion only, and gaps longer than 30 s are excluded rather than charged
to either level.

Withheld as `poor_signal_quality` below 40% sensor coverage, and
`insufficient_data` under 60 usable samples or 60 s.

**Scope:** a reflectance PPG on a moving wearer produces motion artifacts
indistinguishable from a true desaturation on the saturation trace alone. Events
are for review; no oxygenation diagnosis is inferred.

## Temperature analysis

### What this sensor actually measures

A thermistor in a garment reads **skin** temperature, not core. Real recordings
from this device sit around 30–34 °C, which is normal for skin and would be
profound hypothermia as a core reading.

So this module **never applies a fever threshold**. A fixed 38 °C rule would be
doubly wrong: it would never fire on skin-range data, and if it did it would be
measuring the wrong thing. Instead it:

1. **classifies the measurement regime** (`Surface / skin range`,
   `Body-temperature range`, `Mixed range`) so the report states what it is
   looking at, and the UI shows that as a banner;
2. reports absolute values, trend and drift as measured;
3. flags excursions **relative to the recording's own baseline**, which is
   meaningful in either regime — absolute skin temperature depends on sensor
   placement, garment fit and ambient conditions, none of which is knowable here.

Trend is measured on the medians of the first and last tenth of the recording, so
a single noisy sample at either end cannot invent one. Excursions need ≥0.5 °C
sustained ≥60 s against a 300 s rolling median.

The patient text states plainly that the reading should not be used to check for
a fever, and the technical text records that no fever threshold is applied.

## Combined physiological analysis

Cross-references heart rate, SpO₂ and temperature.

**Synchronisation is free here:** every signal comes from the same `Reading`
rows, so they share one timestamp by construction. HR is the exception — it comes
from R-peak timing — so it is resampled onto the reading rows by nearest
neighbour within 2 s, with **no interpolation across rejected beats**: a row in a
gap gets no HR rather than an invented one.

Each of the three pairings gets a Pearson correlation, reported with the **number
of synchronised pairs behind it**, so a coefficient can never be read without its
evidence. A pairing with fewer than 60 pairs, or where one signal did not vary,
is returned as `available: false` **with the reason** rather than omitted — and
that includes the case where nothing at all could be described, because the
reasons are then the most useful output the module has.

Concurrent findings list moments where events from different modules overlap
within 30 s. They are reported, never interpreted.

**Scope:** correlation is not causation, and on a wearable a shared motion
artifact produces the same signature as a shared physiological response. The two
cannot be separated from these signals alone, and the report says so.

---

## Location: coordinates to place names

The app posts coordinates when it opens (`PUT /api/app/users/me/location`) and
may include them when starting a session. Coordinates alone are not readable —
`17.4351, 78.4520` tells an admin nothing — so the backend resolves them to a
place name and stores it in the `address` field that both `User.lastLocation`
and `Session.location` already carry.

### The request never waits on it

Reverse geocoding needs an outbound call to a third-party service, which may be
slow or down. That must never slow down or fail a location update, so the write
path only ever reads the cache:

| Step | What happens | Network |
|---|---|---|
| App posts a location | cached name attached if the place is already known | none |
| Response sent | app is done | — |
| Background | unknown places resolved, then written back to the document | one request |

The admin UI polls with SWR, so a name resolved in the background appears within
a few seconds without anyone reloading.

An address supplied **by the client** is always kept as-is; only a `null`
address is ever filled in. Coordinates are never modified.

### One lookup per place, not per ping

Results are cached in the `geocodecaches` collection, keyed by coordinates
rounded to 4 decimal places (~11 m). A user who opens the app fifty times from
home costs **one** upstream request, not fifty, because GPS jitter below that
resolution maps to the same key. "There is no place here" (mid-ocean, and the
like) is cached too, so a barren coordinate is not retried forever. Entries
expire after `GEOCODING_CACHE_TTL_DAYS` so renamed streets eventually refresh.

Transient failures — provider down, rate limited, timed out — are held in memory
for 10 minutes instead of being cached, so a blip never persists as a wrong
"no such place" answer.

### Label shape

Labels are built for a narrow table column: locality plus city
(`Somajiguda, Hyderabad`), falling back through city + region and finally
region + country, so even a remote coordinate reads better than raw numbers.

Administrative names are filtered out, because a council district is not a place
a person recognises:

| Upstream value | Label | Why |
|---|---|---|
| `Ward 97 Somajiguda` | `Somajiguda, Hyderabad` | ward number stripped |
| `L Ward` | `Mumbai, Maharashtra` | designator only — skipped |
| `Mumbai Zone 5` | `Mumbai, Maharashtra` | municipal zone — skipped |
| `Sector 17` | `Sector 17, Chandigarh` | **kept** — a real place name |

`sector` is deliberately never treated as bookkeeping: sector numbers are the
everyday names of places in Chandigarh, Noida and Gurugram.

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `GEOCODING_PROVIDER` | `nominatim` | `nominatim`, `google`, or `none` to disable |
| `GOOGLE_MAPS_API_KEY` | — | required when the provider is `google` |
| `GEOCODING_USER_AGENT` | `BiotexAdmin/1.0 (+…)` | **set this** — Nominatim blocks unidentified clients |
| `GEOCODING_MIN_INTERVAL_MS` | `1100` | minimum gap between upstream requests |
| `GEOCODING_CACHE_TTL_DAYS` | `90` | how long a resolved name is reused |
| `GEOCODING_TIMEOUT_MS` | `6000` | per-request timeout |
| `GEOCODING_LANGUAGE` | `en` | language for returned names |

The default provider is **Nominatim (OpenStreetMap)**, which needs no API key.
Its usage policy caps requests at one per second, which the code enforces by
serialising every lookup through a single queue — this is a correctness
constraint, not politeness, since exceeding it can get a deployment blocked. For
high volume, switch to `google` or a self-hosted Nominatim via `NOMINATIM_URL`.

**Privacy:** resolving a name sends the coordinates to the configured provider.
Set `GEOCODING_PROVIDER=none` to keep them entirely in-house; the UI then shows
coordinates, exactly as it did before.

### Backfilling existing rows

Coordinates stored before this existed have no name. Fill them in with:

```bash
node scripts/backfill-addresses.js --dry-run   # report only, no writes
node scripts/backfill-addresses.js             # resolve and save
node scripts/backfill-addresses.js --limit 50  # cap upstream lookups
node scripts/backfill-addresses.js --force     # also redo names already set
```

It only touches documents whose address is `null` (unless `--force`), never
modifies coordinates, and shares the cache — so many documents at the same place
cost one lookup. Distinct places take about a second each, by design.

---

## App report API

The phone reads reports through `/api/app/reports`, authenticated with the app
access token (`Authorization: Bearer <token>`).

| Endpoint | Returns |
|---|---|
| `GET /api/app/reports/sessions` | the user's recordings, newest first, with the state of their reports (`?limit=` 1-100, default 25) |
| `GET /api/app/reports/:sessionId` | headline numbers for all seven modules in one request |
| `GET /api/app/reports/:sessionId/:module` | one module in full, charts and events included |

`:module` is one of `ecg-rr`, `hrv`, `rhythm`, `respiration`, `spo2`,
`temperature`, `combined` — the same names the admin API uses.

### Authorization

Every lookup is scoped to the token's own `userId`. A session id belonging to
another user returns **404**, identical to an id that does not exist — so the
endpoint never confirms that someone else's session exists. The analysis
collections are never queried by `sessionId` alone.

### Why there are two levels

A full seven-module report is around **300 KB**; the overview of the same
recording is **1.6 KB**. Pushing the per-sample series and event lists down a
mobile connection to render a summary screen is the wrong trade, so the overview
omits them and the app fetches a module in full only when the user opens it.

The overview is a *projection of the same mapped response* the detail endpoint
returns, not a separately-computed summary — so the two can never disagree about
a number. Measured in the test suite: app and admin return **byte-identical**
bodies for all seven modules.

### Generation state

When the reports are not readable, the endpoints answer **HTTP 200** with the
reason rather than an error, because nothing has gone wrong:

| `reportStatus` | `unavailableReason` | What the app should do |
|---|---|---|
| `not_started` | `recording_not_finished` | the recording is still running |
| `pending` / `generating` | `generation_in_progress` | poll; `retryAfterSec` hints how soon |
| `ready` | — | render the report |
| `too_short` | `session_too_short` | show the minimum-length message |
| `failed` | `generation_failed` | offer a retry |

A `failed` response carries a generic message: the underlying error can name
internal collections and is of no use on a patient's phone. The detail stays in
the session's `reportError` for operators.

## Report generation lifecycle

Reports are derived when a **recording finishes** — not when someone opens the
report page. Analysis runs once per session and is stored; the report endpoints
then only read it.

### Minimum recording length

**A recording shorter than five minutes generates no reports at all.** Below
that length the numbers would be arithmetically computable but not meaningful,
and publishing them invites a reader to trust a two-minute snapshot.

The session is marked `too_short` and every report endpoint answers **HTTP 200**
with the rule — not an error, because nothing went wrong:

```json
{
  "reportStatus": "too_short",
  "available": false,
  "unavailableReason": "session_too_short",
  "recordingDurationSec": 120,
  "minimumDurationSec": 300,
  "message": "No reports were generated for this recording. It lasted 2m, and reports require at least 5m of recording."
}
```

The admin UI renders one calm panel for the whole page instead of seven
"unavailable" cards, and offers no Download PDF button.

Two details that matter:

- **The length is measured from the timestamps, never from `Session.duration`,**
  which is stored in whole minutes. A 4 m 40 s recording rounds to 5 and would
  slip past a gate placed on that field.
- **The rule lives at the single generation choke point,** so every trigger
  honours it. Placed only in the stop handler, simply opening the report page
  would lazily generate the reports the rule had just refused — including an
  explicit `recalculate`.

A recording whose length cannot be determined (unparsable timestamps) is *not*
refused: withholding reports because a timestamp failed to parse would hide real
data. Relatedly, a client-supplied `endTime` that precedes the start is replaced
with the server clock rather than stored, since contradictory timestamps make
the length unknowable.

Change the threshold with `MIN_REPORT_SESSION_SEC` (seconds).

### Triggers

| Event | What happens |
|---|---|
| `PUT /api/app/sessions/:id` (stop) | session marked `pending`, response returned, generation runs immediately after |
| `POST /api/app/sync` | generation runs for each session that carried beats |
| `POST /api/app/readings` with new beats | stored reports discarded, session marked `pending` again |
| `GET .../reports/*` with no stored report | generated on demand as a safety net |
| `POST .../reports/ecg-rr/recalculate` | forced regeneration |

### Stopping never waits for analysis

Generation is queued to run **after** the stop response is sent. The session is
already saved by that point, and a client timeout on the stop request would
otherwise make the app believe the recording had failed when it had not.
Measured: a 150 s recording of 4800 readings stops in **69 ms** and its reports
are complete a moment later, with no further request from the app.

### `reportStatus` on the session

Every session carries the state of its own report generation, returned by the
session and report endpoints alike:

| Status | Meaning |
|---|---|
| `not_started` | the recording has not finished yet |
| `pending` | finished; generation queued |
| `generating` | generation in progress |
| `ready` | the pipeline ran to completion |
| `failed` | generation threw; `reportError` says why |
| `too_short` | the recording was below the minimum length; nothing was generated |

Alongside it: `reportGeneratedAt` and `reportError`, plus `reportAttempts` so a
session stuck in a retry loop is visible.

**`ready` means the pipeline ran, not that every module produced numbers.**
Whether an individual report is usable stays that report's own
`available`/`status` field — a session with no beats recorded generates
successfully and then correctly reports ECG/RR as unavailable.

This distinction is the reason the status exists. Without it, "not generated
yet", "generated and genuinely empty", and "generation crashed" all rendered as
the same empty report, and a crash left no trace anywhere.
