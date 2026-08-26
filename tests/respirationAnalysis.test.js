/**
 * Unit tests for the respiration engine.
 *
 * The key tests synthesise a signal with a KNOWN respiratory frequency and check
 * the estimator recovers it. That is the only way to show the DSP is correct
 * rather than merely producing a plausible-looking number.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  analyseRespiration,
  estimateEdr,
  estimatePpg,
  estimateFromUniformSignal,
  crossCheck,
  buildTrend,
  hzToBreathsPerMin,
  isReportable,
  RESP_THRESHOLDS,
  RESP_STATUS,
  CONFIDENCE,
  ESTIMATE_QUALITY,
} = require('../src/utils/respirationAnalysis');

const { resampleUniform, detrend, bandPowerSpectrum, dominantPeak } = require('../src/utils/signalSpectrum');
const { prepareNnSequence } = require('../src/utils/ecgRrAnalysis');

// -- helpers ----------------------------------------------------------

/**
 * R peaks whose NN intervals are sinusoidally modulated at `respHz` — synthetic
 * respiratory sinus arrhythmia with a known ground-truth breathing rate.
 */
function peaksWithRsa({ durationSec, baseRrMs = 800, modulationMs = 40, respHz = 0.25 }) {
  const peaks = [];
  let clock = 100000;
  let elapsed = 0;
  peaks.push({ rPeakTimestamp: clock, timestamp: new Date(1700000000000).toISOString(), leadOff: false });

  while (elapsed < durationSec) {
    const nn = baseRrMs + modulationMs * Math.sin(2 * Math.PI * respHz * elapsed);
    clock += nn;
    elapsed += nn / 1000;
    peaks.push({
      rPeakTimestamp: clock,
      timestamp: new Date(1700000000000 + elapsed * 1000).toISOString(),
      leadOff: false,
    });
  }
  return peaks;
}

/** Raw PPG samples whose baseline is modulated at `respHz`, on a cardiac carrier. */
function ppgSamples({ durationSec, rateHz = 25, respHz = 0.27, cardiacHz = 1.25 }) {
  const out = [];
  const n = Math.floor(durationSec * rateHz);
  for (let i = 0; i < n; i += 1) {
    const t = i / rateHz;
    const respiratory = 900 * Math.sin(2 * Math.PI * respHz * t);
    const cardiac = 300 * Math.sin(2 * Math.PI * cardiacHz * t);
    out.push({ t, value: 100000 + respiratory + cardiac });
  }
  return out;
}

const preparedFrom = (peaks) => prepareNnSequence(peaks);

// -- Spectral primitives ----------------------------------------------

test('the estimator recovers a known frequency from a clean sinusoid', () => {
  const rateHz = 4;
  const durationSec = 240;
  const freq = 0.25; // 15 breaths/min
  const values = [];
  for (let i = 0; i < durationSec * rateHz; i += 1) {
    values.push(Math.sin((2 * Math.PI * freq * i) / rateHz));
  }

  const estimate = estimateFromUniformSignal(values, rateHz);
  assert.ok(Math.abs(estimate.freqHz - freq) < 0.01, `got ${estimate.freqHz} Hz`);
  assert.ok(Math.abs(estimate.rateBpm - 15) < 0.6, `got ${estimate.rateBpm} breaths/min`);
  // A pure tone should stand far out of the band.
  assert.ok(estimate.prominence > RESP_THRESHOLDS.STRONG_PROMINENCE);
});

test('frequency to breaths per minute follows the documented formula', () => {
  // 0.25 Hz x 60 = 15 breaths/min.
  assert.equal(hzToBreathsPerMin(0.25), 15);
  assert.equal(hzToBreathsPerMin(0.2), 12);
  assert.equal(hzToBreathsPerMin(0), null);
  assert.equal(hzToBreathsPerMin(NaN), null);
});

test('noise produces a low-prominence peak, not a confident rate', () => {
  // Deterministic pseudo-noise, so the test cannot flake.
  const values = [];
  let seed = 42;
  for (let i = 0; i < 960; i += 1) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    values.push(seed / 2147483648 - 0.5);
  }
  const estimate = estimateFromUniformSignal(values, 4);
  assert.ok(
    estimate.prominence < RESP_THRESHOLDS.STRONG_PROMINENCE,
    `noise gave prominence ${estimate.prominence}`
  );
});

test('detrending removes a linear drift that would otherwise dominate', () => {
  const withDrift = Array.from({ length: 200 }, (_, i) => 10 + i * 0.5);
  const flat = detrend(withDrift);
  assert.ok(Math.max(...flat.map(Math.abs)) < 1e-9, 'drift survived detrending');
});

