/**
 * Combined physiological analysis.
 *
 * Cross-references the signals that were recorded at the same instants: HR (from
 * the validated RR sequence), SpO2 and temperature.
 *
 * SYNCHRONISATION
 * Every signal here comes from the same `Reading` rows, so they share one
 * timestamp by construction — there is no clock alignment to get wrong. HR is
 * the exception: it is derived from R-peak timing, so it is resampled onto the
 * reading timestamps before pairing. The module reports how many synchronised
 * pairs each relationship rests on, and refuses to describe a relationship that
 * does not have enough of them.
 *
 * SCOPE AND WORDING
 * Descriptive only. A correlation between two signals is not causation and is
 * not a diagnosis: HR and SpO2 moving together can equally mean the wearer moved,
 * which corrupts both signals at once. The module says how strong an association
 * is and how much data supports it, and stops there.
 */

// -- Thresholds -------------------------------------------------------
const COMBINED_THRESHOLDS = {
  /** Minimum synchronised pairs before a relationship is described at all. */
  MIN_PAIRS: 60,

  /** Minimum analysed span, in seconds. */
  MIN_DURATION_SEC: 60,

  /**
   * A reading pair counts as simultaneous only within this tolerance. Both
   * signals come off the same row, so this exists to catch resampled HR that
   * drifted away from its row rather than to align two clocks.
   */
  PAIR_TOLERANCE_SEC: 2,

  /**
   * Correlation strength bands (absolute Pearson r). Deliberately conservative:
   * physiological signals on a moving wearer correlate spuriously all the time.
   */
  R_WEAK: 0.3,
  R_MODERATE: 0.5,
  R_STRONG: 0.7,

  /**
   * Concurrency window: an SpO2 event and an HR excursion within this many
   * seconds of each other are reported as co-occurring.
   */
  CONCURRENCY_WINDOW_SEC: 30,

  MAX_SERIES_POINTS: 600,
};

const COMBINED_STATUS = {
  SUCCESS: 'success',
  INSUFFICIENT_DATA: 'insufficient_data',
  NO_DATA: 'no_data',
};

const ASSOCIATION = {
  NONE: 'No clear association',
  WEAK: 'Weak',
  MODERATE: 'Moderate',
  STRONG: 'Strong',
  UNAVAILABLE: 'Unavailable',
};

const DIRECTION = {
  TOGETHER: 'Move together',
  OPPOSITE: 'Move oppositely',
  NONE: 'No consistent direction',
  UNAVAILABLE: 'Unavailable',
};

// -- helpers ----------------------------------------------------------

function round(v, d = 0) {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

/** Pearson correlation coefficient, or null when it is undefined. */
function pearson(xs, ys) {
  if (xs.length !== ys.length || xs.length < 3) return null;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < xs.length; i += 1) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  // A flat signal has no variance, so no correlation is defined.
  if (dx <= 0 || dy <= 0) return null;
  return num / Math.sqrt(dx * dy);
}

function classifyAssociation(r) {
  if (r === null) return ASSOCIATION.UNAVAILABLE;
  const a = Math.abs(r);
  if (a < COMBINED_THRESHOLDS.R_WEAK) return ASSOCIATION.NONE;
  if (a < COMBINED_THRESHOLDS.R_MODERATE) return ASSOCIATION.WEAK;
  if (a < COMBINED_THRESHOLDS.R_STRONG) return ASSOCIATION.MODERATE;
  return ASSOCIATION.STRONG;
}

