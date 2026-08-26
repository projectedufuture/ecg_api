/**
 * Rhythm screening.
 *
 * Flags potentially unusual heart-rate and rhythm patterns for review. This is a
 * SCREENING module, not an ECG interpretation system.
 *
 * ARCHITECTURAL CONSTRAINT
 * Consumes the validated NN sequence and the already-computed ECG/RR events from
 * ecgRrAnalysis.js. It has no R-peak detector, no RR validator and no pause
 * detector of its own — long-RR, missed-beat and double-detection findings are
 * reused, not recomputed, so every report describes the same beats.
 *
 * Heart rate is derived from the validated RR sequence (60000/NN), not from the
 * device's HR field, because RR timing is the higher-resolution source and the
 * HR field carries a sentinel (0) when unmeasured.
 *
 * SCOPE AND WORDING
 * Never emits a diagnosis. There is no path in this file that can produce "atrial
 * fibrillation", "arrhythmia", "heart block", "PVC", "PAC" or similar: an
 * irregular RR sequence on a wearable garment has many benign and many technical
 * explanations, and RR timing alone cannot distinguish them.
 */

const {
  rhythmRegularity,
  REGULARITY,
  EVENT_TYPE,
  SIGNAL_QUALITY,
} = require('./ecgRrAnalysis');

// -- Thresholds -------------------------------------------------------
const RHYTHM_THRESHOLDS = {
  /**
   * Resting screening references. Deliberately NOT called abnormality
   * thresholds: activity raises HR and trained individuals rest low, so an
   * excursion past these is an observation needing context, not a finding.
   */
  ELEVATED_HR_BPM: 100,
  LOW_HR_BPM: 60,

  /**
   * A run must persist for this long before it becomes a period. A couple of
   * beats past a threshold is noise; a sustained stretch is worth surfacing.
   */
  MIN_PERIOD_SEC: 10,
  MIN_PERIOD_BEATS: 8,

  /** Consecutive qualifying beats may be this far apart and still be one period. */
  PERIOD_GAP_TOLERANCE_SEC: 5,

  // Irregularity is assessed on a sliding window of the NN sequence.
  IRREGULARITY_WINDOW_BEATS: 30,
  IRREGULARITY_HOP_BEATS: 15,
  /** Window CV% above which that stretch counts as irregular. */
  IRREGULARITY_CV_PCT: 12,
  /**
   * How much of an irregularity window may be missing time (removed artifacts)
   * before the window is not a contiguous stretch of the recording any more.
   */
  MAX_WINDOW_GAP_FRACTION: 0.2,

  // Minimum usable data before any screening conclusion is drawn at all.
  MIN_NN_FOR_SCREENING: 20,
  /** Usable share of detected beats required before conclusions are offered. */
  MIN_USABLE_PCT: 60,

  // Confidence in the rhythm-pattern classification.
  CONFIDENCE_STRONG_BEATS: 200,
  CONFIDENCE_MIN_BEATS: 30,
};

const RHYTHM_STATUS = {
  SUCCESS: 'success',
  INSUFFICIENT_DATA: 'insufficient_data',
  POOR_SIGNAL_QUALITY: 'poor_signal_quality',
  NO_DATA: 'no_data',
};

/** Non-diagnostic by construction. */
const RHYTHM_EVENT_TYPE = {
  ELEVATED_HEART_RATE: 'elevated_heart_rate',
  LOW_HEART_RATE: 'low_heart_rate',
  IRREGULAR_RR: 'irregular_rr_period',
  POSSIBLE_LONG_RR: 'possible_long_rr',
  POSSIBLE_MISSED_BEAT: 'possible_missed_beat',
  POSSIBLE_DOUBLE_DETECTION: 'possible_double_detection',
  SIGNAL_QUALITY_DROP: 'signal_quality_drop',
};

function round(value, decimals = 0) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stdDev(values) {
  if (values.length < 2) return null;
  const m = mean(values);
  return Math.sqrt(values.reduce((acc, v) => acc + (v - m) ** 2, 0) / values.length);
}

/** Instantaneous HR from an NN interval. Guarded against divide-by-zero. */
function hrFromNn(nnMs) {
  if (!Number.isFinite(nnMs) || nnMs <= 0) return null;
  return 60000 / nnMs;
}

// -- Period aggregation -----------------------------------------------

/**
 * Group consecutive qualifying beats into periods.
 *
 * Without this a two-minute elevated stretch would emit hundreds of per-beat
 * events. A run becomes a period only once it is long enough in both time and
 * beat count, so a couple of stray beats never generate a finding.
 *
 * @param {Array} beats Beats with {timeSec, hrBpm, timestamp, rPeakTimestamp}.
 * @param {(beat:object)=>boolean} qualifies
 */