test('resampling puts an uneven series on an even grid', () => {
  const t = [0, 1, 3, 4];
  const v = [0, 10, 30, 40];
  const out = resampleUniform(t, v, 2);
  assert.equal(out.rateHz, 2);
  assert.equal(out.durationSec, 4);
  // Linear interpolation: t=2 s sits halfway between 10 and 30.
  assert.ok(Math.abs(out.values[4] - 20) < 1e-9);
});

test('nothing above Nyquist is reported', () => {
  // 1 Hz sampling cannot resolve 0.5 Hz+; the band is clipped, not extrapolated.
  const values = Array.from({ length: 100 }, (_, i) => Math.sin(2 * Math.PI * 0.2 * i));
  const spectrum = bandPowerSpectrum(values, 1, 0.1, 0.9, 0.01);
  assert.ok(Math.max(...spectrum.freqs) <= 0.5 + 1e-9);
});

// -- ECG-derived respiration ------------------------------------------

test('EDR recovers a known respiratory frequency from RSA', () => {
  // 0.25 Hz modulation of the NN sequence = 15 breaths/min.
  const prepared = preparedFrom(peaksWithRsa({ durationSec: 240, respHz: 0.25 }));
  const edr = estimateEdr(prepared.nn);

  assert.equal(edr.available, true);
  assert.equal(edr.method, 'rsa_tachogram');
  assert.ok(Math.abs(edr.rateBpm - 15) < 1.5, `expected ~15, got ${edr.rateBpm}`);
  assert.ok(edr.prominence > RESP_THRESHOLDS.MIN_PROMINENCE);
});

test('EDR tracks a different known frequency', () => {
  // 0.3 Hz = 18 breaths/min.
  const prepared = preparedFrom(peaksWithRsa({ durationSec: 240, respHz: 0.3 }));
  const edr = estimateEdr(prepared.nn);

  assert.equal(edr.available, true);
  assert.ok(Math.abs(edr.rateBpm - 18) < 1.5, `expected ~18, got ${edr.rateBpm}`);
});

test('EDR reports the spectral resolution behind its estimate', () => {
  const prepared = preparedFrom(peaksWithRsa({ durationSec: 240, respHz: 0.25 }));
  const edr = estimateEdr(prepared.nn);

  // ~1/T: 240 s gives ~0.004 Hz ~ 0.25 breaths/min.
  assert.ok(edr.resolutionBpm > 0 && edr.resolutionBpm < 2, `got ${edr.resolutionBpm}`);
});

test('EDR refuses a recording shorter than the minimum', () => {
  const prepared = preparedFrom(peaksWithRsa({ durationSec: 30, respHz: 0.25 }));
  const edr = estimateEdr(prepared.nn);

  assert.equal(edr.available, false);
  assert.equal(edr.reason, 'recording_too_short');
  assert.match(edr.detail, new RegExp(`${RESP_THRESHOLDS.MIN_DURATION_SEC} s`));
});

test('EDR refuses too few NN intervals', () => {
  const edr = estimateEdr([{ nnMs: 800, rPeakTimestamp: 1000, precededByGap: true }]);
  assert.equal(edr.available, false);
  assert.equal(edr.reason, 'insufficient_nn_intervals');
});

test('EDR handles an empty sequence without throwing', () => {
  const edr = estimateEdr([]);
  assert.equal(edr.available, false);
  assert.equal(edr.reason, 'insufficient_nn_intervals');
});

// -- PPG-derived respiration ------------------------------------------

test('PPG estimator recovers a known respiratory frequency from the baseline', () => {
  // 0.27 Hz = 16.2 breaths/min, riding on a 1.25 Hz cardiac carrier.
  const ppg = estimatePpg(ppgSamples({ durationSec: 240, respHz: 0.27 }));

  assert.equal(ppg.available, true);
  assert.equal(ppg.method, 'ppg_baseline_modulation');
  assert.ok(Math.abs(ppg.rateBpm - 16.2) < 1.5, `expected ~16.2, got ${ppg.rateBpm}`);
});

test('the cardiac component does not leak into the PPG respiratory estimate', () => {
  // A 1.25 Hz carrier is 75 breaths/min if mistaken for respiration.
  const ppg = estimatePpg(ppgSamples({ durationSec: 240, respHz: 0.2, cardiacHz: 1.25 }));
  assert.equal(ppg.available, true);
  assert.ok(ppg.rateBpm < 30, `cardiac leakage: got ${ppg.rateBpm}`);
  assert.ok(Math.abs(ppg.rateBpm - 12) < 1.5, `expected ~12, got ${ppg.rateBpm}`);
});

test('PPG estimation reports the exact reason when no raw waveform exists', () => {
  const ppg = estimatePpg([]);
  assert.equal(ppg.available, false);
  assert.equal(ppg.reason, 'raw_ppg_not_recorded');
  assert.match(ppg.detail, /IR\/RED sample stream/);
  assert.match(ppg.detail, /SpO2 percentage alone cannot substitute/);
});

