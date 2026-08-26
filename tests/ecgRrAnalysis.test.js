/**
 * Unit tests for the ECG/RR analysis engine (PART 33).
 *
 * Uses the Node built-in test runner (node:test), so no extra dependency is
 * introduced. Run with:  npm test
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  analyseEcgRr,
  buildRrIntervals,
  classifyRrIntervals,
  rrStatistics,
  hrStatistics,
  hrFromRr,
  beatToBeatAnalysis,
  rhythmRegularity,
  signalQuality,
  THRESHOLDS,
  RR_QUALITY,
  EVENT_TYPE,
  REGULARITY,
  VARIATION,
  SIGNAL_QUALITY,
} = require('../src/utils/ecgRrAnalysis');

// -- helpers ----------------------------------------------------------

/** Build R-peak records from a list of device-clock timestamps. */
function peaksFromTimestamps(timestamps, overrides = {}) {
  return timestamps.map((t, i) => ({
    rPeakTimestamp: t,
    timestamp: new Date(1700000000000 + (typeof t === 'number' ? t : i)).toISOString(),
    confidence: 0.95,
    leadOff: false,
    ...overrides,
  }));
}

/** Build R-peak records from a list of RR intervals, starting at `start`. */
function peaksFromRrList(rrList, start = 10000) {
  const timestamps = [start];
  for (const rr of rrList) {
    timestamps.push(timestamps[timestamps.length - 1] + rr);
  }
  return peaksFromTimestamps(timestamps);
}

/** Interval list (classified) straight from a list of RR values. */
function classifyRrList(rrList) {
  const { intervals } = buildRrIntervals(peaksFromRrList(rrList));
  return classifyRrIntervals(intervals);
}

/** A long, steady recording that comfortably passes the availability guards. */
function steadyRrList(count, baseRr = 800, jitter = 5) {
  return Array.from({ length: count }, (_, i) => baseRr + ((i % 3) - 1) * jitter);
}

// -- PART 7: RR interval calculation ----------------------------------

test('RR intervals are the differences between consecutive R peaks', () => {
  const { intervals } = buildRrIntervals(peaksFromTimestamps([10000, 10800, 11600, 12400]));

  assert.deepEqual(
    intervals.map((i) => i.rr),
    [800, 800, 800]
  );
  assert.equal(intervals[0].previousRPeak, 10000);
  assert.equal(intervals[0].currentRPeak, 10800);
});

test('R peaks arriving out of order are sorted before differencing', () => {
  const { intervals } = buildRrIntervals(peaksFromTimestamps([11600, 10000, 12400, 10800]));

  assert.deepEqual(
    intervals.map((i) => i.rr),
    [800, 800, 800]
  );
});

test('the documented worked example produces an 800 ms interval', () => {
  const { intervals } = buildRrIntervals(peaksFromTimestamps([125430, 126230]));

  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].rr, 800);
});

// -- PART 8: heart rate ----------------------------------------------

test('HR is 60000 / RR', () => {
  assert.equal(hrFromRr(800), 75);
  assert.equal(hrFromRr(1000), 60);
});

test('HR never divides by zero and never invents a value', () => {
  assert.equal(hrFromRr(0), null);
  assert.equal(hrFromRr(-800), null);
  assert.equal(hrFromRr(NaN), null);
  assert.equal(hrFromRr(Infinity), null);
  assert.equal(hrFromRr(undefined), null);
});

test('HR statistics come only from the intervals passed in', () => {
  // 1000 ms -> 60 BPM, 800 -> 75, 600 -> 100.
  const stats = hrStatistics([1000, 800, 600]);

  assert.equal(stats.minHR, 60);
  assert.equal(stats.maxHR, 100);
  assert.ok(Math.abs(stats.meanHR - (60 + 75 + 100) / 3) < 1e-9);
});

test('HR statistics on an empty interval list are null, not zero', () => {
  assert.deepEqual(hrStatistics([]), { meanHR: null, minHR: null, maxHR: null });
});

// -- PART 10: RR statistics and regularity ---------------------------

test('RR statistics compute mean, min, max, SD and CV%', () => {
  const stats = rrStatistics([800, 805, 810, 798, 807]);

  assert.equal(stats.minRR, 798);
  assert.equal(stats.maxRR, 810);
  assert.equal(stats.meanRR, 804);
  // CV% = SD / mean x 100, and this sequence is tight.
  assert.ok(stats.cvPercent < 1, `expected CV% under 1, got ${stats.cvPercent}`);
});

