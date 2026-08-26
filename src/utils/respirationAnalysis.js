/**
 * Respiration rate estimation.
 *
 * Two independent estimators, cross-checked against each other:
 *
 *   ECG-derived (EDR) via respiratory sinus arrhythmia — breathing modulates
 *   the NN interval sequence, so the tachogram carries a respiratory rhythm.
 *
 *   PPG-derived via baseline modulation of the raw photoplethysmogram.
 *
 * ARCHITECTURAL CONSTRAINT
 * The EDR path consumes the validated NN sequence from `prepareNnSequence` in
 * ecgRrAnalysis.js. It has no R-peak detector of its own, so respiration,
 * rhythm, HRV and ECG/RR all describe the same beats.
 *
 * The PPG path requires the raw IR/RED waveform. The final SpO2 percentage
 * carries no waveform and is never used as a substitute: when raw PPG is absent
 * the estimate is reported unavailable, with the reason.
 *
 * SCOPE AND WORDING
 * A screening measurement, not a diagnosis. Nothing here infers apnoea,
 * respiratory disease, or any clinical condition.
 */

const {
  mean,
  resampleUniform,
  detrend,
  hannWindow,
  bandPowerSpectrum,
  dominantPeak,
} = require('./signalSpectrum');

// -- Thresholds -------------------------------------------------------
const RESP_THRESHOLDS = {
  // Respiratory band. 0.1 Hz = 6 breaths/min, 0.5 Hz = 30 breaths/min — wide
  // enough to cover rest through moderate exertion without admitting the
  // cardiac component (~1 Hz) or slow baseline drift.
  BAND_LOW_HZ: 0.1,
  BAND_HIGH_HZ: 0.5,
  // Evaluation step; ~0.3 breaths/min. Finer than the true resolution, which is
  // reported separately.
  BAND_STEP_HZ: 0.005,

  // Tachogram resampling rate. 4 Hz is the conventional choice for RR series and
  // leaves Nyquist (2 Hz) far above the respiratory band.
  EDR_RESAMPLE_HZ: 4,

  // Raw PPG is decimated to this before analysis; the respiratory component is
  // well under 1 Hz so a high native rate buys nothing and costs time.
  PPG_RESAMPLE_HZ: 4,

  /**
   * Minimum analysed duration. Frequency resolution is ~1/T, so 60 s gives
   * ~0.017 Hz ≈ 1 breath/min — the shortest window that can distinguish
   * neighbouring rates at all.
   */
  MIN_DURATION_SEC: 60,

  // Fewer NN intervals than this cannot support a tachogram.
  MIN_NN_INTERVALS: 40,
  // Fewer raw PPG samples than this cannot support a spectrum.
  MIN_PPG_SAMPLES: 240,

  /**
   * Peak prominence (peak power / mean band power) required before a spectral
   * peak is called a respiratory rhythm rather than noise.
   */
  MIN_PROMINENCE: 3,
  STRONG_PROMINENCE: 8,

  // Agreement window between the two estimates, in breaths/min.
  AGREEMENT_BREATHS_PER_MIN: 3,

  // Plausibility band for resting adults. A quality check, NOT an abnormality
  // threshold: exercise, sleep, age and illness all move the true rate outside
  // it legitimately, so a value outside this range lowers confidence and is
  // labelled, never flagged as abnormal.
  PLAUSIBLE_LOW_BPM: 12,
  PLAUSIBLE_HIGH_BPM: 20,

  // Beyond this the estimate is treated as implausible for any resting or light
  // activity recording and is suppressed.
  HARD_LOW_BPM: 5,
  HARD_HIGH_BPM: 35,

  // Artifact share of candidate intervals above which EDR is not trusted.
  MAX_ARTIFACT_PCT: 30,

  // Windowed trend: window length and hop, in seconds.
  TREND_WINDOW_SEC: 60,
  TREND_HOP_SEC: 30,
};

const RESP_STATUS = {
  SUCCESS: 'success',
  INSUFFICIENT_DATA: 'insufficient_data',
  POOR_SIGNAL_QUALITY: 'poor_signal_quality',
  DISAGREEMENT: 'disagreement',
  NO_DATA: 'no_data',
};

const CONFIDENCE = {
  HIGH: 'High',
  MODERATE: 'Moderate',
  LOW: 'Low',
  UNAVAILABLE: 'Unavailable',
};