test('PPG estimation refuses too few samples', () => {
  const ppg = estimatePpg(ppgSamples({ durationSec: 5, rateHz: 25 }));
  assert.equal(ppg.available, false);
  assert.equal(ppg.reason, 'insufficient_ppg_samples');
});

// -- Cross-check ------------------------------------------------------

test('close estimates agree and are averaged', () => {
  const result = crossCheck(
    { available: true, rateBpm: 15, quality: 'Good' },
    { available: true, rateBpm: 16, quality: 'Good' }
  );
  assert.equal(result.status, 'Agreement');
  assert.equal(result.differenceBpm, 1);
  assert.equal(result.finalRateBpm, 15.5);
  assert.equal(result.basis, 'ecg_and_ppg');
});

test('a large disagreement withholds the rate instead of picking one', () => {
  // The documented example: EDR 15, PPG 24.
  const result = crossCheck(
    { available: true, rateBpm: 15, quality: 'Good' },
    { available: true, rateBpm: 24, quality: 'Good' }
  );
  assert.equal(result.status, 'Disagreement');
  assert.equal(result.differenceBpm, 9);
  assert.equal(result.finalRateBpm, null);
  assert.equal(result.basis, null);
});

test('one available estimate is used alone and labelled as such', () => {
  const ecgOnly = crossCheck(
    { available: true, rateBpm: 15, quality: 'Good' },
    { available: false, reason: 'raw_ppg_not_recorded' }
  );
  assert.equal(ecgOnly.status, 'ECG only');
  assert.equal(ecgOnly.finalRateBpm, 15);
  assert.equal(ecgOnly.basis, 'ecg_only');

  const ppgOnly = crossCheck(
    { available: false, reason: 'insufficient_nn_intervals' },
    { available: true, rateBpm: 16, quality: 'Good' }
  );
  assert.equal(ppgOnly.status, 'PPG only');
  assert.equal(ppgOnly.basis, 'ppg_only');
});

test('neither available yields no rate', () => {
  const result = crossCheck({ available: false }, { available: false });
  assert.equal(result.status, 'Unavailable');
  assert.equal(result.finalRateBpm, null);
});

test('physiologically implausible rates are not reportable', () => {
  assert.equal(isReportable(15), true);
  assert.equal(isReportable(2), false);
  assert.equal(isReportable(60), false);
  assert.equal(isReportable(null), false);
});

// -- Full pipeline ----------------------------------------------------

test('respiration refuses anything but a prepared NN sequence', () => {
  assert.throws(() => analyseRespiration([{ rPeakTimestamp: 1 }]), /prepareNnSequence/);
  assert.throws(() => analyseRespiration(null), /prepareNnSequence/);
});

test('ECG-only recording reports an ECG-derived rate and says so', () => {
  const prepared = preparedFrom(peaksWithRsa({ durationSec: 240, respHz: 0.25 }));
  const result = analyseRespiration(prepared, { recordingDurationSec: 240 });

  assert.equal(result.status, RESP_STATUS.SUCCESS);
  assert.ok(Math.abs(result.summary.respirationRateBpm - 15) < 1.5);
  assert.equal(result.summary.basis, 'ecg_only');
  assert.equal(result.ppgEstimate.available, false);
  assert.equal(result.ppgEstimate.reason, 'raw_ppg_not_recorded');
  assert.match(result.patientSummary, /from the ECG signal alone/);
});

test('ECG and PPG together produce an agreed rate', () => {
  const prepared = preparedFrom(peaksWithRsa({ durationSec: 240, respHz: 0.25 }));
  const result = analyseRespiration(prepared, {
    recordingDurationSec: 240,
    ppgSamples: ppgSamples({ durationSec: 240, respHz: 0.26 }),
  });

  assert.equal(result.status, RESP_STATUS.SUCCESS);
  assert.equal(result.crossCheck.status, 'Agreement');
  assert.equal(result.summary.basis, 'ecg_and_ppg');
  assert.ok(result.crossCheck.differenceBpm <= RESP_THRESHOLDS.AGREEMENT_BREATHS_PER_MIN);
  assert.match(result.patientSummary, /agreed on this estimate/);
});

test('a genuine disagreement suppresses the rate and is explained', () => {
  // ECG at 0.2 Hz (12/min) against PPG at 0.45 Hz (27/min).
  const prepared = preparedFrom(peaksWithRsa({ durationSec: 240, respHz: 0.2 }));
  const result = analyseRespiration(prepared, {
    recordingDurationSec: 240,
    ppgSamples: ppgSamples({ durationSec: 240, respHz: 0.45, cardiacHz: 1.6 }),
  });

  assert.equal(result.status, RESP_STATUS.DISAGREEMENT);
  assert.equal(result.summary.respirationRateBpm, null);
  assert.equal(result.summary.confidence, CONFIDENCE.UNAVAILABLE);
  assert.match(result.patientSummary, /different breathing estimates/);
  // Both individual estimates are still reported for review.
  assert.equal(result.ecgEstimate.available, true);
  assert.equal(result.ppgEstimate.available, true);
});

