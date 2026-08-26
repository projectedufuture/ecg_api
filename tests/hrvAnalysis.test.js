/**
 * Unit tests for the HRV analysis engine.
 *
 * Expected values for SDNN, RMSSD and pNN50 are hand-computed in the comments so
 * the assertions are independent of the implementation rather than a snapshot of
 * whatever it happens to produce.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
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
} = require('../src/utils/hrvAnalysis');

const { prepareNnSequence, THRESHOLDS } = require('../src/utils/ecgRrAnalysis');

// -- helpers ----------------------------------------------------------

/** R peaks from a list of RR intervals, so the real pipeline produces the NN. */
function peaksFromRrList(rrList, start = 10000) {
  const timestamps = [start];
  for (const rr of rrList) timestamps.push(timestamps[timestamps.length - 1] + rr);
  return timestamps.map((t) => ({
    rPeakTimestamp: t,
    timestamp: new Date(1700000000000 + t).toISOString(),
    confidence: 0.95,
    leadOff: false,
  }));
}

/** Run the real ECG/RR validation, then HRV on its output. */
function hrvFromRrList(rrList, options = {}) {
  return analyseHrv(prepareNnSequence(peaksFromRrList(rrList)), options);
}

/** A steady sequence long enough to clear the availability gates. */
function steadyRrList(count, baseRr = 800, jitter = 10) {
  return Array.from({ length: count }, (_, i) => baseRr + ((i % 5) - 2) * jitter);
}

/** Minimal prepared-shape stub for testing metric maths in isolation. */
function preparedFromNn(nnValues, { totalIntervals, quality = 'Good' } = {}) {
  const nn = nnValues.map((nnMs, i) => ({
    nnMs,
    previousRPeak: 1000 + i * 800,
    rPeakTimestamp: 1000 + (i + 1) * 800,
    timestamp: new Date(1700000000000 + i * 800).toISOString(),
    precededByGap: i === 0,
  }));
  const total = totalIntervals ?? nnValues.length;
  return {
    classified: new Array(total).fill(null),
    nn,
    counts: {
      beatsDetected: total,
      validBeats: nnValues.length,
      invalidBeats: total - nnValues.length,
      rejectedPeaks: 0,
      usablePercentage: (nnValues.length / total) * 100,
    },
    signalQuality: { status: quality, usablePercentage: (nnValues.length / total) * 100 },
    rejectedPeaks: 0,
    firstRPeak: 1000,
    totalRPeaks: total + 1,
  };
}

// -- SDNN -------------------------------------------------------------

test('SDNN matches an independently calculated value', () => {
  // NN: 800 810 805 820 815 -> mean 810.
  // Deviations: -10, 0, -5, 10, 5 -> squares 100, 0, 25, 100, 25 = 250.
  // Sample variance = 250 / 4 = 62.5 -> SDNN = sqrt(62.5) = 7.9057...
  const value = sdnn([800, 810, 805, 820, 815]);
  assert.ok(Math.abs(value - Math.sqrt(62.5)) < 1e-9, `got ${value}`);
  assert.ok(Math.abs(value - 7.9057) < 0.001);
});

test('SDNN uses the sample (n-1) estimator', () => {
  const values = [800, 810, 805, 820, 815];
  // Population SD would be sqrt(250/5) = sqrt(50) = 7.0711; sample is sqrt(62.5).
  assert.ok(Math.abs(sdnn(values) - Math.sqrt(62.5)) < 1e-9);
  assert.ok(Math.abs(sdnn(values) - Math.sqrt(50)) > 0.5);
  assert.equal(sampleStdDev(values), sdnn(values));
});

test('SDNN is null rather than zero for a single interval', () => {
  assert.equal(sdnn([800]), null);
  assert.equal(sdnn([]), null);
});

test('SDNN of a perfectly regular sequence is zero', () => {
  assert.equal(sdnn([800, 800, 800, 800]), 0);
});

