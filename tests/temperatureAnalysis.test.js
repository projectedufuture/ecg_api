/**
 * Unit tests for the temperature analysis engine.
 *
 * The most important assertions here are the negative ones: that a skin-range
 * reading is labelled as such, and that no fever threshold is ever applied.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  analyseTemperature,
  usableSamples,
  rollingBaseline,
  findExcursions,
  classifyRegime,
  classifyTrend,
  classifyStability,
  driftPerMinute,
  TEMP_THRESHOLDS,
  TEMP_STATUS,
  TEMP_EVENT_TYPE,
  REGIME,
  TREND,
  STABILITY,
} = require('../src/utils/temperatureAnalysis');

function steady({ durationSec, tempC = 31.5, stepSec = 1, jitter = 0 }) {
  const out = [];
  for (let t = 0; t <= durationSec; t += stepSec) {
    out.push({ t, tempC: tempC + (jitter ? ((t % 5) - 2) * jitter : 0), timestamp: null });
  }
  return out;
}

/** Linear ramp from `fromC` to `toC` across the recording. */
function ramp({ durationSec, fromC, toC, stepSec = 1 }) {
  const out = [];
  for (let t = 0; t <= durationSec; t += stepSec) {
    out.push({ t, tempC: fromC + ((toC - fromC) * t) / durationSec, timestamp: null });
  }
  return out;
}

// -- Sample filtering -------------------------------------------------

test('readings outside the plausible contact band are excluded', () => {
  const samples = [
    { t: 0, tempC: 31.5 },
    { t: 1, tempC: 5 }, // sensor detached / reading the room
    { t: 2, tempC: 60 }, // impossible
    { t: 3, tempC: null },
    { t: 4, tempC: 32.0 },
  ];
  assert.equal(usableSamples(samples).length, 2);
});

// -- Measurement regime: the safety-critical part ---------------------

test('a skin-range recording is labelled surface, not judged as low', () => {
  // ~31 C is normal skin and would be profound hypothermia as a core reading.
  const result = analyseTemperature(steady({ durationSec: 400, tempC: 31.2 }), {});

  assert.equal(result.status, TEMP_STATUS.SUCCESS);
  assert.equal(result.regime, REGIME.SKIN);
  assert.match(result.patientSummary, /skin-surface temperature/);
  assert.match(result.patientSummary, /not a body-temperature reading/);
  // Never described as low, cold or hypothermic.
  for (const term of ['hypothermia', 'too low', 'below normal', 'abnormal']) {
    assert.ok(!result.patientSummary.toLowerCase().includes(term), `said "${term}"`);
  }
});

test('a body-range recording is labelled as such but still hedged', () => {
  const result = analyseTemperature(steady({ durationSec: 400, tempC: 36.8 }), {});

  assert.equal(result.regime, REGIME.BODY);
  assert.match(result.patientSummary, /not a substitute for a clinical thermometer/);
});

test('a recording spanning both ranges is labelled mixed', () => {
  const samples = ramp({ durationSec: 400, fromC: 30, toC: 38 });
  assert.equal(classifyRegime(samples.map((s) => s.tempC)), REGIME.MIXED);
});

test('NO fever threshold is applied at any temperature', () => {
  // A reading well above 38 C must still not produce a fever claim.
  const result = analyseTemperature(steady({ durationSec: 400, tempC: 38.9 }), {});

  const text = `${result.patientSummary} ${result.technicalSummary}`.toLowerCase();
  for (const term of ['fever', 'febrile', 'pyrexia', 'hyperthermia', 'infection']) {
    assert.ok(!text.includes(term) || term === 'fever', `found "${term}"`);
  }
  // The only permitted mention of fever is the explicit instruction not to use
  // this reading to check for one.
  assert.match(result.patientSummary, /should not be used to check for a fever/);
  assert.match(result.technicalSummary, /no fever threshold is applied/);
});

