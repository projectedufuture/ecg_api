/**
 * Unit tests for the combined (cross-signal) analysis engine.
 *
 * Correlation is checked against constructed relationships with a known sign and
 * strength, so the maths is verified rather than snapshotted.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
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
} = require('../src/utils/combinedAnalysis');

/** Reading rows with optionally coupled signals. */
function rows({ durationSec, stepSec = 1, spo2Fn, tempFn }) {
  const out = [];
  for (let t = 0; t <= durationSec; t += stepSec) {
    out.push({
      t,
      timestamp: null,
      spo2: spo2Fn ? spo2Fn(t) : null,
      tempC: tempFn ? tempFn(t) : null,
    });
  }
  return out;
}

function hrSeries({ durationSec, stepSec = 0.8, hrFn }) {
  const out = [];
  for (let t = 0; t <= durationSec; t += stepSec) out.push({ t, hr: hrFn(t) });
  return out;
}

// -- Pearson ----------------------------------------------------------

test('a perfect positive relationship gives r = 1', () => {
  const xs = [1, 2, 3, 4, 5];
  const ys = [2, 4, 6, 8, 10];
  assert.ok(Math.abs(pearson(xs, ys) - 1) < 1e-12);
});

test('a perfect negative relationship gives r = -1', () => {
  const xs = [1, 2, 3, 4, 5];
  const ys = [10, 8, 6, 4, 2];
  assert.ok(Math.abs(pearson(xs, ys) + 1) < 1e-12);
});

test('an independent relationship gives r near zero', () => {
  const xs = [1, 2, 3, 4, 5, 6, 7, 8];
  const ys = [5, 2, 8, 1, 7, 3, 6, 4];
  assert.ok(Math.abs(pearson(xs, ys)) < 0.5);
});

test('a flat signal has no correlation rather than a spurious one', () => {
  assert.equal(pearson([1, 2, 3, 4], [7, 7, 7, 7]), null);
});

test('correlation needs at least three points', () => {
  assert.equal(pearson([1, 2], [2, 4]), null);
  assert.equal(pearson([], []), null);
});

// -- Classification ---------------------------------------------------

test('association bands follow the documented thresholds', () => {
  assert.equal(classifyAssociation(0.1), ASSOCIATION.NONE);
  assert.equal(classifyAssociation(0.4), ASSOCIATION.WEAK);
  assert.equal(classifyAssociation(0.6), ASSOCIATION.MODERATE);
  assert.equal(classifyAssociation(0.9), ASSOCIATION.STRONG);
  assert.equal(classifyAssociation(null), ASSOCIATION.UNAVAILABLE);
});

test('association ignores sign; direction carries it', () => {
  assert.equal(classifyAssociation(-0.9), ASSOCIATION.STRONG);
  assert.equal(classifyDirection(-0.9), DIRECTION.OPPOSITE);
  assert.equal(classifyDirection(0.9), DIRECTION.TOGETHER);
  assert.equal(classifyDirection(0.05), DIRECTION.NONE);
});

// -- HR resampling ----------------------------------------------------

test('HR is resampled onto the reading times by nearest neighbour', () => {
  const hr = [
    { t: 0, hr: 60 },
    { t: 1, hr: 70 },
    { t: 2, hr: 80 },
  ];
  const out = resampleHrTo([0, 0.9, 2.1], hr);
  assert.deepEqual(out, [60, 70, 80]);
});

test('a target time in a gap gets no HR rather than an invented one', () => {
  // Beats at 0 and 100 s; a target at 50 s is far from both.
  const out = resampleHrTo([50], [
    { t: 0, hr: 60 },
    { t: 100, hr: 70 },
  ]);
  assert.deepEqual(out, [null]);
});

test('an empty HR series yields nulls, not zeroes', () => {
  assert.deepEqual(resampleHrTo([0, 1, 2], []), [null, null, null]);
});

// -- Pairing ----------------------------------------------------------