// -- RMSSD ------------------------------------------------------------

test('RMSSD matches an independently calculated value', () => {
  // Differences 10, 20, 30 -> squares 100, 400, 900 = 1400; mean = 466.667;
  // sqrt = 21.6025.
  const value = rmssd([10, 20, 30]);
  assert.ok(Math.abs(value - Math.sqrt(1400 / 3)) < 1e-9, `got ${value}`);
  assert.ok(Math.abs(value - 21.6025) < 0.001);
});

test('RMSSD over a known NN sequence matches the hand calculation', () => {
  // NN 800 810 805 820 815 -> abs diffs 10, 5, 15, 5.
  // Squares 100, 25, 225, 25 = 375; mean 93.75; sqrt = 9.6825.
  const { diffs } = successiveDifferences(
    [800, 810, 805, 820, 815].map((nnMs, i) => ({ nnMs, precededByGap: i === 0 }))
  );
  assert.deepEqual(diffs, [10, 5, 15, 5]);
  assert.ok(Math.abs(rmssd(diffs) - Math.sqrt(93.75)) < 1e-9);
  assert.ok(Math.abs(rmssd(diffs) - 9.6825) < 0.001);
});

test('RMSSD is null with no successive pairs', () => {
  assert.equal(rmssd([]), null);
});

// -- pNN50 ------------------------------------------------------------

test('pNN50 matches the documented worked example', () => {
  // Differences 10, 18, 62, 15, 75 -> two exceed 50 -> 2/5 = 40%.
  assert.equal(pnn([10, 18, 62, 15, 75]), 40);
});

test('pNN50 over a known NN sequence matches the hand calculation', () => {
  // NN 800 810 870 880 960 -> abs diffs 10, 60, 10, 80.
  // Above 50: 60 and 80 -> 2/4 = 50%.
  const { diffs } = successiveDifferences(
    [800, 810, 870, 880, 960].map((nnMs, i) => ({ nnMs, precededByGap: i === 0 }))
  );
  assert.deepEqual(diffs, [10, 60, 10, 80]);
  assert.equal(pnn(diffs), 50);
});

test('pNN50 uses absolute differences, so direction does not matter', () => {
  // A fall of 60 ms counts exactly as a rise of 60 ms would.
  const falling = successiveDifferences(
    [900, 840, 900].map((nnMs, i) => ({ nnMs, precededByGap: i === 0 }))
  ).diffs;
  assert.deepEqual(falling, [60, 60]);
  assert.equal(pnn(falling), 100);
});

test('pNN50 is strictly greater than the threshold', () => {
  // Exactly 50 ms does not count; 51 does.
  assert.equal(pnn([50, 50, 50, 50]), 0);
  assert.equal(pnn([51, 50, 50, 50]), 25);
});

test('pNN50 is null with no successive pairs', () => {
  assert.equal(pnn([]), null);
});

// -- Successive differences across artifact gaps -----------------------

test('successive differences never span a rejected interval', () => {
  // The third entry follows a removed artifact, so the 800->810 pair across the
  // gap must not be differenced.
  const nn = [
    { nnMs: 800, precededByGap: true },
    { nnMs: 805, precededByGap: false },
    { nnMs: 810, precededByGap: true }, // artifact was removed before this one
    { nnMs: 815, precededByGap: false },
  ];
  const { diffs, pairsSkipped } = successiveDifferences(nn);

  assert.deepEqual(diffs, [5, 5]);
  assert.equal(pairsSkipped, 1);
});