function aggregatePeriods(beats, qualifies) {
  const periods = [];
  let run = [];

  const flush = () => {
    if (!run.length) return;
    const durationSec = run[run.length - 1].timeSec - run[0].timeSec;
    if (
      durationSec >= RHYTHM_THRESHOLDS.MIN_PERIOD_SEC &&
      run.length >= RHYTHM_THRESHOLDS.MIN_PERIOD_BEATS
    ) {
      const rates = run.map((b) => b.hrBpm);
      periods.push({
        startSec: round(run[0].timeSec, 1),
        endSec: round(run[run.length - 1].timeSec, 1),
        durationSec: round(durationSec, 1),
        beats: run.length,
        meanHrBpm: round(mean(rates)),
        minHrBpm: round(Math.min(...rates)),
        maxHrBpm: round(Math.max(...rates)),
        startTimestamp: run[0].timestamp,
        endTimestamp: run[run.length - 1].timestamp,
        rPeakTimestamp: run[0].rPeakTimestamp,
      });
    }
    run = [];
  };

  for (const beat of beats) {
    if (!qualifies(beat)) {
      flush();
      continue;
    }
    // A short non-qualifying gap does not break the run.
    if (run.length && beat.timeSec - run[run.length - 1].timeSec > RHYTHM_THRESHOLDS.PERIOD_GAP_TOLERANCE_SEC) {
      flush();
    }
    run.push(beat);
  }
  flush();

  return periods;
}

/**
 * Stretches of the recording where the NN sequence is unusually variable.
 *
 * Computed on a sliding window so a brief irregular passage inside an otherwise
 * regular recording is still surfaced, then merged into contiguous periods.
 */
function findIrregularPeriods(beats) {
  const win = RHYTHM_THRESHOLDS.IRREGULARITY_WINDOW_BEATS;
  const hop = RHYTHM_THRESHOLDS.IRREGULARITY_HOP_BEATS;
  if (beats.length < win) return [];

  const flagged = [];
  for (let start = 0; start + win <= beats.length; start += hop) {
    const window = beats.slice(start, start + win);

    /**
     * Only assess windows that really are a contiguous stretch of the recording.
     *
     * Tested by comparing the window's wall-clock span against the sum of its NN
     * intervals: if beats were removed in between, the span exceeds the sum by
     * the length of the hole. Rejecting on the gap FLAG alone would be far too
     * blunt — an irregular passage naturally contains scattered rejections, and
     * flag-based rejection would skip exactly the windows worth assessing.
     */
    const spanSec = window[window.length - 1].timeSec - window[0].timeSec;
    const coveredSec = window.slice(1).reduce((acc, b) => acc + b.nnMs / 1000, 0);
    if (spanSec <= 0) continue;
    if ((spanSec - coveredSec) / spanSec > RHYTHM_THRESHOLDS.MAX_WINDOW_GAP_FRACTION) continue;

    const nn = window.map((b) => b.nnMs);
    const m = mean(nn);
    const sd = stdDev(nn);
    if (!m || sd === null) continue;
    const cv = (sd / m) * 100;

    if (cv >= RHYTHM_THRESHOLDS.IRREGULARITY_CV_PCT) {
      flagged.push({
        startSec: window[0].timeSec,
        endSec: window[window.length - 1].timeSec,
        cvPercent: cv,
        startTimestamp: window[0].timestamp,
        rPeakTimestamp: window[0].rPeakTimestamp,
      });
    }
  }

  // Merge overlapping windows into single periods.
  const merged = [];
  for (const f of flagged) {
    const last = merged[merged.length - 1];
    if (last && f.startSec <= last.endSec) {
      last.endSec = Math.max(last.endSec, f.endSec);
      last.peakCvPercent = Math.max(last.peakCvPercent, f.cvPercent);
    } else {
      merged.push({
        startSec: f.startSec,
        endSec: f.endSec,
        peakCvPercent: f.cvPercent,
        startTimestamp: f.startTimestamp,
        rPeakTimestamp: f.rPeakTimestamp,
      });
    }
  }

  return merged.map((m) => ({
    startSec: round(m.startSec, 1),
    endSec: round(m.endSec, 1),
    durationSec: round(m.endSec - m.startSec, 1),
    peakCvPercent: round(m.peakCvPercent, 2),
    startTimestamp: m.startTimestamp,
    rPeakTimestamp: m.rPeakTimestamp,
  }));
}

/**
 * How much weight the rhythm-pattern label can carry, from how much clean data
 * backs it. Not a probability — a stated confidence in the classification.
 */
