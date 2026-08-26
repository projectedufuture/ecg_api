/**
 * Unit tests for the SpO2 analysis engine.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  analyseSpo2,
  usableSamples,
  rollingBaseline,
  findDesaturations,
  findLowPeriods,
  timeBelow,
  classifyStability,
  SPO2_THRESHOLDS,
  SPO2_STATUS,
  SPO2_EVENT_TYPE,
  STABILITY,
} = require('../src/utils/spo2Analysis');

/** A steady series at `pct`, sampled every `stepSec`. */
function steady({ durationSec, pct = 97, stepSec = 1, jitter = 0 }) {
  const out = [];
  for (let t = 0; t <= durationSec; t += stepSec) {
    out.push({ t, spo2: pct + (jitter ? ((t % 5) - 2) * jitter : 0), timestamp: null });
  }
  return out;
}

/** Insert a dip of `depth` starting at `atSec` lasting `lenSec`. */
function withDip(samples, { atSec, lenSec, depth }) {
  return samples.map((s) =>
    s.t >= atSec && s.t < atSec + lenSec ? { ...s, spo2: s.spo2 - depth } : s
  );
}

// -- Sample filtering -------------------------------------------------

test('the 0 sentinel is excluded, not treated as 0% saturation', () => {
  const samples = [
    { t: 0, spo2: 97 },
    { t: 1, spo2: 0 },
    { t: 2, spo2: 98 },
  ];
  const usable = usableSamples(samples);
  assert.equal(usable.length, 2);
  assert.ok(usable.every((s) => s.spo2 > 0));
});

test('implausible values are excluded', () => {
  const samples = [
    { t: 0, spo2: 97 },
    { t: 1, spo2: 12 }, // below the plausible floor
    { t: 2, spo2: 140 }, // impossible
    { t: 3, spo2: null },
    { t: 4, spo2: 96 },
  ];
  assert.equal(usableSamples(samples).length, 2);
});

// -- Statistics -------------------------------------------------------

test('summary statistics come from the usable samples only', () => {
  const samples = [...steady({ durationSec: 200, pct: 96 })];
  samples[10].spo2 = 0; // sentinel
  const result = analyseSpo2(samples, { recordingDurationSec: 200 });

  assert.equal(result.status, SPO2_STATUS.SUCCESS);
  assert.equal(result.summary.meanPct, 96);
  assert.equal(result.summary.minPct, 96);
  assert.equal(result.summary.maxPct, 96);
  assert.equal(result.counts.excludedSamples, 1);
});

test('stability bands respond to variability', () => {
  assert.equal(classifyStability(0.4), STABILITY.STABLE);
  assert.equal(classifyStability(1.8), STABILITY.MODERATE);
  assert.equal(classifyStability(4), STABILITY.VARIABLE);
  assert.equal(classifyStability(null), STABILITY.UNAVAILABLE);
});

// -- Baseline ---------------------------------------------------------

test('the rolling baseline uses a median, so a dip cannot hide itself', () => {
  // A short deep dip inside a long steady stretch: the baseline stays at 97.
  const samples = withDip(steady({ durationSec: 300, pct: 97 }), {
    atSec: 150,
    lenSec: 15,
    depth: 6,
  });
  const baseline = rollingBaseline(samples);
  const atDip = baseline[samples.findIndex((s) => s.t === 155)];
  assert.equal(atDip, 97, `baseline was dragged to ${atDip}`);
});

// -- Desaturation detection -------------------------------------------

test('a sustained dip below baseline is detected with its depth and nadir', () => {
  const samples = withDip(steady({ durationSec: 300, pct: 97 }), {
    atSec: 150,
    lenSec: 20,
    depth: 5,
  });
  const events = findDesaturations(samples, rollingBaseline(samples));

  assert.equal(events.length, 1);
  const e = events[0];
  assert.equal(e.eventType, SPO2_EVENT_TYPE.DESATURATION);
  assert.equal(e.nadirPct, 92);
  assert.equal(e.dropPct, 5);
  assert.ok(e.durationSec >= 15 && e.durationSec <= 25);
  assert.equal(e.recovered, true);
});

test('a dip shorter than the minimum duration is ignored as noise', () => {
  const samples = withDip(steady({ durationSec: 300, pct: 97 }), {
    atSec: 150,
    lenSec: 3, // under the 10 s floor
    depth: 6,
  });
  assert.deepEqual(findDesaturations(samples, rollingBaseline(samples)), []);
});