test('an artifact does not inflate RMSSD by splicing across the gap', () => {
  // 800, 810, [1600 rejected], 805 - differencing across the removal would give
  // a spurious jump. The clean pipeline must not produce one.
  const rrList = [...steadyRrList(40, 800, 6), 1600, ...steadyRrList(40, 800, 6)];
  const result = hrvFromRrList(rrList, { recordingDurationSec: 70 });

  assert.equal(result.status, HRV_STATUS.SUCCESS);
  // The 1600 ms interval is excluded from the NN set entirely.
  assert.ok(result.metrics.maxNNMs < 1000, `1600 ms leaked in: ${result.metrics.maxNNMs}`);
  // Jitter is +/-12 ms, so a splice would show up as a large RMSSD.
  assert.ok(result.metrics.rmssdMs < 30, `RMSSD inflated to ${result.metrics.rmssdMs}`);
  assert.ok(result.counts.successivePairsSkipped >= 1);
});

test('the suspicious interval is excluded rather than dominating HRV', () => {
  const clean = hrvFromRrList(steadyRrList(80, 800, 6), { recordingDurationSec: 70 });
  const withArtifact = hrvFromRrList(
    [...steadyRrList(40, 800, 6), 1600, ...steadyRrList(40, 800, 6)],
    { recordingDurationSec: 70 }
  );

  // SDNN should be barely affected by one removed artifact.
  assert.ok(
    Math.abs(withArtifact.metrics.sdnnMs - clean.metrics.sdnnMs) < 5,
    `SDNN moved from ${clean.metrics.sdnnMs} to ${withArtifact.metrics.sdnnMs}`
  );
});

// -- Consuming the shared NN sequence ---------------------------------

test('HRV refuses to run on anything but a prepared NN sequence', () => {
  // Guards the architectural constraint: no raw peaks, no ECG samples.
  assert.throws(() => analyseHrv([{ rPeakTimestamp: 1000 }]), /prepareNnSequence/);
  assert.throws(() => analyseHrv(null), /prepareNnSequence/);
  assert.throws(() => analyseHrv({ ecgSamples: [1, 2, 3] }), /prepareNnSequence/);
});

test('HRV uses exactly the NN intervals that ECG/RR validated', () => {
  const rrList = [...steadyRrList(30), 2300, ...steadyRrList(30), 400, 400, ...steadyRrList(30)];
  const prepared = prepareNnSequence(peaksFromRrList(rrList));
  const result = analyseHrv(prepared, { recordingDurationSec: 80 });

  assert.equal(result.counts.validNNIntervals, prepared.nn.length);
  assert.equal(result.counts.totalRRIntervals, prepared.counts.beatsDetected);
  assert.equal(result.counts.excludedIntervals, prepared.counts.invalidBeats);
  // Mean NN recomputed straight from the shared sequence.
  const expectedMean =
    prepared.nn.reduce((a, b) => a + b.nnMs, 0) / prepared.nn.length;
  assert.equal(result.metrics.meanNNMs, Math.round(expectedMean));
});

test('the artifact percentage is reported and matches the interval accounting', () => {
  const rrList = [...steadyRrList(40), 2300, 1600, ...steadyRrList(40)];
  const result = hrvFromRrList(rrList, { recordingDurationSec: 70 });

  const { totalIntervals, validNNIntervals, excludedIntervals } = {
    totalIntervals: result.counts.totalRRIntervals,
    validNNIntervals: result.counts.validNNIntervals,
    excludedIntervals: result.counts.excludedIntervals,
  };
  assert.equal(validNNIntervals + excludedIntervals, totalIntervals);
  assert.ok(
    Math.abs(result.counts.artifactPercentage - (excludedIntervals / totalIntervals) * 100) < 0.01
  );
  assert.ok(
    Math.abs(result.counts.usablePercentage - (validNNIntervals / totalIntervals) * 100) < 0.01
  );
});

// -- Additional time-domain metrics -----------------------------------

test('mean, min and max NN come from the clean sequence', () => {
  const prepared = preparedFromNn([800, 810, 805, 820, 815, ...new Array(20).fill(808)]);
  const result = analyseHrv(prepared, { recordingDurationSec: 30 });

  assert.equal(result.status, HRV_STATUS.SUCCESS);
  assert.equal(result.metrics.minNNMs, 800);
  assert.equal(result.metrics.maxNNMs, 820);
  assert.ok(result.metrics.meanNNMs >= 800 && result.metrics.meanNNMs <= 820);
});

