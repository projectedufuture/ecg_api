const test = require('node:test');
const assert = require('node:assert/strict');

const {
  maxHrFromAge,
  trimp,
  acwr,
  acwrLabel,
  monotony,
  computeAnalytics,
} = require('../src/services/analyticsService');

test('maxHrFromAge uses Tanaka and guards bad input', () => {
  assert.equal(maxHrFromAge(30), Math.round(208 - 0.7 * 30)); // 187
  assert.equal(maxHrFromAge(0), null);
  assert.equal(maxHrFromAge(130), null);
  assert.equal(maxHrFromAge(undefined), null);
});

test('trimp is positive with full inputs and null without resting HR', () => {
  const t = trimp({ minutes: 30, hrAvg: 150, hrRest: 60, hrMax: 190 });
  assert.ok(t > 0);
  assert.equal(trimp({ minutes: 30, hrAvg: 150, hrRest: null, hrMax: 190 }), null);
  assert.equal(trimp({ minutes: 0, hrAvg: 150, hrRest: 60, hrMax: 190 }), null);
  // HRavg below resting → x<=0 → null
  assert.equal(trimp({ minutes: 30, hrAvg: 55, hrRest: 60, hrMax: 190 }), null);
});

test('acwr and labels match the prototype bands', () => {
  assert.equal(acwr(10, 0), null);
  assert.ok(Math.abs(acwr(10, 8) - 1.25) < 1e-9);
  assert.equal(acwrLabel(null), 'insufficient');
  assert.equal(acwrLabel(1.0), 'steady');
  assert.equal(acwrLabel(0.7), 'low');
  assert.equal(acwrLabel(1.6), 'spike');
  assert.equal(acwrLabel(1.4), 'elevated');
});

test('monotony guards zero/near-zero deviation', () => {
  assert.equal(monotony([5, 5, 5, 5, 5, 5, 5]), null); // no deviation
  assert.equal(monotony([0, 0, 0, 0, 0, 0, 0]), null); // no load
  assert.equal(monotony([10]), null); // too few
  assert.ok(monotony([10, 20, 5, 15, 0, 30, 10]) > 0);
});

test('computeAnalytics returns a 28-day series and guards missing resting HR', () => {
  const now = new Date('2026-10-12T12:00:00Z');
  const activities = [
    {
      activityType: 'running',
      startedAt: '2026-10-12T07:00:00Z',
      activeDurationSeconds: 1800,
      distanceMeters: 5000,
      calories: 300,
      averageHeartRate: 150,
    },
  ];

  const withHr = computeAnalytics(activities, {
    age: 30,
    restingHeartRate: 60,
    period: 'week',
    now,
  });
  assert.equal(withHr.hasRestingHr, true);
  assert.equal(withHr.days.length, 28);
  assert.equal(withHr.stats.activityCount, 1);
  assert.equal(withHr.stats.totalCalories, 300);
  // Today should carry positive load.
  assert.ok(withHr.trimpToday > 0);

  const noHr = computeAnalytics(activities, {
    age: 30,
    restingHeartRate: null,
    period: 'week',
    now,
  });
  assert.equal(noHr.hasRestingHr, false);
  assert.equal(noHr.load7Sum, null);
  assert.equal(noHr.acwrLabel, 'insufficient');
  // Volume stats still work without resting HR.
  assert.equal(noHr.stats.activityCount, 1);
});

test('computeAnalytics handles no activities without crashing', () => {
  const r = computeAnalytics([], { age: 30, restingHeartRate: 60, period: 'month' });
  assert.equal(r.days.length, 28);
  assert.equal(r.stats.activityCount, 0);
  assert.equal(r.acwrLabel, 'insufficient');
});