test('a short recording yields insufficient_data, not a guess', () => {
  const prepared = preparedFrom(peaksWithRsa({ durationSec: 30, respHz: 0.25 }));
  const result = analyseRespiration(prepared, { recordingDurationSec: 30 });

  assert.equal(result.status, RESP_STATUS.INSUFFICIENT_DATA);
  assert.equal(result.summary.respirationRateBpm, null);
  assert.equal(result.summary.confidence, CONFIDENCE.UNAVAILABLE);
});

test('an empty session yields no_data', () => {
  const result = analyseRespiration(prepareNnSequence([]), {});
  assert.equal(result.status, RESP_STATUS.NO_DATA);
  assert.equal(result.summary.respirationRateBpm, null);
});

test('a heavily artifacted recording suppresses the rate', () => {
  // Alternate clean beats with artifacts so a large share is rejected.
  const clean = peaksWithRsa({ durationSec: 240, respHz: 0.25 });
  const prepared = preparedFrom(clean);
  // Force a high artifact share on the prepared object.
  prepared.counts = { ...prepared.counts, beatsDetected: prepared.nn.length * 3, validBeats: prepared.nn.length };

  const result = analyseRespiration(prepared, { recordingDurationSec: 240 });
  assert.equal(result.status, RESP_STATUS.POOR_SIGNAL_QUALITY);
  assert.equal(result.summary.respirationRateBpm, null);
  assert.match(result.message, /signal artifacts/);
});

test('confidence never claims High without a PPG cross-check', () => {
  const prepared = preparedFrom(peaksWithRsa({ durationSec: 300, respHz: 0.25 }));
  const result = analyseRespiration(prepared, { recordingDurationSec: 300 });

  assert.equal(result.status, RESP_STATUS.SUCCESS);
  assert.notEqual(result.summary.confidence, CONFIDENCE.HIGH);
});

test('the plausibility band is a check, not an abnormality verdict', () => {
  const prepared = preparedFrom(peaksWithRsa({ durationSec: 240, respHz: 0.4 })); // 24/min
  const result = analyseRespiration(prepared, { recordingDurationSec: 240 });

  if (result.status === RESP_STATUS.SUCCESS) {
    // Reported, flagged as outside the resting band, never called abnormal.
    assert.equal(result.summary.plausibleRange, false);
    assert.ok(!/abnormal/i.test(result.patientSummary));
    // The technical text names the concept only to rule it out.
    assert.match(result.technicalSummary, /not an abnormality threshold/);
  }
});

test('the trend marks unreliable windows rather than interpolating', () => {
  const prepared = preparedFrom(peaksWithRsa({ durationSec: 300, respHz: 0.25 }));
  const trend = buildTrend(prepared.nn);

  assert.ok(trend.length > 1);
  for (const point of trend) {
    assert.equal(typeof point.midpointSec, 'number');
    // Either a usable rate, or an explicit null with a reason.
    if (point.usable) assert.equal(typeof point.rateBpm, 'number');
    else assert.equal(point.rateBpm, null);
  }
});

test('respiration is deterministic for identical input', () => {
  const prepared = preparedFrom(peaksWithRsa({ durationSec: 240, respHz: 0.25 }));
  assert.deepEqual(
    analyseRespiration(prepared, { recordingDurationSec: 240 }),
    analyseRespiration(prepared, { recordingDurationSec: 240 })
  );
});

test('no wording claims a respiratory diagnosis', () => {
  const prepared = preparedFrom(peaksWithRsa({ durationSec: 240, respHz: 0.25 }));
  const result = analyseRespiration(prepared, { recordingDurationSec: 240 });
  const both = `${result.patientSummary} ${result.technicalSummary}`.toLowerCase();
  for (const term of ['apnea', 'apnoea', 'respiratory disease', 'copd', 'asthma']) {
    assert.ok(!both.includes(term), `found "${term}"`);
  }

  // Patient-facing wording additionally never uses the word at all.
  assert.ok(!/abnormal/i.test(result.patientSummary));
  assert.match(result.patientSummary, /not a diagnosis/);
});

test('the technical summary states the architectural guarantee', () => {
  const prepared = preparedFrom(peaksWithRsa({ durationSec: 240, respHz: 0.25 }));
  const result = analyseRespiration(prepared, { recordingDurationSec: 240 });

  assert.match(result.technicalSummary, /no independent R-peak detection/);
  assert.match(result.technicalSummary, /never infers respiration from the SpO2 percentage/);
});