function classificationConfidence(beatCount, usablePercentage) {
  if (beatCount < RHYTHM_THRESHOLDS.CONFIDENCE_MIN_BEATS) return 0.3;
  const beatScore = Math.min(1, beatCount / RHYTHM_THRESHOLDS.CONFIDENCE_STRONG_BEATS);
  const qualityScore = usablePercentage === null ? 0.7 : Math.min(1, usablePercentage / 100);
  return round(0.4 + 0.6 * beatScore * qualityScore, 2);
}

// -- Narrative --------------------------------------------------------

function buildPatientSummary({ pattern, elevated, low, irregular, longRr, signalQuality }) {
  const parts = [];

  if (pattern === REGULARITY.REGULAR || pattern === REGULARITY.MOSTLY_REGULAR) {
    parts.push(
      'Your heartbeat timing remained relatively consistent during the analyzed recording.'
    );
  } else {
    parts.push('Some variation in heartbeat timing was observed during the recording.');
  }

  if (elevated > 0) {
    parts.push(
      'A period of elevated heart rate was observed. Heart rate can naturally increase with movement or activity.'
    );
  }

  if (low > 0) {
    parts.push(
      'A period of low heart rate was observed. A lower heart rate is common at rest and in physically fit people.'
    );
  }

  if (irregular > 0) {
    parts.push(
      'Irregular heartbeat timing was observed during part of the recording. Further evaluation may be appropriate.'
    );
  }

  if (longRr > 0) {
    parts.push(
      'A longer-than-usual interval between heartbeats was observed during part of the recording.'
    );
  }

  if (signalQuality === SIGNAL_QUALITY.LIMITED || signalQuality === SIGNAL_QUALITY.POOR) {
    parts.push(
      'The ECG signal was not clear enough during part of the recording to reliably assess the heartbeat pattern.'
    );
  }

  parts.push(
    'This is a screening observation from the recorded signal, not a diagnosis. Please discuss any concerns with a healthcare professional.'
  );

  return parts.join(' ');
}

function buildTechnicalSummary({
  pattern,
  confidence,
  hr,
  counts,
  screening,
  signalQuality,
  usablePercentage,
}) {
  const fmt = (v, unit, dp = 0) => (v === null || v === undefined ? 'n/a' : `${round(v, dp)} ${unit}`);

  const lines = [
    `RR-derived heart rate: mean ${fmt(hr.meanHr, 'BPM')}, range ${fmt(hr.minHr, '')}-${fmt(
      hr.maxHr,
      'BPM'
    )} over ${counts.validBeats} validated intervals.`,
    `RR timing classified ${pattern} (classification confidence ${confidence}).`,
    `Screening periods: ${screening.elevatedHRPeriods} elevated-HR (>${RHYTHM_THRESHOLDS.ELEVATED_HR_BPM} BPM), ${screening.lowHRPeriods} low-HR (<${RHYTHM_THRESHOLDS.LOW_HR_BPM} BPM), ${screening.irregularRRPeriods} irregular-RR (window CV >= ${RHYTHM_THRESHOLDS.IRREGULARITY_CV_PCT}%).`,
    `Quality flags carried over from ECG/RR analysis: ${screening.possibleLongRREvents} possible long RR, ${screening.possibleMissedBeats} possible missed beat, ${screening.possibleDoubleDetections} possible double detection.`,
    `Signal quality ${signalQuality}, ${fmt(usablePercentage, '%', 2)} of detected beats usable.`,
    `HR thresholds are resting screening references, not abnormality thresholds; activity raises heart rate and trained individuals rest below ${RHYTHM_THRESHOLDS.LOW_HR_BPM} BPM. Without activity context these periods require interpretation.`,
    'Screening output only. No rhythm diagnosis (AF, flutter, ectopy, block) is inferred from RR timing.',
  ];

  return lines.join(' ');
}

// -- Orchestration ----------------------------------------------------

function unavailable(status, message, prepared) {
  const counts = prepared.counts || {};
  return {
    status,
    message,
    summary: null,
    screening: null,
    signalQuality: {
      status: prepared.signalQuality ? prepared.signalQuality.status : SIGNAL_QUALITY.UNAVAILABLE,
      usablePercentage: counts.usablePercentage ?? null,
      beatsDetected: counts.beatsDetected ?? 0,
      validBeats: counts.validBeats ?? 0,
      invalidBeats: counts.invalidBeats ?? 0,
    },
    events: [],
    patientSummary: null,
    technicalSummary: null,
  };
}