const ESTIMATE_QUALITY = {
  GOOD: 'Good',
  FAIR: 'Fair',
  POOR: 'Poor',
  UNAVAILABLE: 'Unavailable',
};

function round(value, decimals = 0) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Frequency in Hz to breaths per minute. */
function hzToBreathsPerMin(hz) {
  if (!Number.isFinite(hz) || hz <= 0) return null;
  return hz * 60;
}

// -- Core estimator ---------------------------------------------------

/**
 * Pull a dominant respiratory frequency out of a uniformly sampled signal.
 * Shared by both estimators so they are scored identically.
 */
function estimateFromUniformSignal(values, rateHz) {
  if (!values || values.length < 8) return null;

  const prepared = hannWindow(detrend(values));
  const spectrum = bandPowerSpectrum(
    prepared,
    rateHz,
    RESP_THRESHOLDS.BAND_LOW_HZ,
    RESP_THRESHOLDS.BAND_HIGH_HZ,
    RESP_THRESHOLDS.BAND_STEP_HZ
  );
  const peak = dominantPeak(spectrum);
  if (!peak) return null;

  return {
    rateBpm: round(hzToBreathsPerMin(peak.freqHz), 1),
    freqHz: round(peak.freqHz, 4),
    prominence: round(peak.prominence, 2),
    resolutionHz: round(spectrum.resolutionHz, 4),
    resolutionBpm: round(hzToBreathsPerMin(spectrum.resolutionHz), 2),
  };
}

/** Grade one estimate from its peak prominence and the duration behind it. */
function gradeEstimate(estimate, durationSec) {
  if (!estimate) return ESTIMATE_QUALITY.UNAVAILABLE;
  if (estimate.prominence < RESP_THRESHOLDS.MIN_PROMINENCE) return ESTIMATE_QUALITY.POOR;
  if (
    estimate.prominence >= RESP_THRESHOLDS.STRONG_PROMINENCE &&
    durationSec >= RESP_THRESHOLDS.MIN_DURATION_SEC * 2
  ) {
    return ESTIMATE_QUALITY.GOOD;
  }
  return ESTIMATE_QUALITY.FAIR;
}

/** True when a rate is physiologically plausible enough to report at all. */
function isReportable(rateBpm) {
  return (
    Number.isFinite(rateBpm) &&
    rateBpm >= RESP_THRESHOLDS.HARD_LOW_BPM &&
    rateBpm <= RESP_THRESHOLDS.HARD_HIGH_BPM
  );
}

// -- ECG-derived respiration (RSA) ------------------------------------

/**
 * Estimate respiration from the NN tachogram.
 *
 * @param {Array<{nnMs:number, rPeakTimestamp:number, precededByGap:boolean}>} nn
 *   The validated NN sequence.
 * @returns {{available:boolean, reason?:string, ...}}
 */
function estimateEdr(nn) {
  // Two intervals is the floor for a tachogram of any kind.
  if (!nn || nn.length < 2) {
    return {
      available: false,
      reason: 'insufficient_nn_intervals',
      detail: `Needs at least ${RESP_THRESHOLDS.MIN_NN_INTERVALS} clean NN intervals; got ${
        nn ? nn.length : 0
      }.`,
    };
  }

  // Tachogram: NN value against the time of the beat that closed it.
  const t = nn.map((entry) => entry.rPeakTimestamp / 1000);
  const v = nn.map((entry) => entry.nnMs);

  // Duration is checked before interval count: it is the binding constraint on
  // frequency resolution, so it is the more informative reason to report when
  // both fail on a short recording.
  const durationSec = t[t.length - 1] - t[0];
  if (durationSec < RESP_THRESHOLDS.MIN_DURATION_SEC) {
    return {
      available: false,
      reason: 'recording_too_short',
      detail: `Needs at least ${RESP_THRESHOLDS.MIN_DURATION_SEC} s of clean beats; got ${round(
        durationSec
      )} s.`,
      durationSec: round(durationSec, 1),
    };
  }

  if (nn.length < RESP_THRESHOLDS.MIN_NN_INTERVALS) {
    return {
      available: false,
      reason: 'insufficient_nn_intervals',
      detail: `Needs at least ${RESP_THRESHOLDS.MIN_NN_INTERVALS} clean NN intervals; got ${nn.length}.`,
      durationSec: round(durationSec, 1),
    };
  }

  const resampled = resampleUniform(t, v, RESP_THRESHOLDS.EDR_RESAMPLE_HZ);
  if (!resampled) {
    return { available: false, reason: 'resample_failed', detail: 'Could not build an even tachogram.' };
  }

  const estimate = estimateFromUniformSignal(resampled.values, resampled.rateHz);
  if (!estimate) {
    return { available: false, reason: 'no_spectral_peak', detail: 'No respiratory peak found.' };
  }

  return {
    available: true,
    method: 'rsa_tachogram',
    durationSec: round(durationSec, 1),
    intervalsUsed: nn.length,
    ...estimate,
    quality: gradeEstimate(estimate, durationSec),
  };
}