test('a steady sequence is described as Regular with Low variation', () => {
  const rrList = [800, 805, 810, 798, 807];
  const stats = rrStatistics(rrList);

  assert.equal(rhythmRegularity(stats.cvPercent), REGULARITY.REGULAR);
  assert.equal(beatToBeatAnalysis(classifyRrList(rrList)).variation, VARIATION.LOW);
});

test('regularity bands map CV% to the documented descriptions', () => {
  assert.equal(rhythmRegularity(2), REGULARITY.REGULAR);
  assert.equal(rhythmRegularity(7), REGULARITY.MOSTLY_REGULAR);
  assert.equal(rhythmRegularity(15), REGULARITY.VARIABLE);
  assert.equal(rhythmRegularity(30), REGULARITY.HIGHLY_VARIABLE);
  assert.equal(rhythmRegularity(null), REGULARITY.UNAVAILABLE);
});

test('CV is null rather than Infinity when there is a single interval', () => {
  assert.equal(rrStatistics([800]).sdRR, null);
  assert.equal(rrStatistics([800]).cvPercent, null);
});

// -- PART 9: beat-to-beat --------------------------------------------

test('beat-to-beat reports mean and maximum absolute successive difference', () => {
  // Differences: +100, -50 -> mean |diff| 75, max 100.
  const analysis = beatToBeatAnalysis(classifyRrList([800, 900, 850]));

  assert.equal(analysis.maxAbsDiff, 100);
  assert.equal(analysis.meanAbsDiff, 75);
  assert.equal(analysis.variation, VARIATION.HIGH);
});

test('beat-to-beat variation bands follow the documented thresholds', () => {
  assert.equal(beatToBeatAnalysis(classifyRrList(steadyRrList(20, 800, 5))).variation, VARIATION.LOW);
  assert.equal(
    beatToBeatAnalysis(classifyRrList([800, 830, 800, 830, 800, 830])).variation,
    VARIATION.MODERATE
  );
});

test('beat-to-beat skips pairs separated by an artifact', () => {
  // The 2200 ms interval is not analysable, so no difference is taken either
  // into or out of it - a 1400 ms jump must not be manufactured.
  const analysis = beatToBeatAnalysis(classifyRrList([800, 810, 2200, 805, 800]));

  assert.ok(analysis.maxAbsDiff < 100, `unexpected large jump: ${analysis.maxAbsDiff}`);
});

// -- PART 11: long RR screening --------------------------------------

test('an RR at or above the screening threshold raises a possible long RR event', () => {
  // 2200 / ~805 = 2.73 -> outside the missed-beat band, so it stays a long RR.
  const result = analyseEcgRr(peaksFromRrList([...steadyRrList(20), 2200, ...steadyRrList(20)]));

  const longRr = result.events.filter((e) => e.eventType === EVENT_TYPE.POSSIBLE_LONG_RR);
  assert.equal(longRr.length, 1);
  assert.equal(longRr[0].durationMs, 2200);
  assert.match(longRr[0].description, /Possible prolonged RR interval/);
  assert.equal(result.rhythm.longRrEventCount, 1);
});

test('the long RR screening threshold is 2000 ms', () => {
  assert.equal(THRESHOLDS.LONG_RR_SCREEN_MS, 2000);

  const below = analyseEcgRr(peaksFromRrList([...steadyRrList(20), 1990, ...steadyRrList(20)]));
  assert.equal(
    below.events.filter((e) => e.eventType === EVENT_TYPE.POSSIBLE_LONG_RR).length,
    0
  );
});

test('findings are never labelled in diagnostic terms', () => {
  const result = analyseEcgRr(peaksFromRrList([...steadyRrList(20), 2300, ...steadyRrList(20)]));

  // Everything the UI renders as a label, description or patient-facing
  // sentence. The technical summary is checked separately below because it
  // legitimately names these terms in order to disclaim them.
  const labelled = JSON.stringify({
    regularity: result.rhythm.regularity,
    variation: result.rhythm.beatToBeatVariation,
    quality: result.signalQuality.status,
    events: result.events,
    patientSummary: result.patientSummary,
  }).toLowerCase();

  for (const term of ['arrhythmia', 'atrial fibrillation', 'pvc', 'heart disease', 'healthy']) {
    assert.ok(!labelled.includes(term), `found "${term}" in a user-facing label`);
  }

  // The technical summary states the exclusion explicitly rather than staying
  // silent about it.
  assert.match(result.technicalSummary, /No rhythm classification \(AF, arrhythmia, ectopy\)/);
});