test('a shallow dip below the 3% criterion is not an event', () => {
  const samples = withDip(steady({ durationSec: 300, pct: 97 }), {
    atSec: 150,
    lenSec: 20,
    depth: 2,
  });
  assert.deepEqual(findDesaturations(samples, rollingBaseline(samples)), []);
});

test('the stricter 4% criterion reports fewer events than the 3% one', () => {
  const samples = withDip(
    withDip(steady({ durationSec: 400, pct: 97 }), { atSec: 100, lenSec: 20, depth: 3.5 }),
    { atSec: 250, lenSec: 20, depth: 6 }
  );
  const base = rollingBaseline(samples);
  const loose = findDesaturations(samples, base, SPO2_THRESHOLDS.DESAT_DROP_PCT);
  const strict = findDesaturations(samples, base, SPO2_THRESHOLDS.DESAT_DROP_STRICT_PCT);

  assert.equal(loose.length, 2);
  assert.equal(strict.length, 1);
});

test('a drop that never recovers is flagged as such', () => {
  // Step down permanently at the halfway point.
  const samples = steady({ durationSec: 400, pct: 97 }).map((s) =>
    s.t >= 200 ? { ...s, spo2: 90 } : s
  );
  const events = findDesaturations(samples, rollingBaseline(samples));

  // A permanent level shift is either not reported, or reported unrecovered —
  // never as a recovered physiological dip.
  for (const e of events) {
    assert.equal(e.recovered, false);
    assert.match(e.description, /without returning to baseline/);
  }
});

test('an extremely long excursion is not reported as one desaturation', () => {
  const samples = withDip(steady({ durationSec: 600, pct: 97 }), {
    atSec: 100,
    lenSec: 300, // beyond the max duration
    depth: 5,
  });
  const events = findDesaturations(samples, rollingBaseline(samples));
  assert.ok(events.every((e) => e.durationSec <= SPO2_THRESHOLDS.DESAT_MAX_DURATION_SEC));
});

// -- Absolute levels --------------------------------------------------

test('sustained time below an absolute level becomes a low-saturation period', () => {
  const samples = steady({ durationSec: 300, pct: 97 }).map((s) =>
    s.t >= 100 && s.t < 160 ? { ...s, spo2: 87 } : s
  );
  const periods = findLowPeriods(samples, SPO2_THRESHOLDS.LOW_LEVEL_PCT);

  assert.equal(periods.length, 1);
  assert.equal(periods[0].nadirPct, 87);
  assert.ok(periods[0].durationSec >= 55);
});

test('time-below is measured in seconds and as a share of analysed time', () => {
  const samples = steady({ durationSec: 200, pct: 97, stepSec: 1 }).map((s) =>
    s.t < 50 ? { ...s, spo2: 85 } : s
  );
  const below = timeBelow(samples, 90);

  assert.ok(below.seconds >= 45 && below.seconds <= 55, `got ${below.seconds}`);
  assert.ok(below.percent >= 22 && below.percent <= 28, `got ${below.percent}`);
});

test('time-below ignores large gaps rather than counting them as time at a level', () => {
  // A 10-minute hole between two samples must not be charged to either level.
  const samples = [
    { t: 0, spo2: 85 },
    { t: 1, spo2: 85 },
    { t: 601, spo2: 97 },
    { t: 602, spo2: 97 },
  ];
  const below = timeBelow(samples, 90);
  assert.ok(below.seconds <= 2, `gap was counted: ${below.seconds} s`);
});

// -- Availability -----------------------------------------------------

test('an all-sentinel session reports no data', () => {
  const samples = Array.from({ length: 300 }, (_, i) => ({ t: i, spo2: 0 }));
  const result = analyseSpo2(samples, {});

  assert.equal(result.status, SPO2_STATUS.NO_DATA);
  assert.equal(result.summary, null);
  assert.match(result.message, /not measured/);
});

test('too few usable samples reports insufficient data, not zeroes', () => {
  const result = analyseSpo2(steady({ durationSec: 20, pct: 97 }), {});
  assert.equal(result.status, SPO2_STATUS.INSUFFICIENT_DATA);
  assert.equal(result.summary, null);
  assert.deepEqual(result.series, []);
});

