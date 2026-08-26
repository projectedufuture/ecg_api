/**
 * Unit tests for the rhythm screening engine.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  screenRhythm,
  aggregatePeriods,
  findIrregularPeriods,
  classificationConfidence,
  hrFromNn,
  RHYTHM_THRESHOLDS,
  RHYTHM_STATUS,
  RHYTHM_EVENT_TYPE,
} = require('../src/utils/rhythmScreening');

const { prepareNnSequence, analyseEcgRr, REGULARITY } = require('../src/utils/ecgRrAnalysis');

// -- helpers ----------------------------------------------------------

function peaksFromRrList(rrList, start = 10000) {
  const timestamps = [start];
  for (const rr of rrList) timestamps.push(timestamps[timestamps.length - 1] + rr);
  return timestamps.map((t) => ({
    rPeakTimestamp: t,
    timestamp: new Date(1700000000000 + (t - start)).toISOString(),
    leadOff: false,
  }));
}

/** Run the real ECG/RR pipeline, then screen its output — as production does. */
function screenFromRrList(rrList, options = {}) {
  const prepared = prepareNnSequence(peaksFromRrList(rrList));
  const ecgRr = analyseEcgRr(prepared, options);
  return screenRhythm(prepared, { ...options, ecgRrEvents: ecgRr.events || [] });
}

/** `count` intervals at a steady rate, with small jitter. */
const steady = (count, rrMs = 800, jitter = 8) =>
  Array.from({ length: count }, (_, i) => rrMs + ((i % 5) - 2) * jitter);

// -- HR derivation ----------------------------------------------------

test('heart rate is derived from the RR interval', () => {
  assert.equal(hrFromNn(800), 75);
  assert.equal(hrFromNn(600), 100);
  assert.equal(hrFromNn(1000), 60);
});

test('heart rate never divides by zero', () => {
  assert.equal(hrFromNn(0), null);
  assert.equal(hrFromNn(-500), null);
  assert.equal(hrFromNn(NaN), null);
});

// -- Normal recording -------------------------------------------------

test('a regular recording screens clean', () => {
  const result = screenFromRrList(steady(200, 800, 8));

  assert.equal(result.status, RHYTHM_STATUS.SUCCESS);
  assert.equal(result.summary.rhythmPattern, REGULARITY.REGULAR);
  assert.equal(result.summary.averageHR, 75);
  assert.equal(result.screening.elevatedHRPeriods, 0);
  assert.equal(result.screening.lowHRPeriods, 0);
  assert.equal(result.screening.irregularRRPeriods, 0);
  assert.equal(result.screening.possibleLongRREvents, 0);
  assert.deepEqual(result.events, []);
});

test('the summary reports the heart-rate range from the RR sequence', () => {
  const result = screenFromRrList(steady(200, 800, 40));

  // 800 +/- 80 ms -> 68 to 83 BPM.
  assert.ok(result.summary.minimumHR >= 66 && result.summary.minimumHR <= 70);
  assert.ok(result.summary.maximumHR >= 81 && result.summary.maximumHR <= 85);
  assert.ok(result.summary.minimumHR < result.summary.averageHR);
  assert.ok(result.summary.maximumHR > result.summary.averageHR);
});

// -- Elevated / low heart rate ----------------------------------------

test('a sustained fast stretch becomes one elevated-HR period, not many events', () => {
  // 500 ms = 120 BPM for 60 beats (~30 s), inside an otherwise normal recording.
  const result = screenFromRrList([...steady(60), ...steady(60, 500, 5), ...steady(60)]);

  assert.equal(result.screening.elevatedHRPeriods, 1);
  const elevated = result.events.filter(
    (e) => e.eventType === RHYTHM_EVENT_TYPE.ELEVATED_HEART_RATE
  );
  assert.equal(elevated.length, 1, 'per-beat events were not aggregated');
  assert.ok(elevated[0].heartRateBpm >= 115);
  assert.ok(elevated[0].durationSec >= RHYTHM_THRESHOLDS.MIN_PERIOD_SEC);
  assert.ok(elevated[0].beats >= RHYTHM_THRESHOLDS.MIN_PERIOD_BEATS);
});

test('an elevated period is labelled as needing context, never as tachycardia', () => {
  const result = screenFromRrList([...steady(60), ...steady(60, 500, 5), ...steady(60)]);
  const elevated = result.events.find(
    (e) => e.eventType === RHYTHM_EVENT_TYPE.ELEVATED_HEART_RATE
  );

  assert.equal(elevated.requiresContext, true);
  assert.match(elevated.description, /Elevated heart-rate period/);
  assert.ok(!/tachycardia/i.test(elevated.description));
  assert.match(elevated.description, /rises naturally with activity/);
});

