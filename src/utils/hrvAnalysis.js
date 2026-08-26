/**
 * HRV (heart rate variability) analysis engine — time domain.
 *
 * Pure, dependency-free: a validated NN sequence in, HRV metrics out.
 *
 * ARCHITECTURAL CONSTRAINT
 * This module has no R-peak detector and no access to raw ECG samples. Its only
 * input is the object produced by `prepareNnSequence` in ecgRrAnalysis.js, so it
 * is structurally incapable of building its own heartbeat sequence or of
 * bypassing the RR validation and signal-quality filtering that the ECG/RR
 * module applies. ECG/RR and HRV therefore always describe the same beats.
 *
 * SCOPE AND WORDING
 * HRV here is a measurement of the recorded interval timing, reported alongside
 * the duration and quality it was measured under. It is not a diagnosis and not
 * a score of "heart health". The module never labels a value healthy, abnormal,
 * stressed, or high/low against a population norm, because a wearable garment
 * recording of tens of seconds cannot support that claim.
 */

// -- Thresholds -------------------------------------------------------
// Tunable in one place, each with the reasoning behind the default.
const HRV_THRESHOLDS = {
  // pNN50 counts successive absolute NN differences above this (the conventional
  // 50 ms). Named so the variant thresholds (pNN20 etc.) are easy to add later.
  PNN_THRESHOLD_MS: 50,

  // Below this many valid NN intervals a standard deviation is not meaningful,
  // so the whole report is withheld rather than published as a weak number.
  MIN_NN_FOR_HRV: 20,

  // RMSSD and pNN50 need consecutive *pairs*. A recording can hold enough NN
  // intervals while holding too few unbroken pairs (heavy artifact scattered
  // through it), so pairs are gated separately.
  MIN_SUCCESSIVE_PAIRS: 10,

  // Shorter than this and there is nothing worth computing at all.
  MIN_ANALYSIS_DURATION_SEC: 10,

  // The conventional short-term HRV window is 5 minutes. Anything below this is
  // labelled an ultra-short recording, because its values are not interchangeable
  // with standard short-term HRV.
  SHORT_RECORDING_MAX_SEC: 300,

  // Ultra-short band explicitly supported and labelled (30-60 s and nearby).
  ULTRA_SHORT_MAX_SEC: 120,

  // Artifact share of the candidate intervals. Above the first bound the report
  // is marked Limited; above the second it is withheld entirely.
  MAX_ARTIFACT_PCT_ACCEPTABLE: 5,
  MAX_ARTIFACT_PCT_LIMITED: 20,
  MAX_ARTIFACT_PCT_USABLE: 50,

  // NN counts backing the quality bands.
  NN_COUNT_GOOD: 100,
  NN_COUNT_ACCEPTABLE: 50,

  // Personal baseline: how many prior sessions to draw on, and the minimum
  // needed before a baseline is offered at all.
  BASELINE_MIN_SESSIONS: 3,
  BASELINE_MAX_SESSIONS: 10,

  // A change from personal baseline smaller than this is reported as "in line
  // with" rather than as a change, since ultra-short HRV is noisy.
  BASELINE_MEANINGFUL_CHANGE_PCT: 15,

  // NN series returned for charting is downsampled to at most this many points.
  MAX_SERIES_POINTS: 1000,
};

const HRV_STATUS = {
  SUCCESS: 'success',
  INSUFFICIENT_DATA: 'insufficient_data',
  POOR_SIGNAL_QUALITY: 'poor_signal_quality',
  NO_DATA: 'no_data',
};

const HRV_QUALITY = {
  GOOD: 'Good',
  ACCEPTABLE: 'Acceptable',
  LIMITED: 'Limited',
  INSUFFICIENT: 'Insufficient',
};

// -- Numeric helpers --------------------------------------------------

