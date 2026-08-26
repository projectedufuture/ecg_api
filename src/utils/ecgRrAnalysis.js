/**
 * ECG / RR analysis engine.
 *
 * Pure, dependency-free functions: R-peak timestamps in, analysis object out.
 * Nothing here touches the database or Express, so the whole pipeline is unit
 * testable (see tests/ecgRrAnalysis.test.js).
 *
 * IMPORTANT - SCOPE AND WORDING
 * This module describes the *timing of detected R peaks*. It is a screening and
 * data-quality layer, not a diagnostic one. It deliberately never emits terms
 * such as AF, arrhythmia, PVC or "healthy": an unusual RR interval on a wearable
 * is at least as likely to be a detection artifact as a physiological event, so
 * every finding is phrased as "possible" and paired with a quality flag.
 */

// -- Thresholds -------------------------------------------------------
// All tunable constants live here so they can be reviewed and adjusted in one
// place. Each is documented with the reasoning behind the default.
const THRESHOLDS = {
  // Hard physiological gate. An RR of 300 ms is 200 BPM and 3000 ms is 20 BPM;
  // outside this band the interval is treated as detector noise, not a beat.
  RR_MIN_PHYSIOLOGICAL_MS: 300,
  RR_MAX_PHYSIOLOGICAL_MS: 3000,

  // Screening threshold for a "possible long RR". 2000 ms (= 30 BPM
  // instantaneous) is the conventional starting point for pause screening.
  LONG_RR_SCREEN_MS: 2000,

  // Ratios against the recording's robust reference RR (see referenceRR).
  // Outside these bounds the interval is unusual relative to the wearer's own
  // rhythm rather than to a population norm.
  SHORT_RR_RATIO: 0.7, // rr < 0.7 x reference -> short_rr_candidate
  LONG_RR_RATIO: 1.5, // rr > 1.5 x reference -> long_rr_candidate

  // A missed R peak merges two beats, so the resulting RR lands near an integer
  // multiple of the reference. This band is deliberately generous because the
  // underlying rhythm drifts.
  MISSED_BEAT_RATIO_LOW: 1.7,
  MISSED_BEAT_RATIO_HIGH: 2.35,

  // A double detection splits one beat in two, so a short RR is followed by a
  // partner and the pair sums back to roughly one reference interval.
  DOUBLE_DETECTION_RATIO: 0.6,
  DOUBLE_DETECTION_SUM_TOLERANCE: 0.25, // |sum/reference - 1| within 25%

  // RR coefficient of variation (%) -> descriptive regularity label.
  CV_REGULAR_PCT: 5,
  CV_MOSTLY_REGULAR_PCT: 10,
  CV_VARIABLE_PCT: 20,

  // Mean absolute successive RR difference (ms) -> beat-to-beat variation label.
  MASD_LOW_MS: 20,
  MASD_MODERATE_MS: 50,

  // A single successive difference this large is surfaced as an irregularity
  // event so a reviewer can look at that part of the strip.
  IRREGULARITY_DIFF_MS: 250,

  // Signal quality banding on the percentage of detected beats that produced a
  // usable RR interval.
  QUALITY_GOOD_PCT: 90,
  QUALITY_FAIR_PCT: 75,
  QUALITY_LIMITED_PCT: 50,

  // The usable share must *exceed* this for the report to be produced at all;
  // at or below it the recording is not trusted and the report is reported as
  // unavailable rather than shown with weak numbers. The boundary is exclusive
  // on purpose: when half the detected beats are artifact the reference RR sits
  // between two clusters and the remaining classifications are arbitrary.
  MIN_USABLE_PCT: 50,

  // Fewer valid intervals than this cannot support summary statistics.
  MIN_VALID_RR: 10,

  /**
   * Beats either side of an interval that form its local reference RR. Wide
   * enough to be robust to a few artifacts, narrow enough to follow a genuine
   * change in heart rate rather than rejecting it as artifact.
   */
  LOCAL_REFERENCE_WINDOW: 21,

  // Chart series are downsampled to at most this many points.
  MAX_SERIES_POINTS: 1000,
};