test('a sustained slow stretch becomes one low-HR period', () => {
  // 1200 ms = 50 BPM.
  const result = screenFromRrList([...steady(60), ...steady(60, 1200, 10), ...steady(60)]);

  assert.equal(result.screening.lowHRPeriods, 1);
  const low = result.events.find((e) => e.eventType === RHYTHM_EVENT_TYPE.LOW_HEART_RATE);
  assert.ok(low.heartRateBpm <= 55);
  assert.equal(low.requiresContext, true);
  assert.ok(!/bradycardia/i.test(low.description));
  assert.match(low.description, /common in physically fit/);
});

test('a brief excursion past a threshold does not create a period', () => {
  // Only three fast beats — below both the duration and beat-count floors.
  const result = screenFromRrList([...steady(80), 500, 500, 500, ...steady(80)]);
  assert.equal(result.screening.elevatedHRPeriods, 0);
});

test('the HR thresholds are the documented resting references', () => {
  assert.equal(RHYTHM_THRESHOLDS.ELEVATED_HR_BPM, 100);
  assert.equal(RHYTHM_THRESHOLDS.LOW_HR_BPM, 60);
});

test('periods are aggregated with their peak and mean rate', () => {
  const beats = Array.from({ length: 40 }, (_, i) => ({
    timeSec: i,
    hrBpm: 110 + (i % 5),
    timestamp: null,
    rPeakTimestamp: 1000 + i * 1000,
  }));
  const periods = aggregatePeriods(beats, (b) => b.hrBpm > 100);

  assert.equal(periods.length, 1);
  assert.equal(periods[0].beats, 40);
  assert.equal(periods[0].maxHrBpm, 114);
  assert.equal(periods[0].minHrBpm, 110);
  assert.equal(periods[0].durationSec, 39);
});

// -- Irregularity -----------------------------------------------------

test('a highly variable stretch is flagged as an irregular-RR period', () => {
  // The documented irregular example, repeated to fill a window.
  const irregular = [];
  for (let i = 0; i < 12; i += 1) irregular.push(800, 1200, 650, 1050, 700);

  const result = screenFromRrList([...steady(60), ...irregular, ...steady(60)]);

  assert.ok(result.screening.irregularRRPeriods >= 1);
  const event = result.events.find((e) => e.eventType === RHYTHM_EVENT_TYPE.IRREGULAR_RR);
  assert.match(event.description, /Irregular heartbeat timing detected/);
  assert.match(event.description, /Further clinical evaluation may be appropriate/);
});

test('a regular recording produces no irregular periods', () => {
  const beats = steady(200, 800, 5).map((nnMs, i) => ({
    timeSec: i * 0.8,
    nnMs,
    precededByGap: i === 0,
    timestamp: null,
    rPeakTimestamp: 1000 + i * 800,
  }));
  assert.deepEqual(findIrregularPeriods(beats), []);
});

test('irregularity windows never straddle a hole in the recording', () => {
  // Highly variable NN values, but the beat times are spread far wider than the
  // intervals account for - i.e. large stretches were removed. Such a window is
  // not a contiguous passage of the recording, so its variability is an artifact
  // of the splice and must not be reported as an irregular period.
  const beats = steady(200, 800, 200).map((nnMs, i) => ({
    timeSec: i * 5, // 5 s apart while the intervals cover only ~0.8 s each
    nnMs,
    precededByGap: true,
    timestamp: null,
    rPeakTimestamp: 1000 + i * 5000,
  }));
  assert.deepEqual(findIrregularPeriods(beats), []);
});

test('a contiguous variable stretch IS assessed', () => {
  // Same variability, but the beat times match the intervals: a real passage.
  let t = 0;
  const beats = steady(200, 800, 200).map((nnMs, i) => {
    t += nnMs / 1000;
    return {
      timeSec: t,
      nnMs,
      precededByGap: i === 0,
      timestamp: null,
      rPeakTimestamp: 1000 + t * 1000,
    };
  });
  assert.ok(findIrregularPeriods(beats).length > 0);
});

