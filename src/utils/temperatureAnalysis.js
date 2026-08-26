/**
 * Temperature analysis.
 *
 * Pure functions: a timestamped temperature series in, trends and elevation
 * events out.
 *
 * WHAT THIS SENSOR ACTUALLY MEASURES — READ THIS FIRST
 * A thermistor in a garment reads the temperature of the skin (and partly the
 * air) under it, not core body temperature. Real recordings from this device sit
 * around 30-34 C, which is normal for skin and would be profound hypothermia if
 * it were core temperature.
 *
 * Consequently this module NEVER applies a fever threshold. A fixed 38 C rule
 * would be doubly wrong: it would never fire on skin-range data, and if it did
 * fire it would be measuring the wrong thing. Instead the module:
 *
 *   1. classifies which measurement regime the data is in (skin vs body range),
 *      so the report can say what it is looking at;
 *   2. reports absolute values and drift as measured;
 *   3. flags elevation RELATIVE TO THIS RECORDING'S OWN BASELINE, which is
 *      meaningful for either regime.
 *
 * SCOPE AND WORDING
 * Measurement and screening only. No fever, hypothermia, infection or illness is
 * inferred anywhere in this file.
 */

// -- Thresholds -------------------------------------------------------
const TEMP_THRESHOLDS = {
  /**
   * Plausible band for any contact thermistor on a person. Outside this the
   * sensor is detached, shorted, or reading the room.
   */
  MIN_PLAUSIBLE_C: 20,
  MAX_PLAUSIBLE_C: 45,

  /**
   * Measurement-regime boundaries. Used only to LABEL what the sensor appears to
   * be reading, never to judge the value.
   */
  SKIN_RANGE_MAX_C: 35.5,
  BODY_RANGE_MIN_C: 35.5,

  /** Rise above the recording's own baseline that counts as an elevation. */
  ELEVATION_RISE_C: 0.5,
  /** And a fall of this much below baseline. */
  DEPRESSION_FALL_C: 0.5,

  /** An excursion must persist this long, which rejects single-sample noise. */
  EVENT_MIN_DURATION_SEC: 60,

  /** Baseline is the rolling median over this window, in seconds. */
  BASELINE_WINDOW_SEC: 300,

  /** Total drift across the recording that counts as a warming/cooling trend. */
  TREND_C: 0.5,

  /** Stability banding on the standard deviation, in Celsius. */
  STABILITY_STABLE_SD: 0.2,
  STABILITY_MODERATE_SD: 0.6,

  // Availability gates.
  MIN_SAMPLES: 60,
  MIN_DURATION_SEC: 120,
  MIN_COVERAGE_PCT: 40,

  MAX_SERIES_POINTS: 1000,
};

const TEMP_STATUS = {
  SUCCESS: 'success',
  INSUFFICIENT_DATA: 'insufficient_data',
  POOR_SIGNAL_QUALITY: 'poor_signal_quality',
  NO_DATA: 'no_data',
};

const TEMP_EVENT_TYPE = {
  ELEVATION: 'relative_elevation',
  DEPRESSION: 'relative_depression',
};

/** What the sensor appears to be measuring. A label, not a verdict. */
const REGIME = {
  SKIN: 'Surface / skin range',
  BODY: 'Body-temperature range',
  MIXED: 'Mixed range',
  UNAVAILABLE: 'Unavailable',
};