// -- PART 12: missed beat / double detection -------------------------

test('an RR near double the reference is flagged as a possible missed beat, not a pause', () => {
  // 1600 / 800 = 2.0 -> the simplest explanation is one undetected R peak.
  const classified = classifyRrList([...steadyRrList(20), 1600, ...steadyRrList(20)]);
  const flagged = classified.find((i) => i.rr === 1600);

  assert.equal(flagged.quality, RR_QUALITY.MISSED_BEAT);
});

test('a suspicious long RR is not automatically called a physiological pause', () => {
  // 2 x 1050 = 2100 ms, which is above the 2000 ms long-RR threshold, yet it is
  // an exact multiple of the reference. It must be reported as a detection
  // problem rather than counted as a prolonged interval.
  const rrList = [...steadyRrList(20, 1050, 5), 2100, ...steadyRrList(20, 1050, 5)];
  const result = analyseEcgRr(peaksFromRrList(rrList));

  const types = result.events.map((e) => e.eventType);
  assert.ok(types.includes(EVENT_TYPE.POSSIBLE_MISSED_BEAT));
  assert.ok(
    !types.includes(EVENT_TYPE.POSSIBLE_LONG_RR),
    'a multiple-of-reference interval must not be scored as a long RR'
  );
  assert.equal(result.rhythm.longRrEventCount, 0);
  assert.match(
    result.events.find((e) => e.eventType === EVENT_TYPE.POSSIBLE_MISSED_BEAT).description,
    /undetected R peak rather than a pause/
  );
});

test('a short RR pair that sums back to one beat is flagged as a possible double detection', () => {
  // 400 + 400 = 800 = one reference interval.
  const rrList = [...steadyRrList(20), 400, 400, ...steadyRrList(20)];
  const result = analyseEcgRr(peaksFromRrList(rrList));

  const doubles = result.events.filter(
    (e) => e.eventType === EVENT_TYPE.POSSIBLE_DOUBLE_DETECTION
  );
  assert.equal(doubles.length, 2);
  assert.match(doubles[0].description, /same beat detected twice/);
});

test('suspicious short RR intervals are flagged for review rather than dropped silently', () => {
  // 500 ms against an 800 ms reference is short but has no partner summing back
  // to one beat, so it is a short-RR candidate surfaced as a quality event.
  const rrList = [...steadyRrList(20), 500, ...steadyRrList(20)];
  const classified = classifyRrList(rrList);
  const flagged = classified.find((i) => i.rr === 500);

  assert.equal(flagged.quality, RR_QUALITY.SHORT);

  const result = analyseEcgRr(peaksFromRrList(rrList));
  assert.ok(
    result.events.some((e) => e.eventType === EVENT_TYPE.SIGNAL_QUALITY_DROP),
    'a short-RR candidate should surface as a signal-quality event'
  );
});

test('artifact intervals are excluded from the statistics and from the chart series', () => {
  const rrList = [...steadyRrList(20), 2200, ...steadyRrList(20)];
  const result = analyseEcgRr(peaksFromRrList(rrList));

  assert.equal(result.rr.maxRR < 2000, true, 'the 2200 ms artifact leaked into max RR');
  assert.ok(
    result.series.every((p) => p.rr < 2000),
    'an artifact was plotted as a real measurement'
  );
});

// -- PART 13: signal quality -----------------------------------------

test('signal quality bands the usable percentage', () => {
  assert.equal(signalQuality(100, 95).status, SIGNAL_QUALITY.GOOD);
  assert.equal(signalQuality(100, 80).status, SIGNAL_QUALITY.FAIR);
  assert.equal(signalQuality(100, 60).status, SIGNAL_QUALITY.LIMITED);
  assert.equal(signalQuality(100, 20).status, SIGNAL_QUALITY.POOR);
  assert.equal(signalQuality(0, 0).status, SIGNAL_QUALITY.UNAVAILABLE);
});

test('usable percentage is valid beats over detected beats', () => {
  const quality = signalQuality(372, 354);
  assert.ok(Math.abs(quality.usablePercentage - 95.16) < 0.01);
});