// -- PPG-derived respiration ------------------------------------------

/**
 * Estimate respiration from the raw PPG baseline.
 *
 * @param {Array<{t:number, value:number}>} samples Raw PPG (IR preferred),
 *   `t` in seconds. Absent entirely when the firmware does not stream a
 *   waveform — the SpO2 percentage is not an acceptable substitute.
 */
function estimatePpg(samples) {
  if (!samples || !samples.length) {
    return {
      available: false,
      reason: 'raw_ppg_not_recorded',
      detail:
        'No raw PPG waveform was recorded for this session. PPG-derived respiration needs the IR/RED sample stream; the SpO2 percentage alone cannot substitute for it.',
    };
  }

  if (samples.length < RESP_THRESHOLDS.MIN_PPG_SAMPLES) {
    return {
      available: false,
      reason: 'insufficient_ppg_samples',
      detail: `Needs at least ${RESP_THRESHOLDS.MIN_PPG_SAMPLES} raw PPG samples; got ${samples.length}.`,
    };
  }

  const t = samples.map((s) => s.t);
  const v = samples.map((s) => s.value);
  const durationSec = t[t.length - 1] - t[0];

  if (durationSec < RESP_THRESHOLDS.MIN_DURATION_SEC) {
    return {
      available: false,
      reason: 'recording_too_short',
      detail: `Needs at least ${RESP_THRESHOLDS.MIN_DURATION_SEC} s of PPG; got ${round(durationSec)} s.`,
      durationSec: round(durationSec, 1),
    };
  }

  // Decimating to 4 Hz also low-passes away the cardiac component (~1 Hz and
  // its harmonics), leaving the slow baseline that respiration modulates.
  const resampled = resampleUniform(t, v, RESP_THRESHOLDS.PPG_RESAMPLE_HZ);
  if (!resampled) {
    return { available: false, reason: 'resample_failed', detail: 'Could not resample the PPG.' };
  }

  const estimate = estimateFromUniformSignal(resampled.values, resampled.rateHz);
  if (!estimate) {
    return { available: false, reason: 'no_spectral_peak', detail: 'No respiratory peak found.' };
  }

  return {
    available: true,
    method: 'ppg_baseline_modulation',
    durationSec: round(durationSec, 1),
    samplesUsed: samples.length,
    ...estimate,
    quality: gradeEstimate(estimate, durationSec),
  };
}

// -- Windowed trend ---------------------------------------------------

/**
 * Respiration across the recording, one estimate per sliding window.
 *
 * Windows whose peak is not prominent enough are emitted with a null rate and
 * `usable: false` rather than dropped, so the UI can show where the estimate was
 * unreliable instead of silently interpolating across it.
 */