test('the rhythm pattern label matches the ECG/RR report for the same beats', () => {
  const rrList = [];
  for (let i = 0; i < 40; i += 1) rrList.push(800, 950, 700, 900);

  const prepared = prepareNnSequence(peaksFromRrList(rrList));
  const ecgRr = analyseEcgRr(prepared, {});
  const rhythm = screenRhythm(prepared, { ecgRrEvents: ecgRr.events });

  // Both use the same classifier over the same NN set, so they cannot disagree.
  assert.equal(rhythm.summary.rhythmPattern, ecgRr.rhythm.regularity);
});

// -- Reuse of ECG/RR findings -----------------------------------------

test('long-RR, missed-beat and double-detection findings are carried over, not recomputed', () => {
  const rrList = [...steady(60), 2300, ...steady(60), 1600, ...steady(60), 400, 400, ...steady(60)];
  const prepared = prepareNnSequence(peaksFromRrList(rrList));
  const ecgRr = analyseEcgRr(prepared, {});
  const rhythm = screenRhythm(prepared, { ecgRrEvents: ecgRr.events });

  const countIn = (events, type) => events.filter((e) => e.eventType === type).length;

  // Exactly the counts the ECG/RR analysis found — no independent detection.
  assert.equal(
    rhythm.screening.possibleLongRREvents,
    countIn(ecgRr.events, 'possible_long_rr')
  );
  assert.equal(
    rhythm.screening.possibleMissedBeats,
    countIn(ecgRr.events, 'possible_missed_beat')
  );
  assert.equal(
    rhythm.screening.possibleDoubleDetections,
    countIn(ecgRr.events, 'possible_double_detection')
  );
  assert.ok(rhythm.screening.possibleLongRREvents >= 1);
});

test('carried-over artifact findings are marked for quality review', () => {
  const rrList = [...steady(60), 1600, ...steady(60), 400, 400, ...steady(60)];
  const prepared = prepareNnSequence(peaksFromRrList(rrList));
  const ecgRr = analyseEcgRr(prepared, {});
  const rhythm = screenRhythm(prepared, { ecgRrEvents: ecgRr.events });

  const artifacts = rhythm.events.filter(
    (e) =>
      e.eventType === RHYTHM_EVENT_TYPE.POSSIBLE_MISSED_BEAT ||
      e.eventType === RHYTHM_EVENT_TYPE.POSSIBLE_DOUBLE_DETECTION
  );
  assert.ok(artifacts.length > 0);
  for (const a of artifacts) {
    assert.equal(a.requiresQualityReview, true, 'artifact not flagged for review');
    assert.equal(a.requiresContext, false);
  }
});

test('a long RR is reported as a possible prolonged interval, never a cardiac pause', () => {
  const result = screenFromRrList([...steady(60), 2300, ...steady(60)]);
  const event = result.events.find((e) => e.eventType === RHYTHM_EVENT_TYPE.POSSIBLE_LONG_RR);

  assert.ok(event);
  assert.match(event.description, /Possible prolonged RR interval/);
  assert.ok(!/pause/i.test(result.patientSummary));
});

test('screening consumes the prepared sequence and refuses anything else', () => {
  assert.throws(() => screenRhythm([{ rPeakTimestamp: 1 }]), /prepareNnSequence/);
  assert.throws(() => screenRhythm(null), /prepareNnSequence/);
});

// -- Quality gate -----------------------------------------------------

test('no conclusions are drawn when too much of the recording is artifact', () => {
  const prepared = prepareNnSequence(peaksFromRrList(steady(200)));
  // Force the usable share below the gate.
  prepared.counts = { ...prepared.counts, usablePercentage: 40 };

  const result = screenRhythm(prepared, {});
  assert.equal(result.status, RHYTHM_STATUS.POOR_SIGNAL_QUALITY);
  assert.equal(result.summary, null);
  assert.equal(result.screening, null);
  assert.deepEqual(result.events, []);
  assert.match(result.message, /not clear enough/);
});

test('lead-off beats reduce the usable share and can block screening', () => {
  const peaks = peaksFromRrList(steady(100));
  // Most of the recording has the electrode detached.
  peaks.forEach((p, i) => {
    if (i > 30) p.leadOff = true;
  });

  const prepared = prepareNnSequence(peaks);
  const result = screenRhythm(prepared, {});
  assert.equal(result.status, RHYTHM_STATUS.POOR_SIGNAL_QUALITY);
});

test('too few intervals reports insufficient data, not a pattern', () => {
  const result = screenFromRrList(steady(5));
  assert.equal(result.status, RHYTHM_STATUS.INSUFFICIENT_DATA);
  assert.equal(result.summary, null);
  assert.match(result.message, /Not enough valid heartbeat intervals/);
});