test('the technical summary always states this is not core temperature', () => {
  for (const tempC of [31, 34, 37, 39]) {
    const result = analyseTemperature(steady({ durationSec: 400, tempC }), {});
    assert.match(result.technicalSummary, /NOT core body temperature/);
  }
});

// -- Trend and drift --------------------------------------------------

test('a rising recording is reported as rising with its total change', () => {
  const result = analyseTemperature(ramp({ durationSec: 600, fromC: 31, toC: 33 }), {});

  assert.equal(result.trend, TREND.RISING);
  assert.ok(result.summary.totalChangeC > 1, `got ${result.summary.totalChangeC}`);
  assert.ok(result.summary.driftCPerMin > 0);
  assert.match(result.patientSummary, /rose gradually/);
});

test('a falling recording is reported as falling', () => {
  const result = analyseTemperature(ramp({ durationSec: 600, fromC: 33, toC: 31 }), {});
  assert.equal(result.trend, TREND.FALLING);
  assert.ok(result.summary.totalChangeC < -1);
  assert.match(result.patientSummary, /fell gradually/);
});

test('a steady recording is not reported as trending', () => {
  const result = analyseTemperature(steady({ durationSec: 600, tempC: 31.5, jitter: 0.02 }), {});
  assert.equal(result.trend, TREND.STABLE);
  assert.equal(result.stability, STABILITY.STABLE);
});

test('trend bands follow the documented threshold', () => {
  assert.equal(classifyTrend(1.0), TREND.RISING);
  assert.equal(classifyTrend(-1.0), TREND.FALLING);
  assert.equal(classifyTrend(0.1), TREND.STABLE);
  assert.equal(classifyTrend(null), TREND.UNAVAILABLE);
});

test('the trend is measured on smoothed ends, so one noisy sample cannot invent it', () => {
  const samples = steady({ durationSec: 600, tempC: 31.5 });
  samples[samples.length - 1].tempC = 40; // single spike at the very end
  const result = analyseTemperature(samples, {});

  assert.equal(result.trend, TREND.STABLE, 'a single end spike created a trend');
});

test('drift is reported per minute', () => {
  // 2 C over 10 minutes = 0.2 C/min.
  const d = driftPerMinute(ramp({ durationSec: 600, fromC: 30, toC: 32 }));
  assert.ok(Math.abs(d - 0.2) < 0.01, `got ${d}`);
});

// -- Excursions relative to the recording's own baseline --------------