test('analysis duration is the time the accepted intervals cover', () => {
  // 25 intervals of 800 ms = 20 s of analysed time.
  const prepared = preparedFromNn(new Array(25).fill(800));
  const result = analyseHrv(prepared, { recordingDurationSec: 60 });

  assert.equal(result.recording.analysisDurationSec, 20);
  assert.equal(result.recording.durationSec ?? result.recording.recordingDurationSec, 60);
});

test('recording and analysis duration plus NN count are always reported', () => {
  const result = hrvFromRrList(steadyRrList(60), { recordingDurationSec: 60 });

  assert.equal(typeof result.recording.recordingDurationSec, 'number');
  assert.equal(typeof result.recording.analysisDurationSec, 'number');
  assert.equal(typeof result.counts.validNNIntervals, 'number');
});

// -- Short / ultra-short recordings -----------------------------------

test('a short recording is flagged as such', () => {
  // 60 intervals x ~800 ms = ~48 s of analysed time.
  const result = hrvFromRrList(steadyRrList(60), { recordingDurationSec: 60 });

  assert.equal(result.status, HRV_STATUS.SUCCESS);
  assert.equal(result.recording.shortRecording, true);
  assert.equal(result.recording.ultraShortRecording, true);
  assert.match(result.patientSummary, /short recording/i);
  assert.match(result.technicalSummary, /ultra-short/i);
});

test('a long recording is not flagged as short', () => {
  // 500 intervals x 800 ms = 400 s, past the 300 s short-term window.
  const result = hrvFromRrList(steadyRrList(500), { recordingDurationSec: 420 });

  assert.equal(result.recording.shortRecording, false);
  assert.equal(result.recording.ultraShortRecording, false);
  assert.ok(!/short recording/i.test(result.patientSummary));
});

test('ultra-short recordings still report all three metrics', () => {
  // Around 60 s: RMSSD is the headline ultra-short measure, but SDNN and pNN50
  // are still returned - labelled, not suppressed.
  const result = hrvFromRrList(steadyRrList(75, 800, 25), { recordingDurationSec: 60 });

  assert.equal(result.status, HRV_STATUS.SUCCESS);
  assert.equal(typeof result.metrics.rmssdMs, 'number');
  assert.equal(typeof result.metrics.sdnnMs, 'number');
  assert.equal(typeof result.metrics.pnn50Percent, 'number');
  assert.equal(result.recording.ultraShortRecording, true);
});

// -- Insufficient data ------------------------------------------------

test('an empty sequence reports insufficient data, not zeroes', () => {
  const result = analyseHrv(prepareNnSequence([]));

  assert.equal(result.status, HRV_STATUS.NO_DATA);
  assert.equal(result.metrics, null);
  assert.match(result.message, /No clean heartbeat intervals/);
});

test('too few NN intervals reports insufficient_data with the documented message', () => {
  const result = hrvFromRrList(steadyRrList(5), { recordingDurationSec: 10 });

  assert.equal(result.status, HRV_STATUS.INSUFFICIENT_DATA);
  assert.equal(result.metrics, null);
  assert.equal(result.message, 'Not enough clean heartbeat intervals to calculate reliable HRV.');
  assert.ok(result.counts.validNNIntervals < HRV_THRESHOLDS.MIN_NN_FOR_HRV);
});

test('no metric is ever reported as zero when data is insufficient', () => {
  for (const rrList of [[], [800], steadyRrList(3), steadyRrList(19)]) {
    const result = hrvFromRrList(rrList, { recordingDurationSec: 20 });
    assert.notEqual(result.status, HRV_STATUS.SUCCESS);
    assert.equal(result.metrics, null, `metrics leaked for ${rrList.length} intervals`);
    assert.deepEqual(result.series, []);
    assert.equal(result.patientSummary, null);
  }
});