// RR quality classifications (PART 12).
const RR_QUALITY = {
  VALID: 'valid',
  SHORT: 'short_rr_candidate',
  LONG: 'long_rr_candidate',
  MISSED_BEAT: 'possible_missed_beat',
  DOUBLE_DETECTION: 'possible_double_detection',
  INVALID: 'invalid',
};

// Event types (PART 15). Non-diagnostic by construction.
const EVENT_TYPE = {
  POSSIBLE_LONG_RR: 'possible_long_rr',
  RR_IRREGULARITY: 'rr_irregularity',
  POSSIBLE_MISSED_BEAT: 'possible_missed_beat',
  POSSIBLE_DOUBLE_DETECTION: 'possible_double_detection',
  SIGNAL_QUALITY_DROP: 'signal_quality_drop',
};

const REGULARITY = {
  REGULAR: 'Regular',
  MOSTLY_REGULAR: 'Mostly Regular',
  VARIABLE: 'Variable',
  HIGHLY_VARIABLE: 'Highly Variable',
  UNAVAILABLE: 'Unavailable',
};

const VARIATION = {
  LOW: 'Low',
  MODERATE: 'Moderate',
  HIGH: 'High',
  UNAVAILABLE: 'Unavailable',
};

const SIGNAL_QUALITY = {
  GOOD: 'Good',
  FAIR: 'Fair',
  LIMITED: 'Limited',
  POOR: 'Poor',
  UNAVAILABLE: 'Unavailable',
};