test('only instants where both signals exist are paired', () => {
  const times = [0, 1, 2, 3];
  const a = [10, null, 30, 40];
  const b = [1, 2, null, 4];
  const pair = pairUp(times, a, b);

  assert.deepEqual(pair.xs, [10, 40]);
  assert.deepEqual(pair.ys, [1, 4]);
  assert.deepEqual(pair.times, [0, 3]);
});

test('a relationship with too few pairs is not described, and says why', () => {
  const pair = { xs: [1, 2, 3], ys: [1, 2, 3], times: [0, 1, 2] };
  const r = describeRelationship('A and B', 'A', 'B', pair);

  assert.equal(r.available, false);
  assert.equal(r.reason, 'insufficient_synchronised_pairs');
  assert.equal(r.r, null);
  assert.match(r.detail, new RegExp(`${COMBINED_THRESHOLDS.MIN_PAIRS}`));
});

test('a relationship with no variance is not described', () => {
  const n = COMBINED_THRESHOLDS.MIN_PAIRS + 10;
  const pair = {
    xs: Array.from({ length: n }, (_, i) => i),
    ys: new Array(n).fill(5),
    times: Array.from({ length: n }, (_, i) => i),
  };
  const r = describeRelationship('A and B', 'A', 'B', pair);

  assert.equal(r.available, false);
  assert.equal(r.reason, 'no_variance');
});

// -- Concurrency ------------------------------------------------------

test('overlapping events from different signals are reported as concurrent', () => {
  const spo2 = [{ eventType: 'possible_desaturation', startSec: 100, endSec: 120 }];
  const rhythm = [{ eventType: 'elevated_heart_rate', startSec: 110, endSec: 160 }];
  const out = findConcurrentEvents(spo2, rhythm, []);

  assert.equal(out.length, 1);
  assert.deepEqual(out[0].signals, ['spo2', 'heart_rate']);
  assert.match(out[0].description, /co-occurrence alone does not establish a physiological link/);
});

test('events far apart are not reported as concurrent', () => {
  const spo2 = [{ eventType: 'possible_desaturation', startSec: 100, endSec: 120 }];
  const rhythm = [{ eventType: 'elevated_heart_rate', startSec: 600, endSec: 660 }];
  assert.deepEqual(findConcurrentEvents(spo2, rhythm, []), []);
});

test('events without a start time cannot be paired', () => {
  const spo2 = [{ eventType: 'possible_desaturation', startSec: null }];
  const rhythm = [{ eventType: 'possible_missed_beat', startSec: null }];
  assert.deepEqual(findConcurrentEvents(spo2, rhythm, []), []);
});

// -- Full pipeline ----------------------------------------------------

test('a constructed positive HR/SpO2 relationship is recovered', () => {
  // Both driven by the same slow wave, so they rise and fall together.
  const wave = (t) => Math.sin((2 * Math.PI * t) / 200);
  const result = analyseCombined(
    {
      rows: rows({ durationSec: 600, spo2Fn: (t) => 96 + 2 * wave(t) }),
      hrSeries: hrSeries({ durationSec: 600, hrFn: (t) => 75 + 10 * wave(t) }),
    },
    { recordingDurationSec: 600 }
  );

  assert.equal(result.status, COMBINED_STATUS.SUCCESS);
  const hrSpo2 = result.relationships.find((r) => r.label.includes('SpO'));
  assert.equal(hrSpo2.available, true);
  assert.ok(hrSpo2.r > 0.9, `expected strong positive, got ${hrSpo2.r}`);
  assert.equal(hrSpo2.association, ASSOCIATION.STRONG);
  assert.equal(hrSpo2.direction, DIRECTION.TOGETHER);
});