test('enough intervals but too short an analysed window is rejected', () => {
  // 25 intervals of 300 ms = 7.5 s, under the 10 s floor.
  const prepared = preparedFromNn(new Array(25).fill(300));
  const result = analyseHrv(prepared, { recordingDurationSec: 8 });

  assert.equal(result.status, HRV_STATUS.INSUFFICIENT_DATA);
  assert.match(result.message, /too short/);
});

test('too few unbroken successive pairs is rejected even with enough intervals', () => {
  // 30 NN intervals but every one follows a gap, so there are no valid pairs.
  const prepared = preparedFromNn(new Array(30).fill(800));
  prepared.nn = prepared.nn.map((n) => ({ ...n, precededByGap: true }));

  const result = analyseHrv(prepared, { recordingDurationSec: 60 });
  assert.equal(result.status, HRV_STATUS.INSUFFICIENT_DATA);
  assert.match(result.message, /consecutive/);
});

// -- Poor signal quality ----------------------------------------------

test('HRV is withheld when artifacts dominate the recording', () => {
  // 30 valid NN out of 100 candidate intervals = 70% artifact.
  const prepared = preparedFromNn(new Array(30).fill(800), {
    totalIntervals: 100,
    quality: 'Poor',
  });
  const result = analyseHrv(prepared, { recordingDurationSec: 90 });

  assert.equal(result.status, HRV_STATUS.POOR_SIGNAL_QUALITY);
  assert.equal(result.metrics, null);
  assert.match(result.message, /too much of the recording was affected by signal artifacts/);
  // The accounting that explains the refusal survives.
  assert.equal(result.counts.totalRRIntervals, 100);
  assert.equal(result.counts.validNNIntervals, 30);
});

test('HRV confidence is capped by the upstream ECG signal quality', () => {
  const base = {
    artifactPercentage: 1,
    nnCount: 400,
    analysisDurationSec: 400,
  };
  assert.equal(hrvQuality({ ...base, ecgSignalQuality: 'Good' }), HRV_QUALITY.GOOD);
  // A poor ECG trace cannot yield a Good HRV result no matter the counts.
  assert.equal(hrvQuality({ ...base, ecgSignalQuality: 'Poor' }), HRV_QUALITY.LIMITED);
});

test('HRV quality bands respond to artifact share, count and duration', () => {
  assert.equal(
    hrvQuality({
      artifactPercentage: 2,
      nnCount: 400,
      analysisDurationSec: 400,
      ecgSignalQuality: 'Good',
    }),
    HRV_QUALITY.GOOD
  );
  // Short window keeps it out of Good.
  assert.equal(
    hrvQuality({
      artifactPercentage: 2,
      nnCount: 60,
      analysisDurationSec: 50,
      ecgSignalQuality: 'Good',
    }),
    HRV_QUALITY.ACCEPTABLE
  );
  assert.equal(
    hrvQuality({
      artifactPercentage: 15,
      nnCount: 25,
      analysisDurationSec: 40,
      ecgSignalQuality: 'Fair',
    }),
    HRV_QUALITY.LIMITED
  );
  assert.equal(
    hrvQuality({
      artifactPercentage: 5,
      nnCount: 5,
      analysisDurationSec: 40,
      ecgSignalQuality: 'Good',
    }),
    HRV_QUALITY.INSUFFICIENT
  );
});

// -- Personal baseline ------------------------------------------------

test('no baseline is offered until enough prior sessions exist', () => {
  const result = personalBaseline({ rmssdMs: 30 }, [{ rmssdMs: 32, sdnnMs: 40 }]);

  assert.equal(result.available, false);
  assert.equal(result.sessionsUsed, 1);
  assert.equal(result.baselineRmssdMs, null);
  assert.equal(result.rmssdChangePercent, null);
});