/**
 * Run rhythm screening.
 *
 * @param {object} prepared From `prepareNnSequence`.
 * @param {{ecgRrEvents?:Array, recordingDurationSec?:number}} [options]
 *   `ecgRrEvents` are the events already produced by the ECG/RR analysis; they
 *   are reused rather than recomputed.
 */
function screenRhythm(prepared, options = {}) {
  if (!prepared || !Array.isArray(prepared.nn)) {
    throw new TypeError(
      'screenRhythm requires the prepared NN sequence from prepareNnSequence(); ' +
        'rhythm screening must not derive its own heartbeat sequence.'
    );
  }

  const counts = prepared.counts || {};
  const quality = prepared.signalQuality || { status: SIGNAL_QUALITY.UNAVAILABLE };
  const nn = prepared.nn;

  if (!nn.length) {
    return unavailable(
      RHYTHM_STATUS.NO_DATA,
      'No ECG/RR data is available for this session, so the heartbeat pattern cannot be assessed.',
      prepared
    );
  }

  if (nn.length < RHYTHM_THRESHOLDS.MIN_NN_FOR_SCREENING) {
    return unavailable(
      RHYTHM_STATUS.INSUFFICIENT_DATA,
      'Not enough valid heartbeat intervals to screen the heartbeat pattern.',
      prepared
    );
  }

  // The quality gate. Below this the ECG is not trusted to support any rhythm
  // conclusion, no matter how many intervals survived.
  if (
    counts.usablePercentage !== null &&
    counts.usablePercentage !== undefined &&
    counts.usablePercentage < RHYTHM_THRESHOLDS.MIN_USABLE_PCT
  ) {
    return unavailable(
      RHYTHM_STATUS.POOR_SIGNAL_QUALITY,
      'The ECG signal was not clear enough during this recording to reliably assess the heartbeat pattern.',
      prepared
    );
  }

  // Per-beat view, timed from the first R peak of the recording.
  const firstRPeak = prepared.firstRPeak ?? nn[0].previousRPeak;
  const beats = nn.map((entry) => ({
    timeSec: (entry.rPeakTimestamp - firstRPeak) / 1000,
    nnMs: entry.nnMs,
    hrBpm: hrFromNn(entry.nnMs),
    timestamp: entry.timestamp,
    rPeakTimestamp: entry.rPeakTimestamp,
    precededByGap: entry.precededByGap,
  }));

  const rates = beats.map((b) => b.hrBpm).filter((v) => v !== null);
  const hr = {
    meanHr: mean(rates),
    minHr: rates.length ? Math.min(...rates) : null,
    maxHr: rates.length ? Math.max(...rates) : null,
  };

  const elevatedPeriods = aggregatePeriods(
    beats,
    (b) => b.hrBpm !== null && b.hrBpm > RHYTHM_THRESHOLDS.ELEVATED_HR_BPM
  );
  const lowPeriods = aggregatePeriods(
    beats,
    (b) => b.hrBpm !== null && b.hrBpm < RHYTHM_THRESHOLDS.LOW_HR_BPM
  );
  const irregularPeriods = findIrregularPeriods(beats);

  // Reuse the ECG/RR quality findings rather than detecting pauses again.
  const carried = options.ecgRrEvents || [];
  const countOf = (type) => carried.filter((e) => e.eventType === type).length;
  const possibleLongRREvents = countOf(EVENT_TYPE.POSSIBLE_LONG_RR);
  const possibleMissedBeats = countOf(EVENT_TYPE.POSSIBLE_MISSED_BEAT);
  const possibleDoubleDetections = countOf(EVENT_TYPE.POSSIBLE_DOUBLE_DETECTION);

  // Rhythm pattern from the whole-recording CV, using the same classifier the
  // ECG/RR report uses so the two labels can never disagree.
  const allNn = nn.map((entry) => entry.nnMs);
  const overallMean = mean(allNn);
  const overallSd = stdDev(allNn);
  const cvPercent = overallMean && overallSd !== null ? (overallSd / overallMean) * 100 : null;
  const pattern = rhythmRegularity(cvPercent);
  const confidence = classificationConfidence(nn.length, counts.usablePercentage ?? null);

  // Event list: aggregated periods plus the carried-over quality flags.
  const events = [];

  for (const p of elevatedPeriods) {
    events.push({
      eventType: RHYTHM_EVENT_TYPE.ELEVATED_HEART_RATE,
      startSec: p.startSec,
      endSec: p.endSec,
      durationSec: p.durationSec,
      timestamp: p.startTimestamp,
      rPeakTimestamp: p.rPeakTimestamp,
      heartRateBpm: p.maxHrBpm,
      meanHeartRateBpm: p.meanHrBpm,
      beats: p.beats,
      // Without activity/rest context this is an observation, not tachycardia.
      requiresContext: true,
      requiresQualityReview: false,
      description: `Elevated heart-rate period: peak ${p.maxHrBpm} BPM, mean ${p.meanHrBpm} BPM over ${p.durationSec} s. Heart rate rises naturally with activity; no activity context is available for this recording.`,
    });
  }

  for (const p of lowPeriods) {
    events.push({
      eventType: RHYTHM_EVENT_TYPE.LOW_HEART_RATE,
      startSec: p.startSec,
      endSec: p.endSec,
      durationSec: p.durationSec,
      timestamp: p.startTimestamp,
      rPeakTimestamp: p.rPeakTimestamp,
      heartRateBpm: p.minHrBpm,
      meanHeartRateBpm: p.meanHrBpm,
      beats: p.beats,
      requiresContext: true,
      requiresQualityReview: false,
      description: `Low heart-rate period: minimum ${p.minHrBpm} BPM, mean ${p.meanHrBpm} BPM over ${p.durationSec} s. A low resting heart rate is common in physically fit individuals.`,
    });
  }

  for (const p of irregularPeriods) {
    events.push({
      eventType: RHYTHM_EVENT_TYPE.IRREGULAR_RR,
      startSec: p.startSec,
      endSec: p.endSec,
      durationSec: p.durationSec,
      timestamp: p.startTimestamp,
      rPeakTimestamp: p.rPeakTimestamp,
      cvPercent: p.peakCvPercent,
      requiresContext: true,
      requiresQualityReview: false,
      description: `Irregular heartbeat timing detected over ${p.durationSec} s (peak beat-to-beat variation ${p.peakCvPercent}%). Further clinical evaluation may be appropriate.`,
    });
  }

  // Carried-over ECG/RR quality flags, marked as needing a signal review rather
  // than presented as physiological findings.
  for (const e of carried) {
    if (
      e.eventType === EVENT_TYPE.POSSIBLE_LONG_RR ||
      e.eventType === EVENT_TYPE.POSSIBLE_MISSED_BEAT ||
      e.eventType === EVENT_TYPE.POSSIBLE_DOUBLE_DETECTION
    ) {
      events.push({
        eventType: e.eventType,
        startSec: null,
        endSec: null,
        durationSec: e.durationMs !== undefined ? round(e.durationMs / 1000, 2) : null,
        timestamp: e.timestamp,
        rPeakTimestamp: e.rPeakTimestamp,
        rrValue: e.rrValue,
        requiresContext: false,
        requiresQualityReview: e.eventType !== EVENT_TYPE.POSSIBLE_LONG_RR,
        description: e.description,
      });
    }
  }

  events.sort((a, b) => (a.rPeakTimestamp || 0) - (b.rPeakTimestamp || 0));

  const screening = {
    elevatedHRPeriods: elevatedPeriods.length,
    lowHRPeriods: lowPeriods.length,
    irregularRRPeriods: irregularPeriods.length,
    possibleLongRREvents,
    possibleMissedBeats,
    possibleDoubleDetections,
  };

  return {
    status: RHYTHM_STATUS.SUCCESS,
    message: null,
    summary: {
      rhythmPattern: pattern,
      classificationConfidence: confidence,
      averageHR: round(hr.meanHr),
      minimumHR: round(hr.minHr),
      maximumHR: round(hr.maxHr),
      rrCvPercent: round(cvPercent, 2),
      analysedBeats: nn.length,
      recordingDurationSec:
        options.recordingDurationSec ?? round(beats[beats.length - 1].timeSec, 1),
    },
    screening,
    signalQuality: {
      status: quality.status,
      usablePercentage: counts.usablePercentage ?? null,
      beatsDetected: counts.beatsDetected ?? 0,
      validBeats: counts.validBeats ?? 0,
      invalidBeats: counts.invalidBeats ?? 0,
    },
    events,
    patientSummary: buildPatientSummary({
      pattern,
      elevated: elevatedPeriods.length,
      low: lowPeriods.length,
      irregular: irregularPeriods.length,
      longRr: possibleLongRREvents,
      signalQuality: quality.status,
    }),
    technicalSummary: buildTechnicalSummary({
      pattern,
      confidence,
      hr,
      counts,
      screening,
      signalQuality: quality.status,
      usablePercentage: counts.usablePercentage ?? null,
    }),
  };
}

module.exports = {
  screenRhythm,
  aggregatePeriods,
  findIrregularPeriods,
  classificationConfidence,
  hrFromNn,
  RHYTHM_THRESHOLDS,
  RHYTHM_STATUS,
  RHYTHM_EVENT_TYPE,
};