test('a constructed inverse relationship is recovered with the right direction', () => {
  const wave = (t) => Math.sin((2 * Math.PI * t) / 200);
  const result = analyseCombined(
    {
      rows: rows({ durationSec: 600, spo2Fn: (t) => 96 - 2 * wave(t) }),
      hrSeries: hrSeries({ durationSec: 600, hrFn: (t) => 75 + 10 * wave(t) }),
    },
    {}
  );

  const hrSpo2 = result.relationships.find((r) => r.label.includes('SpO'));
  assert.ok(hrSpo2.r < -0.9, `expected strong negative, got ${hrSpo2.r}`);
  assert.equal(hrSpo2.direction, DIRECTION.OPPOSITE);
});

test('an unrelated pair is reported as no clear association', () => {
  const result = analyseCombined(
    {
      rows: rows({
        durationSec: 600,
        // A different, incommensurate period so the two do not line up.
        spo2Fn: (t) => 96 + 2 * Math.sin((2 * Math.PI * t) / 37),
      }),
      hrSeries: hrSeries({ durationSec: 600, hrFn: (t) => 75 + 10 * Math.sin((2 * Math.PI * t) / 211) }),
    },
    {}
  );

  const hrSpo2 = result.relationships.find((r) => r.label.includes('SpO'));
  assert.equal(hrSpo2.available, true);
  assert.ok(Math.abs(hrSpo2.r) < COMBINED_THRESHOLDS.R_MODERATE, `r was ${hrSpo2.r}`);
});

test('all three pairings are reported, described or not', () => {
  const result = analyseCombined(
    {
      rows: rows({
        durationSec: 600,
        spo2Fn: (t) => 96 + Math.sin(t / 30),
        tempFn: (t) => 31 + t / 2000,
      }),
      hrSeries: hrSeries({ durationSec: 600, hrFn: (t) => 75 + 5 * Math.sin(t / 30) }),
    },
    {}
  );

  assert.equal(result.relationships.length, 3);
  const labels = result.relationships.map((r) => r.label);
  assert.ok(labels.some((l) => l.includes('SpO')));
  assert.ok(labels.some((l) => l.includes('temperature')));
});

test('a missing signal yields an undescribed relationship with its reason', () => {
  // SpO2 varies (so HR/SpO2 is describable) but temperature is absent entirely.
  const result = analyseCombined(
    {
      rows: rows({ durationSec: 600, spo2Fn: (t) => 96 + 2 * Math.sin(t / 30) }),
      hrSeries: hrSeries({ durationSec: 600, hrFn: (t) => 75 + 5 * Math.sin(t / 30) }),
    },
    {}
  );

  assert.equal(result.status, COMBINED_STATUS.SUCCESS);
  const hrTemp = result.relationships.find((r) => r.label === 'Heart rate and temperature');
  assert.equal(hrTemp.available, false);
  assert.equal(hrTemp.pairs, 0);
  assert.match(hrTemp.detail, /both heart rate and temperature recorded/);
});

test('an unavailable result keeps the reasons and the aligned chart', () => {
  // Every signal constant, so no correlation is computable anywhere.
  const result = analyseCombined(
    {
      rows: rows({ durationSec: 600, spo2Fn: () => 97, tempFn: () => 31.5 }),
      hrSeries: hrSeries({ durationSec: 600, hrFn: () => 75 }),
    },
    {}
  );

  assert.equal(result.status, COMBINED_STATUS.INSUFFICIENT_DATA);
  // The per-pairing reasons survive — they are what explains the outcome.
  assert.equal(result.relationships.length, 3);
  assert.ok(result.relationships.every((r) => !r.available));
  assert.ok(result.relationships.some((r) => r.reason === 'no_variance'));
  // And the aligned series is still returned for inspection.
  assert.ok(result.series.length > 0);
  // Only the narrative is withheld.
  assert.equal(result.patientSummary, null);
});

test('coverage counts which signals were actually present', () => {
  const result = analyseCombined(
    {
      rows: rows({
        durationSec: 600,
        spo2Fn: (t) => (t < 300 ? 96 + 2 * Math.sin(t / 30) : null),
        tempFn: () => 31.5,
      }),
      hrSeries: hrSeries({ durationSec: 600, hrFn: (t) => 75 + 5 * Math.sin(t / 30) }),
    },
    {}
  );

  assert.ok(result.counts.spo2Present > 0);
  assert.ok(result.counts.spo2Present < result.counts.rows);
  assert.equal(result.counts.tempPresent, result.counts.rows);
});