test('baseline uses the median of prior valid sessions', () => {
  const prior = [
    { rmssdMs: 30, sdnnMs: 40 },
    { rmssdMs: 34, sdnnMs: 44 },
    { rmssdMs: 32, sdnnMs: 42 },
  ];
  const result = personalBaseline({ rmssdMs: 31 }, prior);

  assert.equal(result.available, true);
  assert.equal(result.baselineRmssdMs, 32); // median of 30, 32, 34
  assert.equal(result.baselineSdnnMs, 42);
  assert.equal(result.sessionsUsed, 3);
});

test('baseline change is reported as a percentage of the personal reference', () => {
  const prior = [{ rmssdMs: 34 }, { rmssdMs: 34 }, { rmssdMs: 34 }];
  const result = personalBaseline({ rmssdMs: 31 }, prior);

  // (31 - 34) / 34 = -8.82%
  assert.ok(Math.abs(result.rmssdChangePercent + 8.8) < 0.1, `got ${result.rmssdChangePercent}`);
  assert.equal(result.comparison, 'in_line'); // under the 15% meaningful-change bound
});

test('a large move from the personal reference is labelled, never called abnormal', () => {
  const prior = [{ rmssdMs: 40 }, { rmssdMs: 40 }, { rmssdMs: 40 }];
  const lower = personalBaseline({ rmssdMs: 20 }, prior);
  const higher = personalBaseline({ rmssdMs: 60 }, prior);

  assert.equal(lower.comparison, 'lower');
  assert.equal(higher.comparison, 'higher');
});

test('invalid prior sessions are excluded from the baseline', () => {
  const prior = [
    { rmssdMs: null },
    { rmssdMs: 0 },
    { rmssdMs: NaN },
    { rmssdMs: 30 },
    { rmssdMs: 32 },
  ];
  const result = personalBaseline({ rmssdMs: 31 }, prior);

  // Only two usable priors, below the minimum.
  assert.equal(result.available, false);
  assert.equal(result.sessionsUsed, 2);
});

test('baseline draws on at most the configured number of recent sessions', () => {
  const prior = Array.from({ length: 30 }, (_, i) => ({ rmssdMs: 30 + i }));
  const result = personalBaseline({ rmssdMs: 31 }, prior);

  assert.equal(result.sessionsUsed, HRV_THRESHOLDS.BASELINE_MAX_SESSIONS);
  // Median of the first 10 (30..39) is 34.5, not the median of all 30.
  assert.equal(result.baselineRmssdMs, 34.5);
});

test('the report states when a baseline is not yet available', () => {
  const result = hrvFromRrList(steadyRrList(60), { recordingDurationSec: 60 });

  assert.equal(result.baseline.available, false);
  assert.match(result.patientSummary, /personal baseline is not available yet/i);
});

test('a baseline comparison reaches the patient summary', () => {
  const result = hrvFromRrList(steadyRrList(60), {
    recordingDurationSec: 60,
    priorSessions: [{ rmssdMs: 12 }, { rmssdMs: 12 }, { rmssdMs: 12 }],
  });

  assert.equal(result.baseline.available, true);
  assert.match(result.patientSummary, /your own recent recordings/i);
});

// -- Series -----------------------------------------------------------

test('the NN series contains only accepted intervals', () => {
  const rrList = [...steadyRrList(40), 2300, ...steadyRrList(40)];
  const result = hrvFromRrList(rrList, { recordingDurationSec: 70 });

  assert.equal(result.series.length, result.counts.validNNIntervals);
  assert.ok(result.series.every((p) => p.nnMs < 2000));
  for (let i = 1; i < result.series.length; i += 1) {
    assert.ok(result.series[i].offsetSec > result.series[i - 1].offsetSec);
  }
});