function buildTrend(nn) {
  if (!nn || nn.length < RESP_THRESHOLDS.MIN_NN_INTERVALS) return [];

  const t = nn.map((entry) => entry.rPeakTimestamp / 1000);
  const v = nn.map((entry) => entry.nnMs);
  const start = t[0];
  const end = t[t.length - 1];
  if (end - start < RESP_THRESHOLDS.TREND_WINDOW_SEC) return [];

  const points = [];
  for (
    let w = start;
    w + RESP_THRESHOLDS.TREND_WINDOW_SEC <= end + 1e-9;
    w += RESP_THRESHOLDS.TREND_HOP_SEC
  ) {
    const windowEnd = w + RESP_THRESHOLDS.TREND_WINDOW_SEC;
    const idx = [];
    for (let i = 0; i < t.length; i += 1) {
      if (t[i] >= w && t[i] <= windowEnd) idx.push(i);
    }
    if (idx.length < 20) {
      points.push({
        offsetSec: round(w - start, 1),
        midpointSec: round(w - start + RESP_THRESHOLDS.TREND_WINDOW_SEC / 2, 1),
        rateBpm: null,
        usable: false,
        reason: 'too_few_beats',
      });
      continue;
    }

    const resampled = resampleUniform(
      idx.map((i) => t[i]),
      idx.map((i) => v[i]),
      RESP_THRESHOLDS.EDR_RESAMPLE_HZ
    );
    const estimate = resampled
      ? estimateFromUniformSignal(resampled.values, resampled.rateHz)
      : null;

    const usable =
      !!estimate &&
      estimate.prominence >= RESP_THRESHOLDS.MIN_PROMINENCE &&
      isReportable(estimate.rateBpm);

    points.push({
      offsetSec: round(w - start, 1),
      midpointSec: round(w - start + RESP_THRESHOLDS.TREND_WINDOW_SEC / 2, 1),
      rateBpm: usable ? estimate.rateBpm : null,
      prominence: estimate ? estimate.prominence : null,
      usable,
      reason: usable ? null : 'weak_respiratory_peak',
    });
  }

  return points;
}

// -- Cross-check and confidence ---------------------------------------

/**
 * Reconcile the two estimates.
 *
 * On a large disagreement neither is chosen: picking one arbitrarily would
 * present a coin flip as a measurement.
 */
function crossCheck(edr, ppg) {
  const edrOk = edr.available && isReportable(edr.rateBpm);
  const ppgOk = ppg.available && isReportable(ppg.rateBpm);

  if (edrOk && ppgOk) {
    const difference = Math.abs(edr.rateBpm - ppg.rateBpm);
    const agree = difference <= RESP_THRESHOLDS.AGREEMENT_BREATHS_PER_MIN;
    return {
      status: agree ? 'Agreement' : 'Disagreement',
      differenceBpm: round(difference, 1),
      // On agreement the mean of two independent estimates is the better value.
      finalRateBpm: agree ? round((edr.rateBpm + ppg.rateBpm) / 2, 1) : null,
      basis: agree ? 'ecg_and_ppg' : null,
    };
  }

  if (edrOk) {
    return {
      status: 'ECG only',
      differenceBpm: null,
      finalRateBpm: edr.rateBpm,
      basis: 'ecg_only',
    };
  }

  if (ppgOk) {
    return {
      status: 'PPG only',
      differenceBpm: null,
      finalRateBpm: ppg.rateBpm,
      basis: 'ppg_only',
    };
  }

  return { status: 'Unavailable', differenceBpm: null, finalRateBpm: null, basis: null };
}

/** Overall confidence in the reported rate. */
function scoreConfidence({ crossResult, edr, ppg, artifactPercentage, durationSec }) {
  if (crossResult.finalRateBpm === null) return CONFIDENCE.UNAVAILABLE;

  const qualities = [edr.available ? edr.quality : null, ppg.available ? ppg.quality : null].filter(
    Boolean
  );
  const anyPoor = qualities.includes(ESTIMATE_QUALITY.POOR);
  const allGood = qualities.length > 0 && qualities.every((q) => q === ESTIMATE_QUALITY.GOOD);

  const plausible =
    crossResult.finalRateBpm >= RESP_THRESHOLDS.PLAUSIBLE_LOW_BPM &&
    crossResult.finalRateBpm <= RESP_THRESHOLDS.PLAUSIBLE_HIGH_BPM;

  const cleanEnough =
    artifactPercentage === null || artifactPercentage <= RESP_THRESHOLDS.MAX_ARTIFACT_PCT;
  const longEnough = durationSec >= RESP_THRESHOLDS.MIN_DURATION_SEC * 2;

  if (anyPoor || !cleanEnough) return CONFIDENCE.LOW;

  if (crossResult.basis === 'ecg_and_ppg' && allGood && plausible && longEnough) {
    return CONFIDENCE.HIGH;
  }

  if (allGood && plausible && longEnough) return CONFIDENCE.MODERATE;
  if (plausible && cleanEnough) return CONFIDENCE.MODERATE;

  return CONFIDENCE.LOW;
}

// -- Narrative --------------------------------------------------------