test('a sustained rise above baseline becomes a relative elevation', () => {
  const samples = steady({ durationSec: 900, tempC: 31.0 }).map((s) =>
    s.t >= 400 && s.t < 550 ? { ...s, tempC: 32.0 } : s
  );
  const events = findExcursions(samples, rollingBaseline(samples));
  const elevations = events.filter((e) => e.eventType === TEMP_EVENT_TYPE.ELEVATION);

  assert.ok(elevations.length >= 1);
  assert.ok(elevations[0].changeC >= TEMP_THRESHOLDS.ELEVATION_RISE_C);
  assert.match(elevations[0].description, /from the recording's own baseline/);
});

test('a sustained fall below baseline becomes a relative depression', () => {
  const samples = steady({ durationSec: 900, tempC: 32.0 }).map((s) =>
    s.t >= 400 && s.t < 550 ? { ...s, tempC: 31.0 } : s
  );
  const events = findExcursions(samples, rollingBaseline(samples));
  assert.ok(events.some((e) => e.eventType === TEMP_EVENT_TYPE.DEPRESSION));
});

test('a brief excursion is ignored as noise', () => {
  const samples = steady({ durationSec: 900, tempC: 31.0 }).map((s) =>
    s.t >= 400 && s.t < 410 ? { ...s, tempC: 33 } : s
  );
  assert.deepEqual(findExcursions(samples, rollingBaseline(samples)), []);
});

test('a steady recording produces no excursions', () => {
  const samples = steady({ durationSec: 900, tempC: 31.5, jitter: 0.05 });
  assert.deepEqual(findExcursions(samples, rollingBaseline(samples)), []);
});

test('excursion descriptions name the confounders rather than implying a cause', () => {
  const samples = steady({ durationSec: 900, tempC: 31.0 }).map((s) =>
    s.t >= 400 && s.t < 550 ? { ...s, tempC: 32.0 } : s
  );
  const events = findExcursions(samples, rollingBaseline(samples));
  assert.match(events[0].description, /garment fit and ambient conditions/);
});

// -- Stability --------------------------------------------------------

test('stability bands respond to variability', () => {
  assert.equal(classifyStability(0.1), STABILITY.STABLE);
  assert.equal(classifyStability(0.4), STABILITY.MODERATE);
  assert.equal(classifyStability(1.2), STABILITY.VARIABLE);
  assert.equal(classifyStability(null), STABILITY.UNAVAILABLE);
});

// -- Availability -----------------------------------------------------

test('no usable readings reports no data', () => {
  const samples = Array.from({ length: 300 }, (_, i) => ({ t: i, tempC: 5 }));
  const result = analyseTemperature(samples, {});

  assert.equal(result.status, TEMP_STATUS.NO_DATA);
  assert.equal(result.summary, null);
  assert.equal(result.regime, REGIME.UNAVAILABLE);
});

test('too few samples reports insufficient data', () => {
  const result = analyseTemperature(steady({ durationSec: 20 }), {});
  assert.equal(result.status, TEMP_STATUS.INSUFFICIENT_DATA);
  assert.equal(result.summary, null);
});

test('too short a window reports insufficient data', () => {
  // Enough samples, but densely packed into 60 s (under the 120 s floor).
  const samples = [];
  for (let i = 0; i < 200; i += 1) samples.push({ t: i * 0.3, tempC: 31.5 });
  const result = analyseTemperature(samples, {});
  assert.equal(result.status, TEMP_STATUS.INSUFFICIENT_DATA);
});

test('poor coverage reports poor_signal_quality', () => {
  const samples = [];
  for (let i = 0; i < 1000; i += 1) samples.push({ t: i, tempC: i % 10 === 0 ? 31.5 : 2 });
  const result = analyseTemperature(samples, {});
  assert.equal(result.status, TEMP_STATUS.POOR_SIGNAL_QUALITY);
  assert.equal(result.summary, null);
  assert.equal(result.counts.usableSamples, 100);
});

test('no summary is ever zero-filled on an unavailable status', () => {
  for (const samples of [[], steady({ durationSec: 10 })]) {
    const r = analyseTemperature(samples, {});
    assert.notEqual(r.status, TEMP_STATUS.SUCCESS);
    assert.equal(r.summary, null);
    assert.equal(r.patientSummary, null);
    assert.deepEqual(r.series, []);
  }
});

// -- Full pipeline ----------------------------------------------------

test('a clean recording produces a complete report', () => {
  const result = analyseTemperature(
    ramp({ durationSec: 900, fromC: 30.8, toC: 31.9 }),
    { recordingDurationSec: 900 }
  );

  assert.equal(result.status, TEMP_STATUS.SUCCESS);
  assert.equal(typeof result.summary.meanC, 'number');
  assert.equal(typeof result.summary.totalChangeC, 'number');
  assert.equal(result.regime, REGIME.SKIN);
  assert.equal(result.series.length, result.counts.usableSamples);
  assert.ok(result.series.every((p) => typeof p.baseline === 'number'));
});

test('analysis is deterministic for identical input', () => {
  const samples = ramp({ durationSec: 600, fromC: 31, toC: 32 });
  assert.deepEqual(analyseTemperature(samples, {}), analyseTemperature(samples, {}));
});

test('min/max/mean are the measured values, reported as measured', () => {
  const samples = steady({ durationSec: 600, tempC: 31.0 }).map((s) =>
    s.t === 300 ? { ...s, tempC: 33.5 } : s
  );
  const result = analyseTemperature(samples, {});

  assert.equal(result.summary.minC, 31);
  assert.equal(result.summary.maxC, 33.5);
});