test('an empty session reports no data', () => {
  const result = screenRhythm(prepareNnSequence([]), {});
  assert.equal(result.status, RHYTHM_STATUS.NO_DATA);
  assert.equal(result.summary, null);
  assert.equal(result.patientSummary, null);
});

test('no summary block is ever zero-filled on an unavailable status', () => {
  for (const rrList of [[], [800], steady(4)]) {
    const result = screenFromRrList(rrList);
    assert.notEqual(result.status, RHYTHM_STATUS.SUCCESS);
    assert.equal(result.summary, null);
    assert.equal(result.screening, null);
  }
});

test('classification confidence rises with clean data and falls with artifact', () => {
  const strong = classificationConfidence(400, 100);
  const weak = classificationConfidence(40, 65);
  assert.ok(strong > weak, `${strong} should exceed ${weak}`);
  assert.ok(strong <= 1 && weak > 0);
  // Very little data caps confidence low.
  assert.ok(classificationConfidence(10, 100) <= 0.3);
});

// -- Wording ----------------------------------------------------------

test('no output ever names a rhythm diagnosis', () => {
  const rrList = [];
  for (let i = 0; i < 20; i += 1) rrList.push(800, 1200, 650, 1050, 700);
  const result = screenFromRrList([...rrList, ...steady(60, 500, 5), 2300, ...steady(60, 1200, 5)]);

  // Everything except the technical summary, which names these terms only in
  // its explicit "no rhythm diagnosis is inferred" disclaimer.
  const { technicalSummary, ...rest } = result;
  const everything = JSON.stringify(rest).toLowerCase();
  for (const term of [
    'atrial fibrillation',
    'afib',
    'a-fib',
    'flutter',
    'arrhythmia',
    'pvc',
    'premature ventricular',
    'heart block',
    'ectopic',
    'bradycardia',
    'tachycardia',
  ]) {
    assert.ok(!everything.includes(term), `found "${term}"`);
  }

  // And the disclaimer is present rather than the terms merely being absent.
  assert.ok(
    result.technicalSummary.includes('No rhythm diagnosis (AF, flutter, ectopy, block) is inferred'),
    'the technical summary must state the exclusion explicitly'
  );
});

test('the patient summary uses the documented plain-language wording', () => {
  const regular = screenFromRrList(steady(200, 800, 5));
  assert.match(regular.patientSummary, /remained relatively consistent/);
  assert.match(regular.patientSummary, /not a diagnosis/);

  const elevated = screenFromRrList([...steady(60), ...steady(60, 500, 5), ...steady(60)]);
  assert.match(elevated.patientSummary, /period of elevated heart rate was observed/);
  assert.match(elevated.patientSummary, /naturally increase with movement or activity/);

  const irregular = [];
  for (let i = 0; i < 12; i += 1) irregular.push(800, 1200, 650, 1050, 700);
  const variable = screenFromRrList([...steady(40), ...irregular, ...steady(40)]);
  assert.match(variable.patientSummary, /Irregular heartbeat timing was observed/);
  assert.match(variable.patientSummary, /Further evaluation may be appropriate/);
});

test('the technical summary states the screening limits', () => {
  const result = screenFromRrList(steady(200));

  assert.match(result.technicalSummary, /resting screening references, not abnormality thresholds/);
  assert.match(result.technicalSummary, /No rhythm diagnosis/);
  assert.match(result.technicalSummary, /RR-derived heart rate/);
});

test('screening is deterministic for identical input', () => {
  const prepared = prepareNnSequence(peaksFromRrList(steady(200)));
  const ecgRr = analyseEcgRr(prepared, {});
  assert.deepEqual(
    screenRhythm(prepared, { ecgRrEvents: ecgRr.events }),
    screenRhythm(prepared, { ecgRrEvents: ecgRr.events })
  );
});

test('every emitted event type is one of the documented non-diagnostic types', () => {
  const rrList = [...steady(60), ...steady(60, 500, 5), 2300, 1600, 400, 400, ...steady(60, 1200, 5)];
  const result = screenFromRrList(rrList);
  const allowed = new Set(Object.values(RHYTHM_EVENT_TYPE));

  assert.ok(result.events.length > 0);
  for (const event of result.events) {
    assert.ok(allowed.has(event.eventType), `unexpected type ${event.eventType}`);
    assert.ok(event.description, 'every event needs a description');
  }
});