test('the NN series is downsampled for very long recordings', () => {
  const count = HRV_THRESHOLDS.MAX_SERIES_POINTS * 2;
  const result = hrvFromRrList(steadyRrList(count), { recordingDurationSec: 2000 });

  assert.ok(result.series.length <= HRV_THRESHOLDS.MAX_SERIES_POINTS + 1);
});

// -- Wording ----------------------------------------------------------

test('the patient summary explains HRV in plain language and disclaims diagnosis', () => {
  const result = hrvFromRrList(steadyRrList(400), { recordingDurationSec: 340 });

  assert.match(result.patientSummary, /time between your heartbeats naturally changes/);
  assert.match(result.patientSummary, /not a diagnosis/);
  assert.match(result.patientSummary, /measurable beat-to-beat variation/);
});

test('patient-facing wording never grades HRV or mentions vagal tone', () => {
  for (const rrList of [steadyRrList(60), steadyRrList(400, 800, 60)]) {
    const result = hrvFromRrList(rrList, { recordingDurationSec: 340 });
    const patient = result.patientSummary.toLowerCase();

    for (const term of [
      'vagal',
      'parasympathetic',
      'healthy',
      'unhealthy',
      'abnormal',
      'stress',
      'disease',
      'risk',
      'good hrv',
      'poor hrv',
      'low hrv',
      'high hrv',
    ]) {
      assert.ok(!patient.includes(term), `patient summary mentions "${term}"`);
    }
  }
});

test('the technical summary may discuss parasympathetic association, hedged', () => {
  const result = hrvFromRrList(steadyRrList(400), { recordingDurationSec: 340 });

  assert.match(result.technicalSummary, /parasympathetic/);
  assert.match(result.technicalSummary, /depends on recording conditions/);
  // And it states the architectural guarantee.
  assert.match(result.technicalSummary, /no independent R-peak detection/);
});

test('the technical summary documents the SDNN estimator difference', () => {
  const result = hrvFromRrList(steadyRrList(400), { recordingDurationSec: 340 });
  assert.match(result.technicalSummary, /n-1 estimator/);
  assert.match(result.technicalSummary, /population estimator/);
});

test('the technical summary reports skipped pairs', () => {
  const rrList = [...steadyRrList(40), 1600, ...steadyRrList(40)];
  const result = hrvFromRrList(rrList, { recordingDurationSec: 70 });
  assert.match(result.technicalSummary, /excluded rather than differenced across the gap/);
});

// -- Determinism ------------------------------------------------------

test('HRV is deterministic for identical input', () => {
  const prepared = prepareNnSequence(peaksFromRrList(steadyRrList(80)));
  assert.deepEqual(
    analyseHrv(prepared, { recordingDurationSec: 70 }),
    analyseHrv(prepared, { recordingDurationSec: 70 })
  );
});

test('ECG/RR and HRV agree on the interval counts for the same session', () => {
  const { analyseEcgRr } = require('../src/utils/ecgRrAnalysis');
  const rrList = [...steadyRrList(60), 2300, 1600, 400, 400, ...steadyRrList(60)];
  const prepared = prepareNnSequence(peaksFromRrList(rrList));

  const ecgRr = analyseEcgRr(prepared, { recordingDurationSec: 110 });
  const hrv = analyseHrv(prepared, { recordingDurationSec: 110 });

  assert.equal(ecgRr.counts.beatsDetected, hrv.counts.totalRRIntervals);
  assert.equal(ecgRr.counts.validBeats, hrv.counts.validNNIntervals);
  assert.equal(ecgRr.counts.invalidBeats, hrv.counts.excludedIntervals);
  // Mean RR (ECG/RR) and mean NN (HRV) describe the same set of beats.
  assert.equal(ecgRr.rr.meanRR, hrv.metrics.meanNNMs);
  assert.equal(ecgRr.rr.minRR, hrv.metrics.minNNMs);
  assert.equal(ecgRr.rr.maxRR, hrv.metrics.maxNNMs);
});