function buildPatientSummary({ crossResult, confidence, edr, ppg, status }) {
  const parts = [
    'Respiration rate is an estimate of how many breaths you took per minute during the recording.',
  ];

  if (status === RESP_STATUS.DISAGREEMENT) {
    parts.push(
      'The ECG and pulse signals produced different breathing estimates, so a final respiration rate was not reported for this recording.'
    );
  } else if (crossResult.finalRateBpm === null) {
    parts.push(
      'A reliable breathing estimate could not be produced from this recording.'
    );
  } else {
    parts.push(
      `The estimated respiration rate was about ${Math.round(
        crossResult.finalRateBpm
      )} breaths per minute.`
    );

    if (crossResult.basis === 'ecg_only') {
      parts.push('This estimate came from the ECG signal alone.');
    } else if (crossResult.basis === 'ppg_only') {
      parts.push('This estimate came from the pulse signal alone.');
    } else {
      parts.push('The ECG and pulse signals agreed on this estimate.');
    }
  }

  if (confidence === CONFIDENCE.LOW) {
    parts.push(
      'The breathing estimate was less reliable during part of the recording because of signal quality.'
    );
  }

  if (!ppg.available && ppg.reason === 'raw_ppg_not_recorded') {
    parts.push('A pulse-based cross-check was not possible for this recording.');
  }

  parts.push(
    'This is an estimate from the recorded signals, not a diagnosis. Please discuss any concerns with a healthcare professional.'
  );

  return parts.join(' ');
}

function buildTechnicalSummary({ crossResult, confidence, edr, ppg, durationSec, artifactPercentage }) {
  const lines = [];

  if (edr.available) {
    lines.push(
      `ECG-derived (respiratory sinus arrhythmia): ${edr.rateBpm} breaths/min at ${edr.freqHz} Hz, peak prominence ${edr.prominence}x mean band power, from ${edr.intervalsUsed} NN intervals over ${edr.durationSec} s (spectral resolution ${edr.resolutionBpm} breaths/min). Quality ${edr.quality}.`
    );
  } else {
    lines.push(`ECG-derived estimate unavailable: ${edr.detail}`);
  }

  if (ppg.available) {
    lines.push(
      `PPG-derived (baseline modulation): ${ppg.rateBpm} breaths/min at ${ppg.freqHz} Hz, peak prominence ${ppg.prominence}x, from ${ppg.samplesUsed} raw samples over ${ppg.durationSec} s. Quality ${ppg.quality}.`
    );
  } else {
    lines.push(`PPG-derived estimate unavailable: ${ppg.detail}`);
  }

  lines.push(
    `Cross-check: ${crossResult.status}${
      crossResult.differenceBpm !== null ? ` (difference ${crossResult.differenceBpm} breaths/min)` : ''
    }. Reported rate ${
      crossResult.finalRateBpm === null ? 'withheld' : `${crossResult.finalRateBpm} breaths/min`
    }, confidence ${confidence}.`
  );

  lines.push(
    `Band ${RESP_THRESHOLDS.BAND_LOW_HZ}-${RESP_THRESHOLDS.BAND_HIGH_HZ} Hz (${
      RESP_THRESHOLDS.BAND_LOW_HZ * 60
    }-${RESP_THRESHOLDS.BAND_HIGH_HZ * 60} breaths/min); analysed ${round(
      durationSec,
      1
    )} s with ${artifactPercentage === null ? 'n/a' : `${artifactPercentage}%`} of candidate intervals excluded as artifact.`
  );

  lines.push(
    `The ${RESP_THRESHOLDS.PLAUSIBLE_LOW_BPM}-${RESP_THRESHOLDS.PLAUSIBLE_HIGH_BPM} breaths/min band is a plausibility check for resting adults, not an abnormality threshold; activity, sleep, age and illness all move the true rate outside it legitimately.`
  );

  lines.push(
    'NN intervals are consumed from the ECG/RR validation pipeline; this module performs no independent R-peak detection and never infers respiration from the SpO2 percentage.'
  );

  return lines.join(' ');
}

// -- Orchestration ----------------------------------------------------

/**
 * Run the respiration analysis.
 *
 * @param {object} prepared The object from `prepareNnSequence`.
 * @param {{recordingDurationSec?:number, ppgSamples?:Array, ecgSignalQuality?:string}} [options]
 */