const TREND = {
  RISING: 'Rising',
  FALLING: 'Falling',
  STABLE: 'Stable',
  UNAVAILABLE: 'Unavailable',
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

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

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

function usableSamples(samples) {
  return (samples || []).filter(
    (s) =>
      s &&
      Number.isFinite(s.t) &&
      Number.isFinite(s.tempC) &&
      s.tempC >= TEMP_THRESHOLDS.MIN_PLAUSIBLE_C &&
      s.tempC <= TEMP_THRESHOLDS.MAX_PLAUSIBLE_C
  );
}

function rollingBaseline(samples, windowSec = TEMP_THRESHOLDS.BASELINE_WINDOW_SEC) {
  const half = windowSec / 2;
  return samples.map((s, i) => {
    const w = [];
    for (let j = i; j >= 0 && s.t - samples[j].t <= half; j -= 1) w.push(samples[j].tempC);
    for (let j = i + 1; j < samples.length && samples[j].t - s.t <= half; j += 1) {
      w.push(samples[j].tempC);
    }
    return median(w);
  });
}

/**
 * Which regime the readings sit in.
 *
 * Decided on the median so a few stray samples cannot flip the label.
 */
function classifyRegime(values) {
  const m = median(values);
  if (m === null) return REGIME.UNAVAILABLE;

  const inSkin = values.filter((v) => v < TEMP_THRESHOLDS.SKIN_RANGE_MAX_C).length;
  const share = inSkin / values.length;

  if (share >= 0.8) return REGIME.SKIN;
  if (share <= 0.2) return REGIME.BODY;
  return REGIME.MIXED;
}

/** Least-squares slope in Celsius per minute. */
function driftPerMinute(samples) {
  if (samples.length < 2) return null;
  const t = samples.map((s) => s.t / 60);
  const y = samples.map((s) => s.tempC);
  const mt = mean(t);
  const my = mean(y);
  let num = 0;
  let den = 0;
  for (let i = 0; i < t.length; i += 1) {
    num += (t[i] - mt) * (y[i] - my);
    den += (t[i] - mt) ** 2;
  }
  return den > 0 ? num / den : null;
}

function classifyTrend(totalChangeC) {
  if (totalChangeC === null) return TREND.UNAVAILABLE;
  if (totalChangeC >= TEMP_THRESHOLDS.TREND_C) return TREND.RISING;
  if (totalChangeC <= -TEMP_THRESHOLDS.TREND_C) return TREND.FALLING;
  return TREND.STABLE;
}

function classifyStability(sd) {
  if (sd === null) return STABILITY.UNAVAILABLE;
  if (sd <= TEMP_THRESHOLDS.STABILITY_STABLE_SD) return STABILITY.STABLE;
  if (sd <= TEMP_THRESHOLDS.STABILITY_MODERATE_SD) return STABILITY.MODERATE;
  return STABILITY.VARIABLE;
}

// -- Excursion detection ----------------------------------------------

/**
 * Sustained departures from the recording's own rolling baseline.
 *
 * Baseline-relative rather than absolute, because the absolute value of a skin
 * thermistor depends on where it sits, how tight the garment is and the ambient
 * temperature — none of which is knowable here, while a change within one
 * recording is.
 */
function findExcursions(samples, baseline) {
  const events = [];

  const scan = (predicate, type, label) => {
    let run = null;
    const flush = () => {
      if (!run) return;
      const slice = samples.slice(run.from, run.to + 1);
      const durationSec = slice[slice.length - 1].t - slice[0].t;
      if (durationSec >= TEMP_THRESHOLDS.EVENT_MIN_DURATION_SEC) {
        const values = slice.map((s) => s.tempC);
        const peak = type === TEMP_EVENT_TYPE.ELEVATION ? Math.max(...values) : Math.min(...values);
        events.push({
          eventType: type,
          startSec: round(slice[0].t, 1),
          endSec: round(slice[slice.length - 1].t, 1),
          durationSec: round(durationSec, 1),
          timestamp: slice[0].timestamp || null,
          baselineC: round(run.baselineAtStart, 2),
          peakC: round(peak, 2),
          changeC: round(peak - run.baselineAtStart, 2),
          samples: slice.length,
          description: `${label} of ${Math.abs(
            round(peak - run.baselineAtStart, 2)
          )} °C from the recording's own baseline of ${round(
            run.baselineAtStart,
            2
          )} °C, sustained for ${round(
            durationSec / 60,
            1
          )} min. Reported relative to this recording; a contact thermistor also responds to garment fit and ambient conditions.`,
        });
      }
      run = null;
    };

    for (let i = 0; i < samples.length; i += 1) {
      const base = baseline[i];
      if (base !== null && predicate(samples[i].tempC, base)) {
        if (!run) run = { from: i, baselineAtStart: base };
        run.to = i;
      } else {
        flush();
      }
    }
    flush();
  };

  scan(
    (v, base) => v - base >= TEMP_THRESHOLDS.ELEVATION_RISE_C,
    TEMP_EVENT_TYPE.ELEVATION,
    'Rise'
  );
  scan(
    (v, base) => base - v >= TEMP_THRESHOLDS.DEPRESSION_FALL_C,
    TEMP_EVENT_TYPE.DEPRESSION,
    'Fall'
  );

  return events.sort((a, b) => a.startSec - b.startSec);
}

// -- Narrative --------------------------------------------------------

function buildPatientSummary({ stats, regime, trend, elevations, depressions, coveragePct }) {
  const parts = [];

  if (regime === REGIME.SKIN) {
    parts.push(
      'This is a skin-surface temperature measured by the sensor in the garment. It is normally several degrees below body temperature and is not a body-temperature reading.'
    );
  } else if (regime === REGIME.BODY) {
    parts.push(
      'This temperature was measured by a sensor in contact with the skin. Readings in this range are close to body temperature, but a contact sensor is not a substitute for a clinical thermometer.'
    );
  } else {
    parts.push(
      'This temperature was measured by a sensor in the garment. The readings spanned a wide range during the recording, which usually means sensor contact changed.'
    );
  }

  parts.push(
    `It averaged ${round(stats.mean, 1)} °C, ranging from ${round(stats.min, 1)} °C to ${round(
      stats.max,
      1
    )} °C.`
  );

  if (trend === TREND.RISING) {
    parts.push('The reading rose gradually over the recording.');
  } else if (trend === TREND.FALLING) {
    parts.push('The reading fell gradually over the recording.');
  } else {
    parts.push('The reading stayed broadly steady over the recording.');
  }

  if (elevations > 0) {
    parts.push(
      `${elevations} period${elevations === 1 ? ' was' : 's were'} warmer than the rest of the recording. Clothing, activity and room temperature all affect a skin sensor.`
    );
  }
  if (depressions > 0) {
    parts.push(
      `${depressions} period${depressions === 1 ? ' was' : 's were'} cooler than the rest of the recording.`
    );
  }

  if (coveragePct !== null && coveragePct < 70) {
    parts.push(
      `A usable reading was available for about ${Math.round(
        coveragePct
      )}% of the recording, so this describes part of it.`
    );
  }

  parts.push(
    'These are measurements from the recorded signal, not a diagnosis, and this reading should not be used to check for a fever. Please discuss any concerns with a healthcare professional.'
  );

  return parts.join(' ');
}

function buildTechnicalSummary({ stats, regime, trend, stability, counts, drift, events }) {
  const f = (v, u, d = 2) => (v === null || v === undefined ? 'n/a' : `${round(v, d)}${u}`);
  const elevations = events.filter((e) => e.eventType === TEMP_EVENT_TYPE.ELEVATION).length;
  const depressions = events.filter((e) => e.eventType === TEMP_EVENT_TYPE.DEPRESSION).length;

  return [
    `Temperature: mean ${f(stats.mean, ' °C')}, median ${f(stats.median, ' °C')}, min ${f(
      stats.min,
      ' °C'
    )}, max ${f(stats.max, ' °C')}, SD ${f(stats.sd, ' °C')} — stability ${stability}.`,
    `Measurement regime classified ${regime} from the sample distribution (skin-range boundary ${TEMP_THRESHOLDS.SKIN_RANGE_MAX_C} °C). This is a contact thermistor reading, NOT core body temperature; no fever threshold is applied anywhere in this analysis.`,
    `Trend ${trend}: total change ${f(stats.totalChangeC, ' °C')} across the analysed window, drift ${f(
      drift,
      ' °C/min',
      3
    )}.`,
    `Excursions from the ${TEMP_THRESHOLDS.BASELINE_WINDOW_SEC} s rolling median baseline: ${elevations} rise(s) of at least ${TEMP_THRESHOLDS.ELEVATION_RISE_C} °C and ${depressions} fall(s) of at least ${TEMP_THRESHOLDS.DEPRESSION_FALL_C} °C, each sustained at least ${TEMP_THRESHOLDS.EVENT_MIN_DURATION_SEC} s.`,
    `Coverage: ${counts.usableSamples}/${counts.totalSamples} samples usable (${f(
      counts.coveragePct,
      '%'
    )}) over ${f(counts.analysedDurationSec, ' s', 0)}; samples outside ${
      TEMP_THRESHOLDS.MIN_PLAUSIBLE_C
    }-${TEMP_THRESHOLDS.MAX_PLAUSIBLE_C} °C were excluded as sensor-detached.`,
    'Screening output only. Absolute skin temperature depends on sensor placement, garment fit and ambient conditions, so findings are expressed relative to this recording rather than to a population norm.',
  ].join(' ');
}

// -- Orchestration ----------------------------------------------------

function unavailable(status, message, counts) {
  return {
    status,
    message,
    summary: null,
    regime: REGIME.UNAVAILABLE,
    trend: TREND.UNAVAILABLE,
    stability: STABILITY.UNAVAILABLE,
    counts,
    events: [],
    series: [],
    patientSummary: null,
    technicalSummary: null,
  };
}

/**
 * Run the temperature analysis.
 *
 * @param {Array<{t:number, tempC:number|null, timestamp?:string}>} samples
 * @param {{recordingDurationSec?:number}} [options]
 */
function analyseTemperature(samples, options = {}) {
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
      TEMP_STATUS.NO_DATA,
      'No usable temperature readings are available for this session.',
      counts
    );
  }
  if (usable.length < TEMP_THRESHOLDS.MIN_SAMPLES) {
    return unavailable(
      TEMP_STATUS.INSUFFICIENT_DATA,
      'Not enough usable temperature readings to analyse this recording.',
      counts
    );
  }
  if (analysedDurationSec < TEMP_THRESHOLDS.MIN_DURATION_SEC) {
    return unavailable(
      TEMP_STATUS.INSUFFICIENT_DATA,
      'The usable portion of this recording is too short to describe a temperature trend.',
      counts
    );
  }
  if (coveragePct !== null && coveragePct < TEMP_THRESHOLDS.MIN_COVERAGE_PCT) {
    return unavailable(
      TEMP_STATUS.POOR_SIGNAL_QUALITY,
      'The temperature sensor produced a usable reading for too little of this recording to analyse reliably.',
      counts
    );
  }

  const values = usable.map((s) => s.tempC);

  // Trend measured on the smoothed ends rather than raw first/last samples, so
  // one noisy reading at either end cannot invent a trend.
  const edge = Math.max(1, Math.floor(usable.length * 0.1));
  const startLevel = median(values.slice(0, edge));
  const endLevel = median(values.slice(-edge));

  const stats = {
    mean: mean(values),
    median: median(values),
    min: Math.min(...values),
    max: Math.max(...values),
    sd: stdDev(values),
    startC: startLevel,
    endC: endLevel,
    totalChangeC: endLevel - startLevel,
  };

  const regime = classifyRegime(values);
  const trend = classifyTrend(stats.totalChangeC);
  const stability = classifyStability(stats.sd);
  const drift = driftPerMinute(usable);

  const baseline = rollingBaseline(usable);
  const events = findExcursions(usable, baseline);
  const elevations = events.filter((e) => e.eventType === TEMP_EVENT_TYPE.ELEVATION).length;
  const depressions = events.filter((e) => e.eventType === TEMP_EVENT_TYPE.DEPRESSION).length;

  return {
    status: TEMP_STATUS.SUCCESS,
    message: null,
    summary: {
      meanC: round(stats.mean, 2),
      medianC: round(stats.median, 2),
      minC: round(stats.min, 2),
      maxC: round(stats.max, 2),
      sdC: round(stats.sd, 3),
      startC: round(stats.startC, 2),
      endC: round(stats.endC, 2),
      totalChangeC: round(stats.totalChangeC, 2),
      driftCPerMin: round(drift, 3),
      elevationEvents: elevations,
      depressionEvents: depressions,
    },
    regime,
    trend,
    stability,
    counts,
    events,
    series: downsample(
      usable.map((s, i) => ({
        offsetSec: round(s.t, 1),
        timestamp: s.timestamp || null,
        tempC: round(s.tempC, 2),
        baseline: round(baseline[i], 2),
      })),
      TEMP_THRESHOLDS.MAX_SERIES_POINTS
    ),
    patientSummary: buildPatientSummary({
      stats,
      regime,
      trend,
      elevations,
      depressions,
      coveragePct,
    }),
    technicalSummary: buildTechnicalSummary({
      stats,
      regime,
      trend,
      stability,
      counts,
      drift,
      events,
    }),
  };
}

module.exports = {
  analyseTemperature,
  usableSamples,
  rollingBaseline,
  findExcursions,
  classifyRegime,
  classifyTrend,
  classifyStability,
  driftPerMinute,
  TEMP_THRESHOLDS,
  TEMP_STATUS,
  TEMP_EVENT_TYPE,
  REGIME,
  TREND,
  STABILITY,
};
