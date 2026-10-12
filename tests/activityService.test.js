const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isValidActivityType,
  normalizeActivityType,
  deriveAverageSpeedMps,
  derivePaceSecPerKm,
  sanitizeRoutePoints,
  sanitizeHeartRateSamples,
  optPosInt,
} = require('../src/services/activityService');

test('isValidActivityType accepts known types and rejects others', () => {
  assert.equal(isValidActivityType('running'), true);
  assert.equal(isValidActivityType('walking'), true);
  assert.equal(isValidActivityType('cycling'), true);
  assert.equal(isValidActivityType('other'), true);
  assert.equal(isValidActivityType('swimming'), false);
  assert.equal(isValidActivityType(''), false);
  assert.equal(isValidActivityType(undefined), false);
});

test('normalizeActivityType falls back to other for unknown values', () => {
  assert.equal(normalizeActivityType('running'), 'running');
  assert.equal(normalizeActivityType('swimming'), 'other');
  assert.equal(normalizeActivityType(null), 'other');
});

test('deriveAverageSpeedMps computes distance/time and guards junk', () => {
  assert.equal(deriveAverageSpeedMps(1000, 500), 2); // 2 m/s
  assert.equal(deriveAverageSpeedMps(0, 500), 0);
  assert.equal(deriveAverageSpeedMps(1000, 0), 0);
  assert.equal(deriveAverageSpeedMps(-5, 500), 0);
  assert.equal(deriveAverageSpeedMps('abc', 500), 0);
});

test('derivePaceSecPerKm returns sec/km or null when not meaningful', () => {
  // 5000 m in 1500 s → 300 s/km (5:00/km)
  assert.equal(derivePaceSecPerKm(5000, 1500), 300);
  // No distance → null (never 0:00 or Infinity)
  assert.equal(derivePaceSecPerKm(0, 1500), null);
  assert.equal(derivePaceSecPerKm(0.5, 1500), null);
  // No time → null
  assert.equal(derivePaceSecPerKm(5000, 0), null);
  // Implausibly slow (> 6h/km) → null
  assert.equal(derivePaceSecPerKm(1, 100000), null);
});

test('sanitizeRoutePoints keeps valid coords and drops bad ones', () => {
  const input = [
    { latitude: 17.385, longitude: 78.4867, timestamp: '2026-10-12T09:30:00Z' },
    { latitude: 'x', longitude: 10 }, // non-finite lat
    { latitude: 200, longitude: 10 }, // out of range lat
    { latitude: 10, longitude: 999 }, // out of range lng
    null,
    { latitude: -33.8, longitude: 151.2, accuracy: 5, altitude: 12, speed: 3 },
  ];
  const out = sanitizeRoutePoints(input);
  assert.equal(out.length, 2);
  assert.equal(out[0].latitude, 17.385);
  assert.equal(out[1].accuracy, 5);
  assert.equal(out[1].speed, 3);
  // Non-array input → empty
  assert.deepEqual(sanitizeRoutePoints(null), []);
});

test('sanitizeHeartRateSamples keeps only positive bpm', () => {
  const out = sanitizeHeartRateSamples([
    { bpm: 142, t: 3 },
    { bpm: 0, t: 6 },
    { bpm: -5, t: 9 },
    { bpm: 160 }, // missing t → defaults 0
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { bpm: 142, t: 3 });
  assert.deepEqual(out[1], { bpm: 160, t: 0 });
});

test('optPosInt returns rounded positive int or null', () => {
  assert.equal(optPosInt(142.4), 142);
  assert.equal(optPosInt(0), null);
  assert.equal(optPosInt(-3), null);
  assert.equal(optPosInt('abc'), null);
  assert.equal(optPosInt(undefined), null);
});