test('poor coverage reports poor_signal_quality', () => {
  // 100 usable readings buried in 1000 sentinels = 10% coverage.
  const samples = [];
  for (let i = 0; i < 1000; i += 1) {
    samples.push({ t: i, spo2: i % 10 === 0 ? 97 : 0 });
  }
  const result = analyseSpo2(samples, {});
  assert.equal(result.status, SPO2_STATUS.POOR_SIGNAL_QUALITY);
  assert.equal(result.summary, null);
  // The accounting that explains the refusal survives.
  assert.equal(result.counts.usableSamples, 100);
  assert.ok(result.counts.coveragePct < SPO2_THRESHOLDS.MIN_COVERAGE_PCT);
});

test('no summary is ever zero-filled on an unavailable status', () => {
  for (const samples of [[], steady({ durationSec: 10 })]) {
    const r = analyseSpo2(samples, {});
    assert.notEqual(r.status, SPO2_STATUS.SUCCESS);
    assert.equal(r.summary, null);
    assert.equal(r.patientSummary, null);
  }
});

// -- Full pipeline ----------------------------------------------------

test('a clean recording produces a complete report', () => {
  const samples = withDip(steady({ durationSec: 400, pct: 97, jitter: 0.3 }), {
    atSec: 200,
    lenSec: 20,
    depth: 5,
  });
  const result = analyseSpo2(samples, { recordingDurationSec: 400 });

  assert.equal(result.status, SPO2_STATUS.SUCCESS);
  assert.equal(result.summary.desaturationEvents, 1);
  assert.equal(typeof result.summary.meanPct, 'number');
  assert.equal(result.series.length, result.counts.usableSamples);
  assert.ok(result.series.every((p) => typeof p.baseline === 'number'));
  assert.equal(result.counts.coveragePct, 100);
});

test('the series carries the baseline alongside the trace', () => {
  const result = analyseSpo2(steady({ durationSec: 300, pct: 96 }), {});
  assert.ok(result.series.length > 0);
  assert.equal(result.series[0].spo2, 96);
  assert.equal(result.series[0].baseline, 96);
});

test('analysis is deterministic for identical input', () => {
  const samples = withDip(steady({ durationSec: 300 }), { atSec: 150, lenSec: 20, depth: 5 });
  assert.deepEqual(analyseSpo2(samples, {}), analyseSpo2(samples, {}));
});

// -- Wording ----------------------------------------------------------

test('the patient summary explains the measurement and disclaims diagnosis', () => {
  const result = analyseSpo2(steady({ durationSec: 300, pct: 97 }), {});
  assert.match(result.patientSummary, /oxygen saturation measured by the pulse sensor/);
  assert.match(result.patientSummary, /not a diagnosis/);
});

test('a dip is described as needing checking, never as a diagnosis', () => {
  const samples = withDip(steady({ durationSec: 300, pct: 97 }), {
    atSec: 150,
    lenSec: 20,
    depth: 5,
  });
  const result = analyseSpo2(samples, {});

  assert.match(result.patientSummary, /Movement can cause the sensor to read low/);
  assert.match(result.events[0].description, /Motion artifact can produce the same pattern/);
});

test('no output names a respiratory or oxygenation diagnosis', () => {
  const samples = withDip(steady({ durationSec: 400, pct: 92 }), {
    atSec: 200,
    lenSec: 25,
    depth: 6,
  });
  const result = analyseSpo2(samples, {});
  const text = JSON.stringify(result).toLowerCase();

  for (const term of ['hypoxaemia', 'hypoxemia', 'apnea', 'apnoea', 'copd', 'respiratory failure', 'abnormal']) {
    assert.ok(!text.includes(term), `found "${term}"`);
  }
});

test('the technical summary states the artifact limitation', () => {
  const result = analyseSpo2(steady({ durationSec: 300, pct: 97 }), {});
  assert.match(result.technicalSummary, /motion artifacts indistinguishable from true desaturation/);
  assert.match(result.technicalSummary, /no oxygenation diagnosis is inferred/);
});

test('low coverage is disclosed in the patient wording', () => {
  const samples = [];
  for (let i = 0; i < 600; i += 1) samples.push({ t: i, spo2: i % 2 === 0 ? 97 : 0 });
  const result = analyseSpo2(samples, {});

  assert.equal(result.status, SPO2_STATUS.SUCCESS);
  assert.match(result.patientSummary, /usable reading for only about/);
});