// -- Small numeric helpers --------------------------------------------

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Population standard deviation. */
function stdDev(values) {
  if (values.length < 2) return null;
  const m = mean(values);
  const variance = values.reduce((acc, v) => acc + (v - m) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function round(value, decimals = 0) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * A reference RR that survives a contaminated recording.
 *
 * A plain median breaks down when a large share of the intervals are artifacts
 * (e.g. every other beat double-detected), so this takes the median of the
 * physiological intervals and then refines it using only the intervals that sit
 * near that first estimate - but keeps the rough value when the refined subset
 * is too small to be trustworthy.
 */
function referenceRR(rrValues) {
  const physiological = rrValues.filter(
    (rr) => rr >= THRESHOLDS.RR_MIN_PHYSIOLOGICAL_MS && rr <= THRESHOLDS.RR_MAX_PHYSIOLOGICAL_MS
  );
  if (!physiological.length) return null;

  const rough = median(physiological);
  const near = physiological.filter((rr) => rr >= 0.75 * rough && rr <= 1.25 * rough);

  // Only trust the refined estimate when a real cluster supports it.
  if (near.length >= 3 && near.length >= physiological.length * 0.25) {
    return median(near);
  }
  return rough;
}

// -- Step 1: R peaks -> RR intervals ---------------------------------

/**
 * Convert R-peak samples into consecutive RR intervals.
 *
 * @param {Array<{rPeakTimestamp:number, timestamp?:string, confidence?:number, leadOff?:boolean}>} rPeaks
 *   R peaks in any order; sorted here. rPeakTimestamp is the device monotonic
 *   clock in ms (see PART 5) - differences of it are the RR intervals.
 * @returns {{intervals:Array, rejectedPeaks:number, sortedPeaks:Array}}
 */
function buildRrIntervals(rPeaks) {
  const usable = [];
  let rejectedPeaks = 0;

  for (const peak of rPeaks || []) {
    const t = peak && peak.rPeakTimestamp;
    // Guard every malformed shape the ingest layer might let through:
    // null/undefined, non-numeric, NaN, Infinity and negative clocks.
    if (t === null || t === undefined || typeof t !== 'number' || !Number.isFinite(t) || t < 0) {
      rejectedPeaks += 1;
      continue;
    }
    usable.push(peak);
  }

  usable.sort((a, b) => a.rPeakTimestamp - b.rPeakTimestamp);

  const intervals = [];
  let previous = null;

  for (const peak of usable) {
    if (previous === null) {
      previous = peak;
      continue;
    }

    const rr = peak.rPeakTimestamp - previous.rPeakTimestamp;

    // Duplicate timestamps produce rr === 0 and are dropped outright - they are
    // the same detection reported twice, not a zero-length heartbeat.
    if (rr <= 0) {
      rejectedPeaks += 1;
      continue;
    }

    intervals.push({
      rr,
      previousRPeak: previous.rPeakTimestamp,
      currentRPeak: peak.rPeakTimestamp,
      // Wall-clock anchor for display, carried over from the reading row.
      timestamp: peak.timestamp || null,
      confidence: typeof peak.confidence === 'number' ? peak.confidence : null,
      leadOff: peak.leadOff === true,
      quality: RR_QUALITY.VALID, // refined by classifyRrIntervals
    });

    previous = peak;
  }

  return { intervals, rejectedPeaks, sortedPeaks: usable };
}

// -- Step 2: RR quality validation -----------------------------------

/**
 * Assign a quality class to each interval (PART 12).
 *
 * The order matters: artifact explanations (missed beat, double detection) are
 * tested before the plain short/long labels, so an interval that is most simply
 * explained as a detection error is not promoted into a physiological finding.
 */
function classifyRrIntervals(intervals) {
  const allRr = intervals.map((i) => i.rr);
  const globalReference = referenceRR(allRr);

  /**
   * Reference RR local to each interval.
   *
   * A single global reference misreads any sustained change in heart rate: a
   * genuine minute of tachycardia is a long run of intervals well below the
   * recording's overall median, and would be rejected wholesale as short-RR
   * artifacts — which would hide exactly the episode a rhythm screen exists to
   * surface. Comparing each interval against its own neighbourhood instead means
   * a sustained rate change is tracked, while an isolated outlier still stands
   * out against the beats either side of it.
   */
  const localReference = (index) => {
    const half = Math.floor(THRESHOLDS.LOCAL_REFERENCE_WINDOW / 2);
    const from = Math.max(0, index - half);
    const to = Math.min(allRr.length, index + half + 1);

    // Leave-one-out: an interval is judged against its NEIGHBOURS, never against
    // a set containing itself. Including it lets a strictly alternating pattern
    // (say 800/1600, every other beat missed) hide: each interval would sit at
    // the median of a window its own kind dominates, so every beat would look
    // normal and the recording would score as clean.
    const window = [];
    for (let i = from; i < to; i += 1) {
      if (i !== index) window.push(allRr[i]);
    }

    const local = referenceRR(window);
    // Fall back to the whole-recording estimate when the neighbourhood is too
    // sparse or entirely non-physiological.
    return local ?? globalReference;
  };

  return intervals.map((interval, index) => {
    const { rr } = interval;
    const reference = localReference(index);

    // Outside the physiological band -> not a beat interval at all.
    if (rr < THRESHOLDS.RR_MIN_PHYSIOLOGICAL_MS || rr > THRESHOLDS.RR_MAX_PHYSIOLOGICAL_MS) {
      return { ...interval, quality: RR_QUALITY.INVALID, ratio: reference ? rr / reference : null };
    }

    // A lead-off sample cannot be trusted even if the number looks plausible.
    if (interval.leadOff) {
      return { ...interval, quality: RR_QUALITY.INVALID, ratio: reference ? rr / reference : null };
    }

    if (!reference) {
      return { ...interval, quality: RR_QUALITY.VALID, ratio: null };
    }

    const ratio = rr / reference;

    // Long and close to a multiple of the reference -> a beat was probably
    // missed rather than the heart having paused.
    if (ratio >= THRESHOLDS.MISSED_BEAT_RATIO_LOW && ratio <= THRESHOLDS.MISSED_BEAT_RATIO_HIGH) {
      return { ...interval, quality: RR_QUALITY.MISSED_BEAT, ratio };
    }

    // Short, with a partner interval that sums back to one reference beat -> the
    // same beat was probably detected twice.
    if (ratio < THRESHOLDS.DOUBLE_DETECTION_RATIO) {
      const neighbours = [intervals[index - 1], intervals[index + 1]].filter(Boolean);
      const pairsBackToOneBeat = neighbours.some(
        (n) => Math.abs((rr + n.rr) / reference - 1) <= THRESHOLDS.DOUBLE_DETECTION_SUM_TOLERANCE
      );
      if (pairsBackToOneBeat) {
        return { ...interval, quality: RR_QUALITY.DOUBLE_DETECTION, ratio };
      }
      return { ...interval, quality: RR_QUALITY.SHORT, ratio };
    }

    if (ratio < THRESHOLDS.SHORT_RR_RATIO) {
      return { ...interval, quality: RR_QUALITY.SHORT, ratio };
    }

    if (ratio > THRESHOLDS.LONG_RR_RATIO) {
      return { ...interval, quality: RR_QUALITY.LONG, ratio };
    }

    return { ...interval, quality: RR_QUALITY.VALID, ratio };
  });
}

/**
 * Intervals that may be used for summary statistics and plotted as real
 * measurements. Artifact candidates are excluded from both (PART 21).
 */
function isAnalysable(interval) {
  return interval.quality === RR_QUALITY.VALID;
}

// -- Step 3: descriptive statistics ----------------------------------

/** HR from an RR interval, guarded against division by zero (PART 8). */
function hrFromRr(rrMs) {
  if (!Number.isFinite(rrMs) || rrMs <= 0) return null;
  return 60000 / rrMs;
}

function rrStatistics(validRr) {
  if (!validRr.length) {
    return { meanRR: null, minRR: null, maxRR: null, sdRR: null, cvPercent: null };
  }
  const m = mean(validRr);
  const sd = stdDev(validRr);
  return {
    meanRR: m,
    minRR: Math.min(...validRr),
    maxRR: Math.max(...validRr),
    sdRR: sd,
    // CV = SD / mean; CV% = CV x 100 (PART 10).
    cvPercent: sd !== null && m > 0 ? (sd / m) * 100 : null,
  };
}

function hrStatistics(validRr) {
  const hrValues = validRr.map(hrFromRr).filter((hr) => hr !== null);
  if (!hrValues.length) return { meanHR: null, minHR: null, maxHR: null };
  return {
    meanHR: mean(hrValues),
    minHR: Math.min(...hrValues),
    maxHR: Math.max(...hrValues),
  };
}

/**
 * Beat-to-beat analysis (PART 9). Successive differences are taken only across
 * pairs of intervals that are *both* analysable and adjacent in the recording,
 * so an artifact in between does not manufacture a huge apparent jump.
 */
function beatToBeatAnalysis(classified) {
  const diffs = [];
  for (let i = 1; i < classified.length; i += 1) {
    const previous = classified[i - 1];
    const current = classified[i];
    if (!isAnalysable(previous) || !isAnalysable(current)) continue;
    diffs.push({
      diff: current.rr - previous.rr,
      absDiff: Math.abs(current.rr - previous.rr),
      timestamp: current.timestamp,
      rPeak: current.currentRPeak,
      rr: current.rr,
    });
  }

  if (!diffs.length) {
    return {
      differences: [],
      meanAbsDiff: null,
      maxAbsDiff: null,
      variation: VARIATION.UNAVAILABLE,
    };
  }

  const absValues = diffs.map((d) => d.absDiff);
  const meanAbsDiff = mean(absValues);
  const maxAbsDiff = Math.max(...absValues);

  let variation;
  if (meanAbsDiff < THRESHOLDS.MASD_LOW_MS) variation = VARIATION.LOW;
  else if (meanAbsDiff < THRESHOLDS.MASD_MODERATE_MS) variation = VARIATION.MODERATE;
  else variation = VARIATION.HIGH;

  return { differences: diffs, meanAbsDiff, maxAbsDiff, variation };
}

/** Describe the recorded RR timing (PART 10). A description, never a diagnosis. */
function rhythmRegularity(cvPercent) {
  if (cvPercent === null || cvPercent === undefined) return REGULARITY.UNAVAILABLE;
  if (cvPercent < THRESHOLDS.CV_REGULAR_PCT) return REGULARITY.REGULAR;
  if (cvPercent < THRESHOLDS.CV_MOSTLY_REGULAR_PCT) return REGULARITY.MOSTLY_REGULAR;
  if (cvPercent < THRESHOLDS.CV_VARIABLE_PCT) return REGULARITY.VARIABLE;
  return REGULARITY.HIGHLY_VARIABLE;
}

// -- Step 4: events --------------------------------------------------

function buildEvents(classified, beatToBeat) {
  const events = [];

  for (const interval of classified) {
    const base = {
      timestamp: interval.timestamp,
      rPeakTimestamp: interval.currentRPeak,
      rrValue: round(interval.rr),
      quality: interval.quality,
    };

    if (interval.quality === RR_QUALITY.MISSED_BEAT) {
      // Reported as a data-quality finding, NOT as a pause (PART 12).
      events.push({
        ...base,
        eventType: EVENT_TYPE.POSSIBLE_MISSED_BEAT,
        durationMs: round(interval.rr),
        description:
          'Interval close to a multiple of the surrounding beat timing; most likely an undetected R peak rather than a pause. Signal review recommended.',
      });
      continue;
    }

    if (interval.quality === RR_QUALITY.DOUBLE_DETECTION) {
      events.push({
        ...base,
        eventType: EVENT_TYPE.POSSIBLE_DOUBLE_DETECTION,
        durationMs: round(interval.rr),
        description:
          'Unusually short interval that pairs with its neighbour to form one normal beat; most likely the same beat detected twice. Signal review recommended.',
      });
      continue;
    }

    // Long-RR screening (PART 11) - only for intervals not already explained as
    // a missed detection above.
    if (interval.rr >= THRESHOLDS.LONG_RR_SCREEN_MS) {
      events.push({
        ...base,
        eventType: EVENT_TYPE.POSSIBLE_LONG_RR,
        durationMs: round(interval.rr),
        description: 'Possible prolonged RR interval detected; signal-quality review recommended.',
      });
      continue;
    }

    if (interval.quality === RR_QUALITY.INVALID || interval.quality === RR_QUALITY.SHORT) {
      events.push({
        ...base,
        eventType: EVENT_TYPE.SIGNAL_QUALITY_DROP,
        durationMs: round(interval.rr),
        description:
          'Interval outside the range usable for analysis; excluded from the summary statistics.',
      });
    }
  }

  // Beat-to-beat jumps between two otherwise valid intervals.
  for (const d of beatToBeat.differences) {
    if (d.absDiff >= THRESHOLDS.IRREGULARITY_DIFF_MS) {
      events.push({
        timestamp: d.timestamp,
        rPeakTimestamp: d.rPeak,
        eventType: EVENT_TYPE.RR_IRREGULARITY,
        durationMs: round(d.absDiff),
        rrValue: round(d.rr),
        quality: RR_QUALITY.VALID,
        description: `Beat-to-beat change of ${round(
          d.absDiff
        )} ms observed between consecutive intervals.`,
      });
    }
  }

  events.sort((a, b) => (a.rPeakTimestamp || 0) - (b.rPeakTimestamp || 0));
  return events;
}

// -- Step 5: signal quality ------------------------------------------

function signalQuality(beatsDetected, validBeats) {
  if (!beatsDetected) {
    return { status: SIGNAL_QUALITY.UNAVAILABLE, usablePercentage: null };
  }
  const usablePercentage = (validBeats / beatsDetected) * 100;

  let status;
  if (usablePercentage >= THRESHOLDS.QUALITY_GOOD_PCT) status = SIGNAL_QUALITY.GOOD;
  else if (usablePercentage >= THRESHOLDS.QUALITY_FAIR_PCT) status = SIGNAL_QUALITY.FAIR;
  else if (usablePercentage >= THRESHOLDS.QUALITY_LIMITED_PCT) status = SIGNAL_QUALITY.LIMITED;
  else status = SIGNAL_QUALITY.POOR;

  return { status, usablePercentage };
}

// -- Step 6: narrative summaries -------------------------------------

/**
 * Patient-facing wording (PART 25). Observational, plain language, and always
 * qualified - none of these sentences asserts a medical conclusion.
 */
function buildPatientSummary({ regularity, longRrCount, quality, artifactCount }) {
  const parts = [];

  if (regularity === REGULARITY.REGULAR || regularity === REGULARITY.MOSTLY_REGULAR) {
    parts.push('Your heartbeat timing remained relatively consistent during this recording.');
  } else if (regularity === REGULARITY.VARIABLE || regularity === REGULARITY.HIGHLY_VARIABLE) {
    parts.push(
      'Some variation in heartbeat timing was observed during part of the recording. The affected portion may require further review.'
    );
  }

  if (longRrCount > 0) {
    parts.push(
      'A longer-than-usual interval between heartbeats was observed during part of the recording.'
    );
  }

  if (quality === SIGNAL_QUALITY.LIMITED || quality === SIGNAL_QUALITY.POOR) {
    parts.push(
      'The ECG signal was not sufficiently clear during part of the recording, so some measurements may be unreliable.'
    );
  } else if (artifactCount > 0) {
    parts.push(
      'A small number of heartbeats could not be measured reliably and were left out of the results.'
    );
  }

  parts.push(
    'This is an observation from the recorded signal and is not a medical diagnosis. Please discuss any concerns with a healthcare professional.'
  );

  return parts.join(' ');
}

/** Technical wording for clinical/engineering review (PART 11, PART 26). */
function buildTechnicalSummary({
  rr,
  hr,
  regularity,
  variation,
  beatToBeat,
  counts,
  quality,
  events,
}) {
  const fmt = (value, unit, decimals = 0) =>
    value === null || value === undefined ? 'n/a' : `${round(value, decimals)} ${unit}`;

  const lines = [
    `RR: mean ${fmt(rr.meanRR, 'ms')}, min ${fmt(rr.minRR, 'ms')}, max ${fmt(
      rr.maxRR,
      'ms'
    )}, SD ${fmt(rr.sdRR, 'ms', 1)}, CV ${fmt(rr.cvPercent, '%', 2)}.`,
    `HR: mean ${fmt(hr.meanHR, 'BPM')}, min ${fmt(hr.minHR, 'BPM')}, max ${fmt(
      hr.maxHR,
      'BPM'
    )} (derived as 60000/RR over analysable intervals).`,
    `Beat-to-beat: mean absolute successive RR difference ${fmt(
      beatToBeat.meanAbsDiff,
      'ms',
      1
    )}, maximum ${fmt(beatToBeat.maxAbsDiff, 'ms')} - classified ${variation}.`,
    `RR timing described as ${regularity} from the coefficient of variation.`,
    `Beat accounting: ${counts.beatsDetected} R peaks detected, ${counts.validBeats} analysable intervals, ${counts.invalidBeats} excluded, ${fmt(
      quality.usablePercentage,
      '%',
      2
    )} usable - signal quality ${quality.status}.`,
  ];

  const longRr = events.filter((e) => e.eventType === EVENT_TYPE.POSSIBLE_LONG_RR).length;
  const missed = events.filter((e) => e.eventType === EVENT_TYPE.POSSIBLE_MISSED_BEAT).length;
  const doubled = events.filter((e) => e.eventType === EVENT_TYPE.POSSIBLE_DOUBLE_DETECTION).length;

  if (longRr) {
    lines.push(
      `${longRr} interval(s) at or above the ${THRESHOLDS.LONG_RR_SCREEN_MS} ms screening threshold: possible prolonged RR interval detected; signal-quality review recommended.`
    );
  }
  if (missed) {
    lines.push(
      `${missed} interval(s) near an integer multiple of the reference RR - flagged as possible missed detections, not scored as physiological pauses.`
    );
  }
  if (doubled) {
    lines.push(
      `${doubled} interval(s) short enough to pair back into a single beat - flagged as possible double detections.`
    );
  }

  lines.push(
    'Screening output only. No rhythm classification (AF, arrhythmia, ectopy) is inferred from these timings.'
  );

  return lines.join(' ');
}

// -- Step 7: chart series --------------------------------------------

/**
 * Even-stride downsample that always keeps the first and last point, so the
 * chart's time axis still spans the whole recording.
 */
function downsample(points, maxPoints) {
  if (points.length <= maxPoints) return points;
  const stride = Math.ceil(points.length / maxPoints);
  const out = points.filter((_, i) => i % stride === 0);
  const last = points[points.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

/**
 * Time series for the RR and HR trend charts. Only analysable intervals appear,
 * so nothing artifactual is drawn as a real measurement (PART 20, PART 21).
 */
function buildSeries(classified, firstRPeak) {
  const points = classified.filter(isAnalysable).map((interval) => ({
    // Offset in seconds from the first R peak - a stable x axis that does not
    // depend on wall-clock alignment.
    offsetSec: round((interval.currentRPeak - firstRPeak) / 1000, 3),
    timestamp: interval.timestamp,
    rr: round(interval.rr),
    hr: round(hrFromRr(interval.rr), 1),
  }));

  return downsample(points, THRESHOLDS.MAX_SERIES_POINTS);
}

// -- Shared NN sequence ----------------------------------------------

/**
 * Build the validated NN sequence for a recording — the single source of truth
 * that every downstream report consumes.
 *
 * "NN" is the conventional name for RR intervals that have survived artifact
 * rejection: normal-to-normal. Producing them exactly once here is what keeps
 * the ECG/RR and HRV reports mathematically consistent, and is why no analyser
 * downstream ever re-derives a heartbeat sequence of its own.
 *
 * Each NN entry carries `precededByGap`, which is true when the interval
 * immediately before it in the recording was rejected. Successive-difference
 * metrics (beat-to-beat variation, RMSSD, pNN50) must not span such a gap: the
 * two intervals either side of a removed artifact are not actually consecutive,
 * and differencing across the splice invents variability that never occurred.
 *
 * @param {Array} rPeaks R-peak samples (see buildRrIntervals).
 * @returns {{classified:Array, nn:Array, counts:object, signalQuality:object,
 *   rejectedPeaks:number, firstRPeak:number|null}}
 */
function prepareNnSequence(rPeaks) {
  const { intervals, rejectedPeaks } = buildRrIntervals(rPeaks);

  if (!intervals.length) {
    return {
      classified: [],
      nn: [],
      counts: {
        beatsDetected: 0,
        validBeats: 0,
        invalidBeats: 0,
        rejectedPeaks,
        usablePercentage: null,
      },
      signalQuality: { status: SIGNAL_QUALITY.UNAVAILABLE, usablePercentage: null },
      rejectedPeaks,
      firstRPeak: null,
      totalRPeaks: (rPeaks || []).length,
    };
  }

  const classified = classifyRrIntervals(intervals);

  const nn = [];
  classified.forEach((interval, index) => {
    if (!isAnalysable(interval)) return;
    const previous = classified[index - 1];
    nn.push({
      nnMs: interval.rr,
      previousRPeak: interval.previousRPeak,
      rPeakTimestamp: interval.currentRPeak,
      timestamp: interval.timestamp,
      // First interval, or the one before it was rejected.
      precededByGap: !previous || !isAnalysable(previous),
    });
  });

  const beatsDetected = classified.length;
  const validBeats = nn.length;
  const quality = signalQuality(beatsDetected, validBeats);

  return {
    classified,
    nn,
    counts: {
      beatsDetected,
      validBeats,
      invalidBeats: beatsDetected - validBeats,
      rejectedPeaks,
      usablePercentage: round(quality.usablePercentage, 2),
    },
    signalQuality: quality,
    rejectedPeaks,
    firstRPeak: classified[0].previousRPeak,
    totalRPeaks: (rPeaks || []).length,
  };
}

/** True for a value produced by prepareNnSequence rather than a raw peak list. */
function isPrepared(value) {
  return !!value && !Array.isArray(value) && Array.isArray(value.classified);
}

// -- Orchestration ---------------------------------------------------

/**
 * Run the full ECG/RR analysis.
 *
 * @param {Array|object} input R-peak samples, or the object returned by
 *   prepareNnSequence when a caller is sharing one validated sequence across
 *   several reports.
 * @param {{recordingDurationSec?:number}} [options]
 * @returns {object} Analysis result. `available: false` means the recording
 *   could not support a report; the caller surfaces `unavailableReason` rather
 *   than showing zeroed-out statistics.
 */
function analyseEcgRr(input, options = {}) {
  const prepared = isPrepared(input) ? input : prepareNnSequence(input);
  const intervals = prepared.classified;
  const { rejectedPeaks } = prepared;

  // No usable pair of R peaks at all -> there is no RR data to report on.
  if (!intervals.length) {
    return {
      available: false,
      unavailableReason: 'no_data',
      unavailableMessage: 'No ECG/RR data is available for this session.',
      counts: {
        beatsDetected: prepared.totalRPeaks,
        validBeats: 0,
        invalidBeats: 0,
        rejectedPeaks,
        usablePercentage: null,
      },
      signalQuality: { status: SIGNAL_QUALITY.UNAVAILABLE, usablePercentage: null },
      events: [],
      series: [],
      recordingDurationSec: options.recordingDurationSec ?? null,
    };
  }

  const classified = intervals;
  const validRr = prepared.nn.map((n) => n.nnMs);

  const { beatsDetected, validBeats, invalidBeats } = prepared.counts;
  const quality = prepared.signalQuality;

  const beatToBeat = beatToBeatAnalysis(classified);
  const events = buildEvents(classified, beatToBeat);
  const firstRPeak = prepared.firstRPeak;

  const counts = prepared.counts;

  // Guard 1: too few analysable intervals to compute meaningful statistics.
  if (validBeats < THRESHOLDS.MIN_VALID_RR) {
    return {
      available: false,
      unavailableReason: 'insufficient_data',
      unavailableMessage: 'Not enough valid ECG data to generate this report.',
      counts,
      signalQuality: { status: quality.status, usablePercentage: counts.usablePercentage },
      events,
      series: buildSeries(classified, firstRPeak),
      recordingDurationSec: options.recordingDurationSec ?? null,
    };
  }

  // Guard 2: enough intervals, but too large a share of the recording is
  // artifact for the numbers to be trusted (PART 13).
  if (quality.usablePercentage <= THRESHOLDS.MIN_USABLE_PCT) {
    return {
      available: false,
      unavailableReason: 'poor_signal_quality',
      unavailableMessage:
        'The ECG signal was not sufficiently clear for reliable analysis during this recording.',
      counts,
      signalQuality: { status: quality.status, usablePercentage: counts.usablePercentage },
      events,
      series: buildSeries(classified, firstRPeak),
      recordingDurationSec: options.recordingDurationSec ?? null,
    };
  }

  const rr = rrStatistics(validRr);
  const hr = hrStatistics(validRr);
  const regularity = rhythmRegularity(rr.cvPercent);
  const longRrCount = events.filter((e) => e.eventType === EVENT_TYPE.POSSIBLE_LONG_RR).length;

  // Recording duration measured from the R peaks themselves, falling back to the
  // session's own duration when supplied by the caller.
  const spanSec = (classified[classified.length - 1].currentRPeak - firstRPeak) / 1000;
  const recordingDurationSec = options.recordingDurationSec ?? round(spanSec, 1);

  return {
    available: true,
    unavailableReason: null,
    unavailableMessage: null,
    recordingDurationSec,
    counts,
    rr: {
      meanRR: round(rr.meanRR),
      minRR: round(rr.minRR),
      maxRR: round(rr.maxRR),
      sdRR: round(rr.sdRR, 1),
      cvPercent: round(rr.cvPercent, 2),
    },
    hr: {
      meanHR: round(hr.meanHR),
      minHR: round(hr.minHR),
      maxHR: round(hr.maxHR),
    },
    beatToBeat: {
      meanAbsDiffMs: round(beatToBeat.meanAbsDiff, 1),
      maxAbsDiffMs: round(beatToBeat.maxAbsDiff),
      variation: beatToBeat.variation,
    },
    rhythm: {
      regularity,
      beatToBeatVariation: beatToBeat.variation,
      longRrEventCount: longRrCount,
    },
    signalQuality: { status: quality.status, usablePercentage: counts.usablePercentage },
    events,
    series: buildSeries(classified, firstRPeak),
    patientSummary: buildPatientSummary({
      regularity,
      longRrCount,
      quality: quality.status,
      artifactCount: invalidBeats,
    }),
    technicalSummary: buildTechnicalSummary({
      rr,
      hr,
      regularity,
      variation: beatToBeat.variation,
      beatToBeat,
      counts,
      quality,
      events,
    }),
  };
}

module.exports = {
  analyseEcgRr,
  prepareNnSequence,
  buildRrIntervals,
  classifyRrIntervals,
  rrStatistics,
  hrStatistics,
  hrFromRr,
  beatToBeatAnalysis,
  rhythmRegularity,
  signalQuality,
  referenceRR,
  buildEvents,
  THRESHOLDS,
  RR_QUALITY,
  EVENT_TYPE,
  REGULARITY,
  VARIATION,
  SIGNAL_QUALITY,
};