function analyseRespiration(prepared, options = {}) {
  if (!prepared || !Array.isArray(prepared.nn)) {
    throw new TypeError(
      'analyseRespiration requires the prepared NN sequence from prepareNnSequence(); ' +
        'respiration must not derive its own heartbeat sequence.'
    );
  }

  const nn = prepared.nn;
  const counts = prepared.counts || {};
  const totalIntervals = counts.beatsDetected || 0;
  const artifactPercentage =
    totalIntervals > 0
      ? round(((totalIntervals - (counts.validBeats || 0)) / totalIntervals) * 100, 2)
      : null;

  const edr = estimateEdr(nn);
  const ppg = estimatePpg(options.ppgSamples);

  const durationSec =
    (edr.available ? edr.durationSec : null) ??
    (ppg.available ? ppg.durationSec : null) ??
    options.recordingDurationSec ??
    0;

  const crossResult = crossCheck(edr, ppg);

  // A heavily artifacted ECG cannot support respiratory sinus arrhythmia.
  const artifactBlocked =
    artifactPercentage !== null && artifactPercentage > RESP_THRESHOLDS.MAX_ARTIFACT_PCT;

  let status;
  if (crossResult.status === 'Disagreement') {
    status = RESP_STATUS.DISAGREEMENT;
  } else if (crossResult.finalRateBpm !== null && !artifactBlocked) {
    status = RESP_STATUS.SUCCESS;
  } else if (artifactBlocked) {
    status = RESP_STATUS.POOR_SIGNAL_QUALITY;
  } else if (!nn.length && !(options.ppgSamples || []).length) {
    status = RESP_STATUS.NO_DATA;
  } else {
    status = RESP_STATUS.INSUFFICIENT_DATA;
  }

  // Withhold the rate on anything but a clean success.
  const finalRateBpm = status === RESP_STATUS.SUCCESS ? crossResult.finalRateBpm : null;
  const effectiveCross = { ...crossResult, finalRateBpm };

  const confidence =
    status === RESP_STATUS.SUCCESS
      ? scoreConfidence({
          crossResult: effectiveCross,
          edr,
          ppg,
          artifactPercentage,
          durationSec,
        })
      : CONFIDENCE.UNAVAILABLE;

  const message =
    status === RESP_STATUS.SUCCESS
      ? null
      : status === RESP_STATUS.DISAGREEMENT
        ? 'The ECG and pulse signals produced different breathing estimates, so no respiration rate is reported for this recording.'
        : status === RESP_STATUS.POOR_SIGNAL_QUALITY
          ? 'Respiration could not be estimated reliably because too much of the recording was affected by signal artifacts.'
          : status === RESP_STATUS.NO_DATA
            ? 'No signal suitable for respiration estimation is available for this session.'
            : edr.detail || 'Not enough usable signal to estimate respiration.';

  return {
    status,
    message,
    recording: {
      durationSec: options.recordingDurationSec ?? round(durationSec, 1),
      analysedDurationSec: round(durationSec, 1),
    },
    summary: {
      respirationRateBpm: finalRateBpm,
      unit: 'breaths/min',
      confidence,
      basis: status === RESP_STATUS.SUCCESS ? crossResult.basis : null,
      plausibleRange:
        finalRateBpm === null
          ? null
          : finalRateBpm >= RESP_THRESHOLDS.PLAUSIBLE_LOW_BPM &&
            finalRateBpm <= RESP_THRESHOLDS.PLAUSIBLE_HIGH_BPM,
    },
    ecgEstimate: edr,
    ppgEstimate: ppg,
    crossCheck: {
      status: crossResult.status,
      differenceBpm: crossResult.differenceBpm,
    },
    artifactPercentage,
    trend: status === RESP_STATUS.SUCCESS || status === RESP_STATUS.DISAGREEMENT ? buildTrend(nn) : [],
    patientSummary: buildPatientSummary({ crossResult: effectiveCross, confidence, edr, ppg, status }),
    technicalSummary: buildTechnicalSummary({
      crossResult: effectiveCross,
      confidence,
      edr,
      ppg,
      durationSec,
      artifactPercentage,
    }),
  };
}

module.exports = {
  analyseRespiration,
  estimateEdr,
  estimatePpg,
  estimateFromUniformSignal,
  crossCheck,
  scoreConfidence,
  buildTrend,
  hzToBreathsPerMin,
  isReportable,
  RESP_THRESHOLDS,
  RESP_STATUS,
  CONFIDENCE,
  ESTIMATE_QUALITY,
};
