/**
 * Tests for the report response mapper.
 *
 * `toReportResponse` is the shape contract between the backend and the Reports
 * UI, and it is pure, so it is tested here without a database.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { toReportResponse } = require('../src/services/ecgRrService');

const session = {
  id: 'sess_abc',
  name: 'Morning recording',
  userId: 'usr_1',
  userName: 'Test User',
  deviceId: 'BIO-001',
  startTime: '2026-08-24T10:30:00.000Z',
  endTime: '2026-08-24T10:35:00.000Z',
};

const availableAnalysis = {
  available: true,
  unavailableReason: null,
  unavailableMessage: null,
  recordingDurationSec: 300,
  beatsDetected: 372,
  validBeats: 354,
  invalidBeats: 18,
  usableBeatPercentage: 95.16,
  meanRR: 806,
  minRR: 742,
  maxRR: 921,
  rrStandardDeviation: 31.2,
  rrCoefficientVariation: 3.85,
  meanHR: 74,
  minHR: 65,
  maxHR: 82,
  meanAbsRrDifference: 18.4,
  maxAbsRrDifference: 96,
  beatToBeatVariation: 'Low',
  rhythmRegularity: 'Regular',
  longRREventCount: 0,
  signalQuality: 'Good',
  patientSummary: 'Your heartbeat timing remained relatively consistent.',
  technicalSummary: 'RR: mean 806 ms ...',
  series: [{ offsetSec: 0.8, timestamp: session.startTime, rr: 800, hr: 75 }],
  analysedAt: new Date('2026-08-24T10:35:05.000Z'),
};

test('an available report exposes the full summary, rhythm and series blocks', () => {
  const response = toReportResponse(session, availableAnalysis, []);

  assert.equal(response.available, true);
  assert.equal(response.sessionId, 'sess_abc');
  assert.equal(response.recordingDurationSec, 300);

  assert.equal(response.summary.meanHR, 74);
  assert.equal(response.summary.rrCVPercent ?? response.summary.rrCVPercent, 3.85);
  assert.equal(response.summary.usablePercentage, 95.16);

  assert.equal(response.rhythm.regularity, 'Regular');
  assert.equal(response.rhythm.beatToBeatVariation, 'Low');
  assert.equal(response.rhythm.longRREvents, 0);

  assert.equal(response.signalQuality.status, 'Good');
  assert.equal(response.signalQuality.beatsDetected, 372);
  assert.equal(response.signalQuality.validBeats, 354);
  assert.equal(response.signalQuality.invalidBeats, 18);

  assert.equal(response.series.length, 1);
  assert.deepEqual(response.series[0], {
    offsetSec: 0.8,
    timestamp: session.startTime,
    rr: 800,
    hr: 75,
  });
});

test('an unavailable report omits statistics entirely instead of sending zeroes', () => {
  const response = toReportResponse(
    session,
    {
      available: false,
      unavailableReason: 'insufficient_data',
      unavailableMessage: 'Not enough valid ECG data to generate this report.',
      recordingDurationSec: null,
      beatsDetected: 4,
      validBeats: 3,
      invalidBeats: 1,
      usableBeatPercentage: 75,
      signalQuality: 'Fair',
      // The statistical columns are null in the stored document.
      meanRR: null,
      meanHR: null,
      rhythmRegularity: 'Unavailable',
      beatToBeatVariation: 'Unavailable',
      series: [],
    },
    []
  );

  assert.equal(response.available, false);
  assert.equal(response.unavailableReason, 'insufficient_data');
  assert.match(response.unavailableMessage, /Not enough valid ECG data/);

  // Nothing numeric that the UI could render as a real measurement.
  assert.equal(response.summary, null);
  assert.equal(response.rhythm, null);
  assert.equal(response.patientSummary, null);
  assert.equal(response.technicalSummary, null);
  assert.deepEqual(response.series, []);

  // Beat accounting survives, because it is what explains the unavailability.
  assert.equal(response.signalQuality.beatsDetected, 4);
  assert.equal(response.signalQuality.usablePercentage, 75);
});

test('events are passed through with their timing, value and quality', () => {
  const response = toReportResponse(session, availableAnalysis, [
    {
      timestamp: '2026-08-24T10:32:15.000Z',
      rPeakTimestamp: 135000,
      eventType: 'possible_long_rr',
      durationMs: 2250,
      rrValue: 2250,
      quality: 'long_rr_candidate',
      description: 'Possible prolonged RR interval detected; signal-quality review recommended.',
    },
  ]);

  assert.equal(response.events.length, 1);
  assert.equal(response.events[0].eventType, 'possible_long_rr');
  assert.equal(response.events[0].rrValue, 2250);
  assert.equal(response.events[0].quality, 'long_rr_candidate');
});

test('events are still returned when the report itself is unavailable', () => {
  const response = toReportResponse(
    session,
    { available: false, unavailableReason: 'no_data', signalQuality: 'Unavailable', series: [] },
    [{ eventType: 'signal_quality_drop', durationMs: 120, quality: 'invalid' }]
  );

  assert.equal(response.available, false);
  assert.equal(response.events.length, 1);
});
