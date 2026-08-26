/**
 * SpO2 (peripheral oxygen saturation) analysis.
 *
 * Pure functions: a timestamped SpO2 series in, trends and desaturation events
 * out. No I/O, so the whole thing is unit testable.
 *
 * SCOPE AND WORDING
 * A measurement and screening layer. It describes saturation over the recording
 * and flags drops for review; it never diagnoses hypoxaemia, sleep apnoea or
 * respiratory disease. A garment/finger PPG on a moving wearer produces motion
 * artifacts that look exactly like desaturations, which is why every drop is
 * reported as an event to review rather than a physiological conclusion.
 *
 * SENTINELS
 * `SPO2:0` means "not measured", not 0% saturation. The caller is expected to
 * have filtered those out already (see normalizeVitals); this module also drops
 * anything outside the plausible 50-100% band as a further guard.
 */

// -- Thresholds -------------------------------------------------------
const SPO2_THRESHOLDS = {
  /**
   * Physiologically plausible band for a wearable reading. Below 50% the sensor
   * is almost certainly not on skin; above 100% is impossible.
   */
  MIN_PLAUSIBLE_PCT: 50,
  MAX_PLAUSIBLE_PCT: 100,

  /**
   * Desaturation depth below the local baseline. 3% is the conventional
   * screening threshold; 4% is the stricter variant, reported alongside it so a
   * reviewer can see both without re-running anything.
   */
  DESAT_DROP_PCT: 3,
  DESAT_DROP_STRICT_PCT: 4,

  /** A drop must persist this long to count, which rejects single-sample spikes. */
  DESAT_MIN_DURATION_SEC: 10,
  /** And must not run longer than this without recovering, or it is a level shift. */
  DESAT_MAX_DURATION_SEC: 180,

  /** Baseline is the rolling median over this window, in seconds. */
  BASELINE_WINDOW_SEC: 120,

  /** Recovery = back to within this margin of the pre-drop baseline. */
  RECOVERY_MARGIN_PCT: 1,

  /** Absolute levels reported as time-below, not as findings. */
  LOW_LEVEL_PCT: 90,
  VERY_LOW_LEVEL_PCT: 88,

  /** Stability banding on the standard deviation of the usable series. */
  STABILITY_STABLE_SD: 1.0,
  STABILITY_MODERATE_SD: 2.5,

  // Availability gates.
  MIN_SAMPLES: 60,
  MIN_DURATION_SEC: 60,
  /** Usable share of the recording required before conclusions are drawn. */
  MIN_COVERAGE_PCT: 40,

  MAX_SERIES_POINTS: 1000,
};

const SPO2_STATUS = {
  SUCCESS: 'success',
  INSUFFICIENT_DATA: 'insufficient_data',
  POOR_SIGNAL_QUALITY: 'poor_signal_quality',
  NO_DATA: 'no_data',
};

const SPO2_EVENT_TYPE = {
  DESATURATION: 'possible_desaturation',
  LOW_SATURATION_PERIOD: 'low_saturation_period',
  SIGNAL_GAP: 'signal_gap',
};

const STABILITY = {
  STABLE: 'Stable',
  MODERATE: 'Moderately variable',
  VARIABLE: 'Variable',
  UNAVAILABLE: 'Unavailable',
};

// -- helpers ----------------------------------------------------------

function round(v, d = 0) {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

function mean(a) {
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
}

function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function stdDev(a) {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((acc, v) => acc + (v - m) ** 2, 0) / a.length);
}