function mean(values) {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function round(value, decimals = 0) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Sample standard deviation (n-1).
 *
 * SDNN conventionally uses the sample estimator, which is why this differs from
 * the population estimator behind the ECG/RR report's "RR SD". Over the hundreds
 * of intervals in a real recording the two agree to well under a percent; the
 * difference is documented rather than smoothed over so the two reports can be
 * reconciled.
 */
function sampleStdDev(values) {
  if (values.length < 2) return null;
  const m = mean(values);
  const variance = values.reduce((acc, v) => acc + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

// -- Successive differences -------------------------------------------

/**
 * Absolute differences between genuinely consecutive NN intervals.
 *
 * A pair is only used when the later interval was not preceded by a gap — i.e.
 * nothing was rejected between the two. Differencing across a removed artifact
 * would splice two moments of the recording together and manufacture
 * variability, which inflates RMSSD and pNN50 exactly where the signal was
 * worst. This is the single most important correctness detail in the module.
 *
 * @param {Array<{nnMs:number, precededByGap:boolean}>} nn
 * @returns {{diffs:number[], pairsSkipped:number}}
 */
function successiveDifferences(nn) {
  const diffs = [];
  let pairsSkipped = 0;

  for (let i = 1; i < nn.length; i += 1) {
    if (nn[i].precededByGap) {
      pairsSkipped += 1;
      continue;
    }
    diffs.push(Math.abs(nn[i].nnMs - nn[i - 1].nnMs));
  }

  return { diffs, pairsSkipped };
}

// -- Metrics ----------------------------------------------------------

/** SDNN: standard deviation of the NN intervals, in ms. */
function sdnn(nnValues) {
  return sampleStdDev(nnValues);
}

/**
 * RMSSD: root mean square of successive differences, in ms.
 * sqrt(mean(d^2)) over the absolute successive differences.
 */
function rmssd(diffs) {
  if (!diffs.length) return null;
  const meanSquare = diffs.reduce((acc, d) => acc + d * d, 0) / diffs.length;
  return Math.sqrt(meanSquare);
}

/**
 * pNN50: share of successive absolute NN differences exceeding the threshold,
 * as a percentage. Uses the absolute difference, per convention.
 */
function pnn(diffs, thresholdMs = HRV_THRESHOLDS.PNN_THRESHOLD_MS) {
  if (!diffs.length) return null;
  const above = diffs.filter((d) => d > thresholdMs).length;
  return (above / diffs.length) * 100;
}

// -- Quality ----------------------------------------------------------

/**
 * HRV confidence, combining the inputs that actually determine whether the
 * numbers mean anything: how much of the recording survived filtering, how many
 * intervals there are, how long the analysed window is, and the upstream ECG
 * signal quality.
 */
function hrvQuality({ artifactPercentage, nnCount, analysisDurationSec, ecgSignalQuality }) {
  if (
    nnCount < HRV_THRESHOLDS.MIN_NN_FOR_HRV ||
    artifactPercentage > HRV_THRESHOLDS.MAX_ARTIFACT_PCT_USABLE
  ) {
    return HRV_QUALITY.INSUFFICIENT;
  }

  // The upstream ECG assessment caps what HRV can claim: RR timing derived from
  // a poor trace cannot be better than the trace.
  if (ecgSignalQuality === 'Poor') return HRV_QUALITY.LIMITED;

  if (
    artifactPercentage <= HRV_THRESHOLDS.MAX_ARTIFACT_PCT_ACCEPTABLE &&
    nnCount >= HRV_THRESHOLDS.NN_COUNT_GOOD &&
    analysisDurationSec >= HRV_THRESHOLDS.ULTRA_SHORT_MAX_SEC &&
    (ecgSignalQuality === 'Good' || ecgSignalQuality === 'Fair')
  ) {
    return HRV_QUALITY.GOOD;
  }

  if (
    artifactPercentage <= HRV_THRESHOLDS.MAX_ARTIFACT_PCT_LIMITED &&
    nnCount >= HRV_THRESHOLDS.NN_COUNT_ACCEPTABLE
  ) {
    return HRV_QUALITY.ACCEPTABLE;
  }

  return HRV_QUALITY.LIMITED;
}

// -- Personal baseline ------------------------------------------------

/**
 * Compare against the user's own recent HRV, never against a population norm.
 *
 * @param {{rmssdMs:number|null, sdnnMs:number|null}} current
 * @param {Array<{rmssdMs:number, sdnnMs:number}>} priorSessions Prior *valid*
 *   HRV results for the same user, most recent first. The caller is responsible
 *   for having filtered these to successful analyses.
 */
function personalBaseline(current, priorSessions = []) {
  const usable = (priorSessions || []).filter(
    (s) => s && Number.isFinite(s.rmssdMs) && s.rmssdMs > 0
  );

  if (usable.length < HRV_THRESHOLDS.BASELINE_MIN_SESSIONS) {
    return {
      available: false,
      sessionsUsed: usable.length,
      sessionsRequired: HRV_THRESHOLDS.BASELINE_MIN_SESSIONS,
      baselineRmssdMs: null,
      baselineSdnnMs: null,
      rmssdChangePercent: null,
      comparison: null,
    };
  }

  const recent = usable.slice(0, HRV_THRESHOLDS.BASELINE_MAX_SESSIONS);

  // Median rather than mean: one artifact-heavy prior session should not drag
  // the personal reference around.
  const baselineRmssd = median(recent.map((s) => s.rmssdMs));
  const sdnnValues = recent.map((s) => s.sdnnMs).filter((v) => Number.isFinite(v));
  const baselineSdnn = sdnnValues.length ? median(sdnnValues) : null;

  let changePercent = null;
  let comparison = null;

  if (Number.isFinite(current.rmssdMs) && baselineRmssd > 0) {
    changePercent = ((current.rmssdMs - baselineRmssd) / baselineRmssd) * 100;
    comparison =
      Math.abs(changePercent) < HRV_THRESHOLDS.BASELINE_MEANINGFUL_CHANGE_PCT
        ? 'in_line'
        : changePercent > 0
          ? 'higher'
          : 'lower';
  }

  return {
    available: true,
    sessionsUsed: recent.length,
    sessionsRequired: HRV_THRESHOLDS.BASELINE_MIN_SESSIONS,
    baselineRmssdMs: round(baselineRmssd, 1),
    baselineSdnnMs: round(baselineSdnn, 1),
    rmssdChangePercent: round(changePercent, 1),
    comparison,
  };
}

// -- Narrative --------------------------------------------------------

/**
 * Patient-facing wording. Describes what was measured and under what conditions;
 * never grades the value.
 */
function buildPatientSummary({ quality, shortRecording, analysisDurationSec, baseline }) {
  const parts = [
    'Heart rate variability describes how much the time between your heartbeats naturally changes during the recording.',
  ];

  if (quality === HRV_QUALITY.GOOD || quality === HRV_QUALITY.ACCEPTABLE) {
    parts.push('The recording contained measurable beat-to-beat variation.');
  } else {
    parts.push(
      'The available recording contained limited clean heartbeat data, so these values should be read with caution.'
    );
  }

  if (shortRecording) {
    parts.push(
      `These values come from a short recording of about ${Math.round(
        analysisDurationSec
      )} seconds, so they reflect only that brief window and are not comparable to longer measurements.`
    );
  }

  if (baseline && baseline.available) {
    if (baseline.comparison === 'in_line') {
      parts.push('This is broadly in line with your own recent recordings.');
    } else if (baseline.comparison === 'higher') {
      parts.push('This is somewhat higher than your own recent recordings.');
    } else if (baseline.comparison === 'lower') {
      parts.push('This is somewhat lower than your own recent recordings.');
    }
  } else {
    parts.push(
      'A personal baseline is not available yet — it builds up once more recordings have been made.'
    );
  }

  parts.push(
    'These are measurements of the recorded signal, not a diagnosis or an assessment of health. Please discuss any concerns with a healthcare professional.'
  );

  return parts.join(' ');
}

/** Technical wording for clinical/engineering review. */
function buildTechnicalSummary({ metrics, counts, quality, durations, diffs, pairsSkipped }) {
  const fmt = (v, unit, dp = 1) => (v === null || v === undefined ? 'n/a' : `${round(v, dp)} ${unit}`);

  const lines = [
    `Time-domain HRV over ${counts.validNNIntervals} valid NN intervals (${fmt(
      durations.analysisDurationSec,
      's',
      1
    )} of analysed time within a ${fmt(durations.recordingDurationSec, 's', 0)} recording).`,
    `SDNN ${fmt(metrics.sdnnMs, 'ms')} (sample n-1 estimator, per HRV convention; the ECG/RR report's RR SD uses the population estimator, so the two differ marginally).`,
    `RMSSD ${fmt(metrics.rmssdMs, 'ms')} and pNN50 ${fmt(
      metrics.pnn50Percent,
      '%'
    )} over ${diffs} successive NN pairs; ${pairsSkipped} pair(s) spanning a rejected interval were excluded rather than differenced across the gap.`,
    `Mean NN ${fmt(metrics.meanNNMs, 'ms', 0)}, min ${fmt(metrics.minNNMs, 'ms', 0)}, max ${fmt(
      metrics.maxNNMs,
      'ms',
      0
    )}.`,
    `Interval accounting: ${counts.totalRRIntervals} candidate RR intervals, ${counts.validNNIntervals} accepted as NN, ${counts.excludedIntervals} excluded (${fmt(
      counts.artifactPercentage,
      '%',
      2
    )} artifact) — HRV confidence ${quality}.`,
  ];

  if (durations.shortRecording) {
    lines.push(
      `Recording is shorter than the conventional ${HRV_THRESHOLDS.SHORT_RECORDING_MAX_SEC} s short-term window; treat SDNN and pNN50 in particular as ultra-short estimates that are not interchangeable with standard short-term values.`
    );
  }

  lines.push(
    'NN intervals are consumed from the ECG/RR validation pipeline; this module performs no independent R-peak detection.'
  );
  lines.push(
    'RMSSD is commonly used as a short-term HRV measure associated with parasympathetic influence, but that interpretation depends on recording conditions and posture and is not asserted here.'
  );

  return lines.join(' ');
}

// -- Series -----------------------------------------------------------

function downsample(points, maxPoints) {
  if (points.length <= maxPoints) return points;
  const stride = Math.ceil(points.length / maxPoints);
  const out = points.filter((_, i) => i % stride === 0);
  const last = points[points.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

/** Cleaned NN sequence for charting. Contains only accepted intervals. */
function buildNnSeries(nn, firstRPeak) {
  const points = nn.map((entry) => ({
    offsetSec: round((entry.rPeakTimestamp - firstRPeak) / 1000, 3),
    rPeakTimestamp: entry.rPeakTimestamp,
    timestamp: entry.timestamp,
    nnMs: round(entry.nnMs),
  }));
  return downsample(points, HRV_THRESHOLDS.MAX_SERIES_POINTS);
}

// -- Orchestration ----------------------------------------------------

function unavailable(status, message, prepared, durations) {
  const counts = prepared.counts || {};
  const total = counts.beatsDetected || 0;
  const valid = counts.validBeats || 0;
  return {
    status,
    message,
    recording: {
      recordingDurationSec: durations.recordingDurationSec ?? null,
      analysisDurationSec: durations.analysisDurationSec ?? null,
      shortRecording: durations.shortRecording ?? null,
    },
    counts: {
      totalRRIntervals: total,
      validNNIntervals: valid,
      excludedIntervals: Math.max(0, total - valid),
      usablePercentage: total ? round((valid / total) * 100, 2) : null,
      artifactPercentage: total ? round(((total - valid) / total) * 100, 2) : null,
      successivePairs: 0,
    },
    // No metrics at all rather than zeroes — a zero SDNN is a claim, and an
    // absent one is the truth here.
    metrics: null,
    quality: HRV_QUALITY.INSUFFICIENT,
    baseline: { available: false },
    series: [],
    patientSummary: null,
    technicalSummary: null,
  };
}

/**
 * Run the time-domain HRV analysis.
 *
 * @param {object} prepared The object returned by `prepareNnSequence` in
 *   ecgRrAnalysis.js. Passing raw R peaks or ECG samples is deliberately not
 *   supported: HRV must consume the already-validated NN sequence.
 * @param {{recordingDurationSec?:number, priorSessions?:Array}} [options]
 * @returns {object} `status: 'success'` carries metrics; any other status carries
 *   a message and null metrics.
 */
function analyseHrv(prepared, options = {}) {
  if (!prepared || !Array.isArray(prepared.nn)) {
    throw new TypeError(
      'analyseHrv requires the prepared NN sequence from prepareNnSequence(); ' +
        'HRV must not derive its own heartbeat sequence.'
    );
  }

  const nn = prepared.nn;
  const nnValues = nn.map((entry) => entry.nnMs);

  const totalRRIntervals = prepared.counts.beatsDetected || 0;
  const validNNIntervals = nn.length;
  const excludedIntervals = Math.max(0, totalRRIntervals - validNNIntervals);
  const artifactPercentage = totalRRIntervals
    ? (excludedIntervals / totalRRIntervals) * 100
    : null;

  // Analysed time is the time the accepted intervals actually cover, which is
  // what the metrics were computed over — not the wall-clock recording length.
  const analysisDurationSec = nnValues.reduce((a, b) => a + b, 0) / 1000;
  const recordingDurationSec = options.recordingDurationSec ?? null;
  const shortRecording = analysisDurationSec < HRV_THRESHOLDS.SHORT_RECORDING_MAX_SEC;
  const ultraShort = analysisDurationSec < HRV_THRESHOLDS.ULTRA_SHORT_MAX_SEC;

  const durations = {
    recordingDurationSec,
    analysisDurationSec: round(analysisDurationSec, 1),
    shortRecording,
    ultraShortRecording: ultraShort,
  };

  if (!validNNIntervals) {
    return unavailable(
      HRV_STATUS.NO_DATA,
      'No clean heartbeat intervals are available for this session, so HRV cannot be calculated.',
      prepared,
      durations
    );
  }

  if (validNNIntervals < HRV_THRESHOLDS.MIN_NN_FOR_HRV) {
    return unavailable(
      HRV_STATUS.INSUFFICIENT_DATA,
      'Not enough clean heartbeat intervals to calculate reliable HRV.',
      prepared,
      durations
    );
  }

  if (analysisDurationSec < HRV_THRESHOLDS.MIN_ANALYSIS_DURATION_SEC) {
    return unavailable(
      HRV_STATUS.INSUFFICIENT_DATA,
      'The analysed portion of this recording is too short to calculate reliable HRV.',
      prepared,
      durations
    );
  }

  if (artifactPercentage !== null && artifactPercentage > HRV_THRESHOLDS.MAX_ARTIFACT_PCT_USABLE) {
    return unavailable(
      HRV_STATUS.POOR_SIGNAL_QUALITY,
      'HRV could not be reliably calculated because too much of the recording was affected by signal artifacts.',
      prepared,
      durations
    );
  }

  const { diffs, pairsSkipped } = successiveDifferences(nn);

  if (diffs.length < HRV_THRESHOLDS.MIN_SUCCESSIVE_PAIRS) {
    return unavailable(
      HRV_STATUS.INSUFFICIENT_DATA,
      'Not enough consecutive clean heartbeat intervals to calculate reliable HRV.',
      prepared,
      durations
    );
  }

  const metrics = {
    meanNNMs: round(mean(nnValues)),
    minNNMs: round(Math.min(...nnValues)),
    maxNNMs: round(Math.max(...nnValues)),
    sdnnMs: round(sdnn(nnValues), 1),
    rmssdMs: round(rmssd(diffs), 1),
    pnn50Percent: round(pnn(diffs), 1),
  };

  const ecgSignalQuality = prepared.signalQuality ? prepared.signalQuality.status : null;

  const quality = hrvQuality({
    artifactPercentage: artifactPercentage ?? 0,
    nnCount: validNNIntervals,
    analysisDurationSec,
    ecgSignalQuality,
  });

  const counts = {
    totalRRIntervals,
    validNNIntervals,
    excludedIntervals,
    usablePercentage: totalRRIntervals
      ? round((validNNIntervals / totalRRIntervals) * 100, 2)
      : null,
    artifactPercentage: round(artifactPercentage, 2),
    successivePairs: diffs.length,
    successivePairsSkipped: pairsSkipped,
  };

  const baseline = personalBaseline(metrics, options.priorSessions);

  return {
    status: HRV_STATUS.SUCCESS,
    message: null,
    recording: durations,
    counts,
    metrics,
    quality,
    ecgSignalQuality,
    baseline,
    series: buildNnSeries(nn, prepared.firstRPeak),
    patientSummary: buildPatientSummary({
      quality,
      shortRecording,
      analysisDurationSec,
      baseline,
    }),
    technicalSummary: buildTechnicalSummary({
      metrics,
      counts,
      quality,
      durations,
      diffs: diffs.length,
      pairsSkipped,
    }),
  };
}

module.exports = {
  analyseHrv,
  successiveDifferences,
  sdnn,
  rmssd,
  pnn,
  sampleStdDev,
  hrvQuality,
  personalBaseline,
  HRV_THRESHOLDS,
  HRV_STATUS,
  HRV_QUALITY,
};
