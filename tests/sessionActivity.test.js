/**
 * The Session model now carries optional GPS-workout data (merged from the
 * removed Activity resource). These tests pin that the fields default safely for
 * a plain ECG session and serialize correctly for a workout session — so an
 * existing ECG recording is never given misleading workout data, and a workout
 * round-trips through toFrontend().
 *
 * Pure model construction (no DB connection needed): mongoose applies schema
 * defaults at `new Model()` time.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const Session = require('../src/models/Session');

const base = {
  id: 'sess_test',
  userId: 'u1',
  userEmail: 'u@x.com',
  userName: 'U',
  deviceId: 'd1',
  startTime: '2026-10-12T10:00:00.000Z',
  endTime: '2026-10-12T10:30:00.000Z',
  duration: 30,
  dataPoints: 100,
  dataSource: 'stored',
  avgTemp: '36.5',
  avgHR: 80,
  minHR: 60,
  maxHR: 120,
};

test('a plain ECG session defaults activityType to "ecg" with empty workout data', () => {
  const s = new Session({ ...base });
  const f = s.toFrontend();
  assert.equal(f.activityType, 'ecg');
  assert.equal(f.distanceMeters, 0);
  assert.equal(f.activeDurationSeconds, 0);
  assert.equal(f.calories, 0);
  assert.equal(f.averagePaceSecPerKm, null);
  assert.equal(f.rmssd, null);
  assert.equal(f.sdnn, null);
  assert.deepEqual(f.routePoints, []);
  // endLocation mirrors the existing `location` subdoc: present but all-null for
  // a session that never recorded one.
  assert.equal(f.endLocation.lat, null);
  assert.equal(f.endLocation.lng, null);
});

test('a workout session serializes its activity fields through toFrontend()', () => {
  const s = new Session({
    ...base,
    activityType: 'running',
    distanceMeters: 5240,
    activeDurationSeconds: 1800,
    pausedDurationSeconds: 60,
    averageSpeedMps: 2.9,
    maxSpeedMps: 4.1,
    averagePaceSecPerKm: 343,
    calories: 420,
    rmssd: 42,
    sdnn: 55,
    endLocation: { lat: 12.9, lng: 77.6, accuracy: 5, address: null },
    routePoints: [
      { latitude: 12.90, longitude: 77.60, timestamp: '2026-10-12T10:00:00.000Z' },
      { latitude: 12.91, longitude: 77.61, timestamp: '2026-10-12T10:15:00.000Z' },
    ],
  });
  const f = s.toFrontend();
  assert.equal(f.activityType, 'running');
  assert.equal(f.distanceMeters, 5240);
  assert.equal(f.activeDurationSeconds, 1800);
  assert.equal(f.calories, 420);
  assert.equal(f.averagePaceSecPerKm, 343);
  assert.equal(f.rmssd, 42);
  assert.equal(f.sdnn, 55);
  assert.equal(f.routePoints.length, 2);
  assert.equal(f.routePoints[0].latitude, 12.90);
  assert.equal(f.endLocation.lat, 12.9);
  // Existing ECG summary fields are untouched by the merge.
  assert.equal(f.avgHR, 80);
  assert.equal(f.duration, 30);
});

test('an unknown activityType is rejected by the enum', () => {
  const s = new Session({ ...base, activityType: 'teleporting' });
  const err = s.validateSync();
  assert.ok(err, 'expected a validation error for an invalid activityType');
  assert.ok(err.errors.activityType, 'activityType should be the offending path');
});