function downsample(points, max) {
  if (points.length <= max) return points;
  const stride = Math.ceil(points.length / max);
  const out = points.filter((_, i) => i % stride === 0);
  const last = points[points.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

/**
 * Keep only samples that could be a real saturation reading.
 *
 * @param {Array<{t:number, spo2:number|null}>} samples `t` in seconds.
 */
function usableSamples(samples) {
  return (samples || []).filter(
    (s) =>
      s &&
      Number.isFinite(s.t) &&
      Number.isFinite(s.spo2) &&
      s.spo2 >= SPO2_THRESHOLDS.MIN_PLAUSIBLE_PCT &&
      s.spo2 <= SPO2_THRESHOLDS.MAX_PLAUSIBLE_PCT
  );
}

/**
 * Rolling-median baseline.
 *
 * A median rather than a mean so a desaturation does not drag its own baseline
 * down and hide itself, and rolling rather than global so a slow drift over a
 * long recording is followed instead of being read as one huge event.
 */
function rollingBaseline(samples, windowSec = SPO2_THRESHOLDS.BASELINE_WINDOW_SEC) {
  const half = windowSec / 2;
  return samples.map((s, i) => {
    const window = [];
    // Walk outwards from i while inside the window.
    for (let j = i; j >= 0 && s.t - samples[j].t <= half; j -= 1) window.push(samples[j].spo2);
    for (let j = i + 1; j < samples.length && samples[j].t - s.t <= half; j += 1) {
      window.push(samples[j].spo2);
    }
    return median(window);
  });
}

// -- Desaturation detection -------------------------------------------

/**
 * Find sustained drops below the rolling baseline.
 *
 * Each event records its nadir, depth, duration and whether saturation returned
 * to baseline (recovery), because a drop that never recovers is more likely a
 * sensor shift than a physiological desaturation.
 */
function findDesaturations(samples, baseline, dropPct = SPO2_THRESHOLDS.DESAT_DROP_PCT) {
  const events = [];
  let run = null;

  for (let i = 0; i < samples.length; i += 1) {
    const base = baseline[i];
    const below = base !== null && base - samples[i].spo2 >= dropPct;

    if (below) {
      if (!run) run = { from: i, baselineAtStart: base };
      run.to = i;
      continue;
    }

    if (run) {
      finish(run, i);
      run = null;
    }
  }
  if (run) finish(run, samples.length - 1);

  function finish(r, recoveryIndex) {
    const slice = samples.slice(r.from, r.to + 1);
    const durationSec = slice[slice.length - 1].t - slice[0].t;
    if (
      durationSec < SPO2_THRESHOLDS.DESAT_MIN_DURATION_SEC ||
      durationSec > SPO2_THRESHOLDS.DESAT_MAX_DURATION_SEC
    ) {
      return;
    }

    const values = slice.map((s) => s.spo2);
    const nadir = Math.min(...values);
    const recovered =
      recoveryIndex < samples.length &&
      samples[recoveryIndex].spo2 >= r.baselineAtStart - SPO2_THRESHOLDS.RECOVERY_MARGIN_PCT;

    events.push({
      eventType: SPO2_EVENT_TYPE.DESATURATION,
      startSec: round(slice[0].t, 1),
      endSec: round(slice[slice.length - 1].t, 1),
      durationSec: round(durationSec, 1),
      timestamp: slice[0].timestamp || null,
      baselinePct: round(r.baselineAtStart, 1),
      nadirPct: round(nadir, 1),
      dropPct: round(r.baselineAtStart - nadir, 1),
      recovered,
      recoverySec: recovered
        ? round(samples[recoveryIndex].t - slice[slice.length - 1].t, 1)
        : null,
      samples: slice.length,
      description: recovered
        ? `Saturation fell ${round(
            r.baselineAtStart - nadir,
            1
          )}% below its local baseline to ${round(nadir, 1)}% for ${round(
            durationSec
          )} s, then returned to baseline. Motion artifact can produce the same pattern; signal review recommended.`
        : `Saturation fell ${round(
            r.baselineAtStart - nadir,
            1
          )}% below its local baseline to ${round(nadir, 1)}% for ${round(
            durationSec
          )} s without returning to baseline, which more often indicates a sensor or contact change than a physiological drop.`,
    });
  }

  return events;
}

/** Sustained stretches below an absolute level, aggregated into periods. */
function findLowPeriods(samples, levelPct) {
  const periods = [];
  let run = [];

  const flush = () => {
    if (run.length > 1) {
      const durationSec = run[run.length - 1].t - run[0].t;
      if (durationSec >= SPO2_THRESHOLDS.DESAT_MIN_DURATION_SEC) {
        const values = run.map((s) => s.spo2);
        periods.push({
          eventType: SPO2_EVENT_TYPE.LOW_SATURATION_PERIOD,
          startSec: round(run[0].t, 1),
          endSec: round(run[run.length - 1].t, 1),
          durationSec: round(durationSec, 1),
          timestamp: run[0].timestamp || null,
          thresholdPct: levelPct,
          nadirPct: round(Math.min(...values), 1),
          meanPct: round(mean(values), 1),
          samples: run.length,
          description: `Saturation stayed below ${levelPct}% for ${round(
            durationSec
          )} s (lowest ${round(Math.min(...values), 1)}%). Reported as measured; confirm sensor contact before interpreting.`,
        });
      }
    }
    run = [];
  };

  for (const s of samples) {
    if (s.spo2 < levelPct) run.push(s);
    else flush();
  }
  flush();

  return periods;
}

/** Fraction of the analysed time spent below a level. */
function timeBelow(samples, levelPct) {
  if (samples.length < 2) return { seconds: 0, percent: 0 };
  let below = 0;
  let total = 0;
  for (let i = 1; i < samples.length; i += 1) {
    const dt = samples[i].t - samples[i - 1].t;
    // Ignore huge gaps: they are missing data, not time spent at a level.
    if (dt <= 0 || dt > 30) continue;
    total += dt;
    if (samples[i].spo2 < levelPct) below += dt;
  }
  return { seconds: round(below, 1), percent: total > 0 ? round((below / total) * 100, 2) : 0 };
}

function classifyStability(sd) {
  if (sd === null) return STABILITY.UNAVAILABLE;
  if (sd <= SPO2_THRESHOLDS.STABILITY_STABLE_SD) return STABILITY.STABLE;
  if (sd <= SPO2_THRESHOLDS.STABILITY_MODERATE_SD) return STABILITY.MODERATE;
  return STABILITY.VARIABLE;
}

// -- Narrative --------------------------------------------------------

function buildPatientSummary({ stats, stability, desaturations, lowPeriods, coveragePct }) {
  const parts = [
    'This section describes the oxygen saturation measured by the pulse sensor during the recording.',
  ];

  parts.push(
    `Saturation averaged ${round(stats.mean, 1)}% and ranged from ${round(
      stats.min,
      1
    )}% to ${round(stats.max, 1)}%.`
  );

  if (stability === STABILITY.STABLE) {
    parts.push('The readings stayed steady through the recording.');
  } else {
    parts.push('The readings varied during the recording.');
  }

  if (desaturations > 0) {
    parts.push(
      `${desaturations} short dip${
        desaturations === 1 ? '' : 's'
      } in saturation ${desaturations === 1 ? 'was' : 'were'} observed. Movement can cause the sensor to read low, so dips like these need to be checked against the signal before they are taken as real.`
    );
  }

  if (lowPeriods > 0) {
    parts.push(
      'Saturation was measured below the usual resting range for part of the recording.'
    );
  }

  if (coveragePct !== null && coveragePct < 70) {
    parts.push(
      `The sensor produced a usable reading for only about ${Math.round(
        coveragePct
      )}% of the recording, so these values describe part of it rather than all of it.`
    );
  }

  parts.push(
    'These are measurements from the recorded signal, not a diagnosis. Please discuss any concerns with a healthcare professional.'
  );

  return parts.join(' ');
}

function buildTechnicalSummary({
  stats,
  stability,
  counts,
  desaturations,
  strictDesaturations,
  lowPeriods,
  below90,
  below88,
}) {
  const f = (v, u, d = 1) => (v === null || v === undefined ? 'n/a' : `${round(v, d)}${u}`);

  return [
    `SpO2: mean ${f(stats.mean, '%')}, median ${f(stats.median, '%')}, min ${f(
      stats.min,
      '%'
    )}, max ${f(stats.max, '%')}, SD ${f(stats.sd, '%', 2)} — stability ${stability}.`,
    `Coverage: ${counts.usableSamples}/${counts.totalSamples} samples usable (${f(
      counts.coveragePct,
      '%',
      2
    )}) over ${f(counts.analysedDurationSec, ' s', 0)}; samples outside ${
      SPO2_THRESHOLDS.MIN_PLAUSIBLE_PCT
    }-${SPO2_THRESHOLDS.MAX_PLAUSIBLE_PCT}% and the 0 sentinel were excluded.`,
    `Desaturations: ${desaturations} at the ${SPO2_THRESHOLDS.DESAT_DROP_PCT}% criterion, ${strictDesaturations} at the stricter ${SPO2_THRESHOLDS.DESAT_DROP_STRICT_PCT}% criterion, against a ${SPO2_THRESHOLDS.BASELINE_WINDOW_SEC} s rolling median baseline and requiring ${SPO2_THRESHOLDS.DESAT_MIN_DURATION_SEC}-${SPO2_THRESHOLDS.DESAT_MAX_DURATION_SEC} s duration.`,
    `Time below ${SPO2_THRESHOLDS.LOW_LEVEL_PCT}%: ${f(below90.seconds, ' s', 0)} (${f(
      below90.percent,
      '%',
      2
    )}); below ${SPO2_THRESHOLDS.VERY_LOW_LEVEL_PCT}%: ${f(below88.seconds, ' s', 0)} (${f(
      below88.percent,
      '%',
      2
    )}). ${lowPeriods} sustained low-saturation period(s).`,
    'Screening output only. A reflectance PPG on a moving wearer produces motion artifacts indistinguishable from true desaturation on the saturation trace alone, so events are for review and no oxygenation diagnosis is inferred.',
  ].join(' ');
}

// -- Orchestration ----------------------------------------------------

function unavailable(status, message, counts) {
  return {
    status,
    message,
    summary: null,
    stability: STABILITY.UNAVAILABLE,
    counts,
    events: [],
    series: [],
    patientSummary: null,
    technicalSummary: null,
  };
}

/**
 * Run the SpO2 analysis.
 *
 * @param {Array<{t:number, spo2:number|null, timestamp?:string}>} samples
 *   `t` in seconds from the start of the recording.
 * @param {{recordingDurationSec?:number}} [options]
 */
function analyseSpo2(samples, options = {}) {
  const total = (samples || []).length;
  const usable = usableSamples(samples);

  const analysedDurationSec = usable.length > 1 ? usable[usable.length - 1].t - usable[0].t : 0;
  const coveragePct = total > 0 ? round((usable.length / total) * 100, 2) : null;

  const counts = {
    totalSamples: total,
    usableSamples: usable.length,
    excludedSamples: total - usable.length,
    coveragePct,
    analysedDurationSec: round(analysedDurationSec, 1),
    recordingDurationSec: options.recordingDurationSec ?? null,
  };

  if (!usable.length) {
    return unavailable(
      SPO2_STATUS.NO_DATA,
      'No usable SpO₂ readings are available for this session. The sensor reported the "not measured" value throughout.',
      counts
    );
  }

  if (usable.length < SPO2_THRESHOLDS.MIN_SAMPLES) {
    return unavailable(
      SPO2_STATUS.INSUFFICIENT_DATA,
      'Not enough usable SpO₂ readings to analyse this recording.',
      counts
    );
  }

  if (analysedDurationSec < SPO2_THRESHOLDS.MIN_DURATION_SEC) {
    return unavailable(
      SPO2_STATUS.INSUFFICIENT_DATA,
      'The usable portion of this recording is too short to analyse saturation.',
      counts
    );
  }

  if (coveragePct !== null && coveragePct < SPO2_THRESHOLDS.MIN_COVERAGE_PCT) {
    return unavailable(
      SPO2_STATUS.POOR_SIGNAL_QUALITY,
      'The pulse sensor produced a usable reading for too little of this recording to analyse saturation reliably.',
      counts
    );
  }

  const values = usable.map((s) => s.spo2);
  const stats = {
    mean: mean(values),
    median: median(values),
    min: Math.min(...values),
    max: Math.max(...values),
    sd: stdDev(values),
  };

  const baseline = rollingBaseline(usable);
  const desaturations = findDesaturations(usable, baseline, SPO2_THRESHOLDS.DESAT_DROP_PCT);
  const strictDesaturations = findDesaturations(
    usable,
    baseline,
    SPO2_THRESHOLDS.DESAT_DROP_STRICT_PCT
  );
  const lowPeriods = findLowPeriods(usable, SPO2_THRESHOLDS.LOW_LEVEL_PCT);

  const below90 = timeBelow(usable, SPO2_THRESHOLDS.LOW_LEVEL_PCT);
  const below88 = timeBelow(usable, SPO2_THRESHOLDS.VERY_LOW_LEVEL_PCT);
  const stability = classifyStability(stats.sd);

  const events = [...desaturations, ...lowPeriods].sort((a, b) => a.startSec - b.startSec);

  return {
    status: SPO2_STATUS.SUCCESS,
    message: null,
    summary: {
      meanPct: round(stats.mean, 1),
      medianPct: round(stats.median, 1),
      minPct: round(stats.min, 1),
      maxPct: round(stats.max, 1),
      sdPct: round(stats.sd, 2),
      desaturationEvents: desaturations.length,
      strictDesaturationEvents: strictDesaturations.length,
      lowSaturationPeriods: lowPeriods.length,
      timeBelow90Sec: below90.seconds,
      timeBelow90Percent: below90.percent,
      timeBelow88Sec: below88.seconds,
      timeBelow88Percent: below88.percent,
      recoveredDesaturations: desaturations.filter((e) => e.recovered).length,
    },
    stability,
    counts,
    events,
    series: downsample(
      usable.map((s, i) => ({
        offsetSec: round(s.t, 1),
        timestamp: s.timestamp || null,
        spo2: round(s.spo2, 1),
        baseline: round(baseline[i], 1),
      })),
      SPO2_THRESHOLDS.MAX_SERIES_POINTS
    ),
    patientSummary: buildPatientSummary({
      stats,
      stability,
      desaturations: desaturations.length,
      lowPeriods: lowPeriods.length,
      coveragePct,
    }),
    technicalSummary: buildTechnicalSummary({
      stats,
      stability,
      counts,
      desaturations: desaturations.length,
      strictDesaturations: strictDesaturations.length,
      lowPeriods: lowPeriods.length,
      below90,
      below88,
    }),
  };
}

module.exports = {
  analyseSpo2,
  usableSamples,
  rollingBaseline,
  findDesaturations,
  findLowPeriods,
  timeBelow,
  classifyStability,
  SPO2_THRESHOLDS,
  SPO2_STATUS,
  SPO2_EVENT_TYPE,
  STABILITY,
};