test('the aligned series carries nulls where a signal was absent', () => {
  const result = analyseCombined(
    {
      rows: rows({
        durationSec: 600,
        spo2Fn: (t) => (t < 300 ? 96 + 2 * Math.sin(t / 30) : null),
        tempFn: () => 31.5,
      }),
      hrSeries: hrSeries({ durationSec: 600, hrFn: (t) => 75 + 5 * Math.sin(t / 30) }),
    },
    {}
  );

  assert.ok(result.series.some((p) => p.spo2 === null));
  assert.ok(result.series.every((p) => p.tempC !== null));
});

// -- Availability -----------------------------------------------------

test('no readings reports no data', () => {
  const result = analyseCombined({ rows: [], hrSeries: [] }, {});
  assert.equal(result.status, COMBINED_STATUS.NO_DATA);
  assert.deepEqual(result.relationships, []);
  assert.equal(result.patientSummary, null);
});

test('too short a recording reports insufficient data', () => {
  const result = analyseCombined(
    { rows: rows({ durationSec: 20, spo2Fn: () => 97 }), hrSeries: [] },
    {}
  );
  assert.equal(result.status, COMBINED_STATUS.INSUFFICIENT_DATA);
});

test('a recording with only one signal cannot describe any relationship', () => {
  const result = analyseCombined(
    { rows: rows({ durationSec: 600, tempFn: () => 31.5 }), hrSeries: [] },
    {}
  );

  assert.equal(result.status, COMBINED_STATUS.INSUFFICIENT_DATA);
  assert.match(result.message, /None of the measurement pairs could be compared/);
  // Each pairing still explains itself.
  assert.equal(result.relationships.length, 3);
  assert.ok(result.relationships.every((r) => r.detail));
});

// -- Wording ----------------------------------------------------------

test('the patient summary never claims causation and disclaims diagnosis', () => {
  const wave = (t) => Math.sin((2 * Math.PI * t) / 200);
  const result = analyseCombined(
    {
      rows: rows({ durationSec: 600, spo2Fn: (t) => 96 + 2 * wave(t) }),
      hrSeries: hrSeries({ durationSec: 600, hrFn: (t) => 75 + 10 * wave(t) }),
    },
    {}
  );

  assert.match(result.patientSummary, /describe what was measured rather than why/);
  assert.match(result.patientSummary, /not a diagnosis/);
  for (const term of ['because', 'caused by', 'due to']) {
    assert.ok(!result.patientSummary.toLowerCase().includes(term), `found "${term}"`);
  }
});

test('the technical summary states the synchronisation basis and the artifact caveat', () => {
  const wave = (t) => Math.sin((2 * Math.PI * t) / 200);
  const result = analyseCombined(
    {
      rows: rows({ durationSec: 600, spo2Fn: (t) => 96 + 2 * wave(t) }),
      hrSeries: hrSeries({ durationSec: 600, hrFn: (t) => 75 + 10 * wave(t) }),
    },
    {}
  );

  assert.match(result.technicalSummary, /share one timestamp/);
  assert.match(result.technicalSummary, /no interpolation across rejected beats/);
  assert.match(result.technicalSummary, /It is not causation/);
  assert.match(result.technicalSummary, /shared motion artifact produces the same signature/);
});

test('analysis is deterministic for identical input', () => {
  const input = {
    rows: rows({ durationSec: 600, spo2Fn: (t) => 96 + Math.sin(t / 30), tempFn: () => 31.5 }),
    hrSeries: hrSeries({ durationSec: 600, hrFn: (t) => 75 + 5 * Math.sin(t / 30) }),
  };
  assert.deepEqual(analyseCombined(input, {}), analyseCombined(input, {}));
});