test('a recording that is half artifact reports analysis unavailable, not weak numbers', () => {
  // Strictly alternating 800 / 1600. Half the intervals are unusable, which
  // leaves the reference RR sitting between two clusters - at that point no
  // classification is trustworthy, so the report must be withheld.
  const rrList = [];
  for (let i = 0; i < 20; i += 1) rrList.push(800, 1600);
  const result = analyseEcgRr(peaksFromRrList(rrList));

  assert.ok(result.counts.usablePercentage <= THRESHOLDS.MIN_USABLE_PCT);

  assert.equal(result.available, false);
  assert.equal(result.unavailableReason, 'poor_signal_quality');
  assert.match(result.unavailableMessage, /not sufficiently clear/);
  // No manufactured statistics.
  assert.equal(result.rr, undefined);
  assert.equal(result.hr, undefined);
});

test('lead-off beats are excluded from analysis', () => {
  const peaks = peaksFromRrList(steadyRrList(30));
  peaks[10].leadOff = true;
  peaks[11].leadOff = true;

  const result = analyseEcgRr(peaks);
  assert.ok(result.counts.invalidBeats >= 2);
  assert.ok(result.counts.usablePercentage < 100);
});

// -- PART 27 / invalid input -----------------------------------------

test('a null R-peak timestamp is rejected instead of producing an interval', () => {
  const { intervals, rejectedPeaks } = buildRrIntervals([
    { rPeakTimestamp: 10000 },
    { rPeakTimestamp: null },
    { rPeakTimestamp: 10800 },
  ]);

  assert.equal(rejectedPeaks, 1);
  assert.deepEqual(
    intervals.map((i) => i.rr),
    [800]
  );
});

test('duplicate R-peak timestamps do not create a zero-length interval', () => {
  const { intervals, rejectedPeaks } = buildRrIntervals(
    peaksFromTimestamps([10000, 10000, 10800])
  );

  assert.equal(rejectedPeaks, 1);
  assert.deepEqual(
    intervals.map((i) => i.rr),
    [800]
  );
  assert.ok(intervals.every((i) => i.rr > 0));
});

test('negative and non-finite R-peak timestamps are rejected', () => {
  const { intervals, rejectedPeaks } = buildRrIntervals([
    { rPeakTimestamp: -500 },
    { rPeakTimestamp: NaN },
    { rPeakTimestamp: Infinity },
    { rPeakTimestamp: '10000' }, // wrong type
    { rPeakTimestamp: undefined },
    { rPeakTimestamp: 10000 },
    { rPeakTimestamp: 10800 },
  ]);

  assert.equal(rejectedPeaks, 5);
  assert.deepEqual(
    intervals.map((i) => i.rr),
    [800]
  );
});

test('an RR outside the physiological band is marked invalid', () => {
  const classified = classifyRrList([...steadyRrList(20), 5000, ...steadyRrList(20)]);
  const flagged = classified.find((i) => i.rr === 5000);

  assert.equal(flagged.quality, RR_QUALITY.INVALID);
});

test('an empty ECG session reports no data rather than zeroes', () => {
  const result = analyseEcgRr([]);

  assert.equal(result.available, false);
  assert.equal(result.unavailableReason, 'no_data');
  assert.match(result.unavailableMessage, /No ECG\/RR data is available/);
  assert.equal(result.counts.beatsDetected, 0);
  assert.deepEqual(result.events, []);
  assert.deepEqual(result.series, []);
});

test('a single R peak yields no interval and reports no data', () => {
  const result = analyseEcgRr(peaksFromTimestamps([10000]));

  assert.equal(result.available, false);
  assert.equal(result.unavailableReason, 'no_data');
});

test('undefined and null inputs are handled without throwing', () => {
  assert.equal(analyseEcgRr(undefined).unavailableReason, 'no_data');
  assert.equal(analyseEcgRr(null).unavailableReason, 'no_data');
});

test('too few valid intervals reports insufficient data', () => {
  const result = analyseEcgRr(peaksFromRrList(steadyRrList(4)));

  assert.equal(result.available, false);
  assert.equal(result.unavailableReason, 'insufficient_data');
  assert.match(result.unavailableMessage, /Not enough valid ECG data/);
  assert.ok(result.counts.validBeats < THRESHOLDS.MIN_VALID_RR);
});

// -- Full pipeline ---------------------------------------------------