function classifyDirection(r) {
  if (r === null) return DIRECTION.UNAVAILABLE;
  if (Math.abs(r) < COMBINED_THRESHOLDS.R_WEAK) return DIRECTION.NONE;
  return r > 0 ? DIRECTION.TOGETHER : DIRECTION.OPPOSITE;
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
 * Resample the beat-by-beat HR series onto arbitrary target times.
 *
 * HR exists only at R peaks, while SpO2 and temperature exist on reading rows.
 * Nearest-neighbour within the tolerance, rather than interpolation, so a target
 * time that falls in a gap where beats were rejected gets no HR at all instead of
 * a made-up one.
 */
function resampleHrTo(targetTimes, hrSeries) {
  if (!hrSeries.length) return targetTimes.map(() => null);

  const out = [];
  let j = 0;
  for (const t of targetTimes) {
    while (j < hrSeries.length - 1 && Math.abs(hrSeries[j + 1].t - t) <= Math.abs(hrSeries[j].t - t)) {
      j += 1;
    }
    const candidate = hrSeries[j];
    out.push(
      candidate && Math.abs(candidate.t - t) <= COMBINED_THRESHOLDS.PAIR_TOLERANCE_SEC
        ? candidate.hr
        : null
    );
  }
  return out;
}

/**
 * Build the set of instants where both named signals have a real value.
 *
 * @returns {{xs:number[], ys:number[], times:number[]}}
 */
function pairUp(times, a, b) {
  const xs = [];
  const ys = [];
  const paired = [];
  for (let i = 0; i < times.length; i += 1) {
    if (Number.isFinite(a[i]) && Number.isFinite(b[i])) {
      xs.push(a[i]);
      ys.push(b[i]);
      paired.push(times[i]);
    }
  }
  return { xs, ys, times: paired };
}

/** Describe one pairwise relationship, or say why it could not be described. */
function describeRelationship(label, unitA, unitB, pair) {
  if (pair.xs.length < COMBINED_THRESHOLDS.MIN_PAIRS) {
    return {
      label,
      available: false,
      pairs: pair.xs.length,
      minPairs: COMBINED_THRESHOLDS.MIN_PAIRS,
      reason: 'insufficient_synchronised_pairs',
      detail: `Only ${pair.xs.length} instants had both ${unitA} and ${unitB} recorded; at least ${COMBINED_THRESHOLDS.MIN_PAIRS} are needed to describe a relationship.`,
      r: null,
      association: ASSOCIATION.UNAVAILABLE,
      direction: DIRECTION.UNAVAILABLE,
    };
  }

  const r = pearson(pair.xs, pair.ys);
  if (r === null) {
    return {
      label,
      available: false,
      pairs: pair.xs.length,
      minPairs: COMBINED_THRESHOLDS.MIN_PAIRS,
      reason: 'no_variance',
      detail: `One of the two signals did not vary over the recording, so no relationship can be computed.`,
      r: null,
      association: ASSOCIATION.UNAVAILABLE,
      direction: DIRECTION.UNAVAILABLE,
    };
  }

  const spanSec = pair.times.length
    ? pair.times[pair.times.length - 1] - pair.times[0]
    : 0;

  return {
    label,
    available: true,
    pairs: pair.xs.length,
    minPairs: COMBINED_THRESHOLDS.MIN_PAIRS,
    spanSec: round(spanSec, 1),
    r: round(r, 3),
    rSquared: round(r * r, 3),
    association: classifyAssociation(r),
    direction: classifyDirection(r),
    reason: null,
    detail: null,
  };
}

// -- Concurrent events ------------------------------------------------

/**
 * Events from different modules that overlap in time.
 *
 * Co-occurrence is reported, never interpreted: an SpO2 drop alongside an HR
 * rise is exactly what motion artifact looks like, and also what a genuine
 * physiological response looks like. This module cannot tell them apart, and
 * says so.
 */
function findConcurrentEvents(spo2Events = [], rhythmEvents = [], tempEvents = []) {
  const out = [];
  const w = COMBINED_THRESHOLDS.CONCURRENCY_WINDOW_SEC;

  const overlaps = (a, b) => {
    const aStart = a.startSec ?? null;
    const bStart = b.startSec ?? null;
    if (aStart === null || bStart === null) return false;
    const aEnd = a.endSec ?? aStart;
    const bEnd = b.endSec ?? bStart;
    return aStart - w <= bEnd && bStart - w <= aEnd;
  };

  for (const s of spo2Events) {
    for (const r of rhythmEvents) {
      if (!overlaps(s, r)) continue;
      out.push({
        startSec: round(Math.min(s.startSec, r.startSec), 1),
        signals: ['spo2', 'heart_rate'],
        spo2EventType: s.eventType,
        otherEventType: r.eventType,
        description: `A ${labelOf(s.eventType)} and a ${labelOf(
          r.eventType
        )} occurred at the same point in the recording. Movement disturbs the pulse and ECG signals together, so co-occurrence alone does not establish a physiological link.`,
      });
    }
    for (const t of tempEvents) {
      if (!overlaps(s, t)) continue;
      out.push({
        startSec: round(Math.min(s.startSec, t.startSec), 1),
        signals: ['spo2', 'temperature'],
        spo2EventType: s.eventType,
        otherEventType: t.eventType,
        description: `A ${labelOf(s.eventType)} and a ${labelOf(
          t.eventType
        )} overlapped. A sensor shifting against the skin can affect both readings at once.`,
      });
    }
  }

  for (const r of rhythmEvents) {
    for (const t of tempEvents) {
      if (!overlaps(r, t)) continue;
      out.push({
        startSec: round(Math.min(r.startSec, t.startSec), 1),
        signals: ['heart_rate', 'temperature'],
        spo2EventType: null,
        otherEventType: `${r.eventType}+${t.eventType}`,
        description: `A ${labelOf(r.eventType)} and a ${labelOf(
          t.eventType
        )} overlapped. Activity raises heart rate and skin temperature together, so this pattern is expected during movement.`,
      });
    }
  }

  return out.sort((a, b) => a.startSec - b.startSec).slice(0, 50);
}

function labelOf(type) {
  const map = {
    possible_desaturation: 'saturation dip',
    low_saturation_period: 'period of low saturation',
    elevated_heart_rate: 'period of elevated heart rate',
    low_heart_rate: 'period of low heart rate',
    irregular_rr_period: 'period of irregular heartbeat timing',
    relative_elevation: 'warmer period',
    relative_depression: 'cooler period',
  };
  return map[type] || String(type).replace(/_/g, ' ');
}

// -- Narrative --------------------------------------------------------

function buildPatientSummary({ relationships, concurrent, coverage }) {
  const parts = [
    'This section looks at whether the different measurements changed together during the recording.',
  ];

  const described = relationships.filter((r) => r.available);
  if (!described.length) {
    parts.push(
      'There were not enough moments where two measurements were recorded at the same time to compare them.'
    );
  } else {
    const notable = described.filter((r) => r.association !== ASSOCIATION.NONE);
    if (!notable.length) {
      parts.push('The measurements did not move together in any consistent way.');
    } else {
      for (const r of notable) {
        parts.push(
          `${r.label} showed a ${r.association.toLowerCase()} association (${
            r.direction === DIRECTION.TOGETHER
              ? 'rising and falling together'
              : 'moving in opposite directions'
          }).`
        );
      }
    }
  }

  if (concurrent > 0) {
    parts.push(
      `${concurrent} moment${
        concurrent === 1 ? '' : 's'
      } had findings in more than one measurement at once. Movement can disturb several sensors at the same time, so this does not by itself mean the body was responding.`
    );
  }

  parts.push(
    `These comparisons cover about ${Math.round(
      coverage
    )}% of the recording, describe what was measured rather than why, and are not a diagnosis. Please discuss any concerns with a healthcare professional.`
  );

  return parts.join(' ');
}

function buildTechnicalSummary({ relationships, concurrent, counts }) {
  const lines = [
    `Synchronisation: all signals originate from the same reading rows and share one timestamp; HR was resampled from R-peak timing onto those rows by nearest neighbour within ${COMBINED_THRESHOLDS.PAIR_TOLERANCE_SEC} s, with no interpolation across rejected beats.`,
    `Coverage: ${counts.rows} reading rows over ${round(
      counts.analysedDurationSec,
      1
    )} s; HR present on ${counts.hrPresent}, SpO2 on ${counts.spo2Present}, temperature on ${counts.tempPresent}.`,
  ];

  for (const r of relationships) {
    if (r.available) {
      lines.push(
        `${r.label}: Pearson r ${r.r} (r² ${r.rSquared}) over ${r.pairs} synchronised pairs spanning ${r.spanSec} s — ${r.association}, ${r.direction}.`
      );
    } else {
      lines.push(`${r.label}: not described — ${r.detail}`);
    }
  }

  lines.push(
    `${concurrent} concurrent multi-signal finding(s) within a ${COMBINED_THRESHOLDS.CONCURRENCY_WINDOW_SEC} s window.`
  );
  lines.push(
    'Correlation is reported as an association only. It is not causation, and on a wearable a shared motion artifact produces the same signature as a shared physiological response; the two cannot be separated from these signals alone.'
  );

  return lines.join(' ');
}

// -- Orchestration ----------------------------------------------------

/**
 * An unavailable result still carries the relationships and the aligned series.
 *
 * The per-relationship `reason` is the most useful thing this module can say
 * when it cannot describe anything — "only 4 instants had both signals" tells a
 * reader what to fix — and the aligned chart is still worth looking at even when
 * no correlation is computable. Only the narrative summaries are withheld.
 */
function unavailable(status, message, counts, { relationships = [], series = [] } = {}) {
  return {
    status,
    message,
    relationships,
    concurrentEvents: [],
    counts,
    series,
    patientSummary: null,
    technicalSummary: null,
  };
}

/**
 * Run the combined analysis.
 *
 * @param {object} input
 * @param {Array<{t:number, spo2:number|null, tempC:number|null, timestamp?:string}>} input.rows
 *   Reading rows in time order.
 * @param {Array<{t:number, hr:number}>} input.hrSeries HR at each accepted beat.
 * @param {Array} [input.spo2Events]
 * @param {Array} [input.rhythmEvents]
 * @param {Array} [input.tempEvents]
 * @param {{recordingDurationSec?:number}} [options]
 */
function analyseCombined(input, options = {}) {
  const rows = input.rows || [];
  const hrSeries = input.hrSeries || [];

  const times = rows.map((r) => r.t);
  const analysedDurationSec = times.length > 1 ? times[times.length - 1] - times[0] : 0;

  const hr = resampleHrTo(times, hrSeries);
  const spo2 = rows.map((r) => (Number.isFinite(r.spo2) && r.spo2 > 0 ? r.spo2 : null));
  const temp = rows.map((r) => (Number.isFinite(r.tempC) ? r.tempC : null));

  const counts = {
    rows: rows.length,
    hrPresent: hr.filter((v) => Number.isFinite(v)).length,
    spo2Present: spo2.filter((v) => Number.isFinite(v)).length,
    tempPresent: temp.filter((v) => Number.isFinite(v)).length,
    analysedDurationSec: round(analysedDurationSec, 1),
    recordingDurationSec: options.recordingDurationSec ?? null,
  };

  if (!rows.length) {
    return unavailable(
      COMBINED_STATUS.NO_DATA,
      'No readings are available for this session, so the measurements cannot be compared.',
      counts
    );
  }

  if (analysedDurationSec < COMBINED_THRESHOLDS.MIN_DURATION_SEC) {
    return unavailable(
      COMBINED_STATUS.INSUFFICIENT_DATA,
      'This recording is too short to compare the measurements against each other.',
      counts
    );
  }

  const hrSpo2 = pairUp(times, hr, spo2);
  const hrTemp = pairUp(times, hr, temp);
  const spo2Temp = pairUp(times, spo2, temp);

  const relationships = [
    describeRelationship('Heart rate and SpO₂', 'heart rate', 'SpO₂', hrSpo2),
    describeRelationship('Heart rate and temperature', 'heart rate', 'temperature', hrTemp),
    describeRelationship('SpO₂ and temperature', 'SpO₂', 'temperature', spo2Temp),
  ];

  const alignedSeries = downsample(
    times.map((t, i) => ({
      offsetSec: round(t, 1),
      timestamp: rows[i].timestamp || null,
      hr: Number.isFinite(hr[i]) ? round(hr[i], 1) : null,
      spo2: Number.isFinite(spo2[i]) ? round(spo2[i], 1) : null,
      tempC: Number.isFinite(temp[i]) ? round(temp[i], 2) : null,
    })),
    COMBINED_THRESHOLDS.MAX_SERIES_POINTS
  );

  if (!relationships.some((r) => r.available)) {
    return unavailable(
      COMBINED_STATUS.INSUFFICIENT_DATA,
      'None of the measurement pairs could be compared. See each pairing below for the reason.',
      counts,
      { relationships, series: alignedSeries }
    );
  }

  const concurrentEvents = findConcurrentEvents(
    input.spo2Events || [],
    input.rhythmEvents || [],
    input.tempEvents || []
  );

  // Coverage of the best-supported relationship, for the patient wording.
  const bestPairs = Math.max(...relationships.map((r) => r.pairs));
  const coverage = rows.length ? (bestPairs / rows.length) * 100 : 0;

  return {
    status: COMBINED_STATUS.SUCCESS,
    message: null,
    relationships,
    concurrentEvents,
    counts,
    // One aligned row per instant, for a multi-signal chart.
    series: alignedSeries,
    patientSummary: buildPatientSummary({
      relationships,
      concurrent: concurrentEvents.length,
      coverage,
    }),
    technicalSummary: buildTechnicalSummary({
      relationships,
      concurrent: concurrentEvents.length,
      counts,
    }),
  };
}

module.exports = {
  analyseCombined,
  pearson,
  classifyAssociation,
  classifyDirection,
  resampleHrTo,
  pairUp,
  describeRelationship,
  findConcurrentEvents,
  COMBINED_THRESHOLDS,
  COMBINED_STATUS,
  ASSOCIATION,
  DIRECTION,
};