test('a clean recording produces a complete, self-consistent report', () => {
  const rrList = steadyRrList(60, 800, 10);
  const result = analyseEcgRr(peaksFromRrList(rrList));

  assert.equal(result.available, true);
  assert.equal(result.unavailableReason, null);

  // Beat accounting adds up.
  assert.equal(result.counts.validBeats + result.counts.invalidBeats, result.counts.beatsDetected);
  assert.equal(result.counts.beatsDetected, rrList.length);

  // RR and HR agree with each other: HR is derived from RR.
  assert.ok(Math.abs(result.hr.meanHR - 60000 / result.rr.meanRR) < 2);
  // Min HR pairs with max RR and vice versa.
  assert.equal(result.hr.minHR, Math.round(60000 / result.rr.maxRR));
  assert.equal(result.hr.maxHR, Math.round(60000 / result.rr.minRR));

  assert.equal(result.rhythm.regularity, REGULARITY.REGULAR);
  assert.equal(result.signalQuality.status, SIGNAL_QUALITY.GOOD);
  assert.equal(result.signalQuality.usablePercentage, 100);

  // Series carries one point per analysable interval, with a monotonic x axis.
  assert.equal(result.series.length, result.counts.validBeats);
  for (let i = 1; i < result.series.length; i += 1) {
    assert.ok(result.series[i].offsetSec > result.series[i - 1].offsetSec);
  }
});

test('the report is deterministic for identical input', () => {
  const peaks = peaksFromRrList(steadyRrList(40));
  assert.deepEqual(analyseEcgRr(peaks), analyseEcgRr(peaks));
});

test('summaries are populated and patient wording carries a non-diagnostic caveat', () => {
  const result = analyseEcgRr(peaksFromRrList(steadyRrList(40)));

  assert.match(result.patientSummary, /remained relatively consistent/);
  assert.match(result.patientSummary, /not a medical diagnosis/);
  assert.match(result.technicalSummary, /mean absolute successive RR difference/);
  assert.match(result.technicalSummary, /No rhythm classification/);
});

test('the patient summary reports variation and long RR when they are present', () => {
  const rrList = [];
  for (let i = 0; i < 15; i += 1) rrList.push(700, 950, 780, 1100);
  rrList.push(2300);
  const result = analyseEcgRr(peaksFromRrList(rrList));

  assert.equal(result.available, true);
  assert.match(result.patientSummary, /Some variation in heartbeat timing/);
  assert.match(result.patientSummary, /longer-than-usual interval/);
});

test('the chart series is downsampled but still spans the whole recording', () => {
  const count = THRESHOLDS.MAX_SERIES_POINTS * 3;
  const result = analyseEcgRr(peaksFromRrList(steadyRrList(count)));

  assert.ok(result.series.length <= THRESHOLDS.MAX_SERIES_POINTS + 1);
  assert.equal(result.series[0].offsetSec >= 0, true);
  // The last analysable interval is still represented.
  const expectedSpan = (count * 800) / 1000;
  assert.ok(result.series[result.series.length - 1].offsetSec > expectedSpan * 0.9);
});

test('recordingDurationSec prefers the caller-supplied session duration', () => {
  const peaks = peaksFromRrList(steadyRrList(40));

  assert.equal(analyseEcgRr(peaks, { recordingDurationSec: 300 }).recordingDurationSec, 300);
  // Without one, it is measured from the R peaks themselves.
  assert.ok(analyseEcgRr(peaks).recordingDurationSec > 0);
});

test('every event type emitted is one of the documented non-diagnostic types', () => {
  const rrList = [...steadyRrList(20), 2200, 1600, 400, 400, 5000, ...steadyRrList(20)];
  const result = analyseEcgRr(peaksFromRrList(rrList));
  const allowed = new Set(Object.values(EVENT_TYPE));

  assert.ok(result.events.length > 0);
  for (const event of result.events) {
    assert.ok(allowed.has(event.eventType), `unexpected event type ${event.eventType}`);
    assert.ok(event.description, 'every event needs a description');
  }
});

test('events are ordered by their position in the recording', () => {
  const rrList = [...steadyRrList(15), 2200, ...steadyRrList(15), 400, 400, ...steadyRrList(15)];
  const result = analyseEcgRr(peaksFromRrList(rrList));

  for (let i = 1; i < result.events.length; i += 1) {
    assert.ok(result.events[i].rPeakTimestamp >= result.events[i - 1].rPeakTimestamp);
  }
});
