/**
 * The minimum-recording-length rule for report generation.
 *
 * A recording shorter than the configured minimum generates no reports at all.
 * These tests pin the measurement (which must come from the timestamps, not the
 * stored whole-minute duration) and the shape of the response the API returns.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  sessionDurationSec,
  isSessionTooShort,
  tooShortReportPayload,
  formatDurationShort,
  MIN_SESSION_DURATION_SEC,
} = require('../src/services/ecgRrService');

const session = (startTime, endTime, extra = {}) => ({
  id: 'sess_test',
  name: null,
  userId: 'USR-1',
  userName: 'Test Patient',
  deviceId: 'ECG-1',
  startTime,
  endTime,
  ...extra,
});

// --- the measurement -------------------------------------------------------

test('the default minimum is five minutes', () => {
  assert.equal(MIN_SESSION_DURATION_SEC, 300);
});

test('duration is measured from the timestamps', () => {
  assert.equal(
    sessionDurationSec(session('2026-01-01T00:00:00Z', '2026-01-01T00:05:00Z')),
    300
  );
  assert.equal(
    sessionDurationSec(session('2026-01-01T00:00:00Z', '2026-01-01T00:02:30Z')),
    150
  );
});

test('a recording that has not progressed has zero duration', () => {
  assert.equal(
    sessionDurationSec(session('2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')),
    0
  );
});

test('unusable timestamps give an unknown duration, not zero', () => {
  // Returning 0 here would make every unparsable session "too short" and hide
  // real recordings behind the rule.
  assert.equal(sessionDurationSec(session('nonsense', 'worse')), null);
  assert.equal(sessionDurationSec(null), null);
});

// --- the rule --------------------------------------------------------------

test('a recording shorter than five minutes is too short', () => {
  assert.equal(isSessionTooShort(session('2026-01-01T00:00:00Z', '2026-01-01T00:00:30Z')), true);
  assert.equal(isSessionTooShort(session('2026-01-01T00:00:00Z', '2026-01-01T00:02:30Z')), true);
  assert.equal(isSessionTooShort(session('2026-01-01T00:00:00Z', '2026-01-01T00:04:59Z')), true);
});

test('exactly five minutes is long enough', () => {
  assert.equal(isSessionTooShort(session('2026-01-01T00:00:00Z', '2026-01-01T00:05:00Z')), false);
});

test('longer recordings are long enough', () => {
  assert.equal(isSessionTooShort(session('2026-01-01T00:00:00Z', '2026-01-01T00:05:01Z')), false);
  assert.equal(isSessionTooShort(session('2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z')), false);
});

test('a 4m40s recording is still too short even though it rounds up to 5 minutes', () => {
  // Session.duration is stored in WHOLE MINUTES, so Math.round puts this at 5.
  // Gating on that field would let it through; gating on the timestamps does not.
  const s = session('2026-01-01T00:00:00Z', '2026-01-01T00:04:40Z', { duration: 5 });
  assert.equal(Math.round(280 / 60), 5, 'the stored duration really would round to 5');
  assert.equal(isSessionTooShort(s), true);
});

test('a recording of unknown length is not refused', () => {
  // Better to attempt generation and let the analysis gates decide than to
  // silently withhold reports because a timestamp could not be parsed.
  assert.equal(isSessionTooShort(session('nonsense', 'worse')), false);
});

// --- the response ----------------------------------------------------------

test('the too-short response explains the rule with both numbers', () => {
  const payload = tooShortReportPayload(
    session('2026-01-01T00:00:00Z', '2026-01-01T00:02:30Z')
  );
  assert.equal(payload.available, false);
  assert.equal(payload.reportStatus, 'too_short');
  assert.equal(payload.unavailableReason, 'session_too_short');
  assert.equal(payload.recordingDurationSec, 150);
  assert.equal(payload.minimumDurationSec, 300);
  assert.match(payload.message, /2m 30s/);
  assert.match(payload.message, /5m/);
});

test('the too-short response still identifies the session', () => {
  // The report page renders its header from these, so they must survive.
  const payload = tooShortReportPayload(
    session('2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z')
  );
  assert.equal(payload.sessionId, 'sess_test');
  assert.equal(payload.userName, 'Test Patient');
  assert.equal(payload.deviceId, 'ECG-1');
  assert.equal(payload.startTime, '2026-01-01T00:00:00Z');
});

test('the too-short response carries no diagnostic or measurement content', () => {
  const payload = tooShortReportPayload(
    session('2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z')
  );
  // Nothing was analysed, so nothing may be reported.
  assert.equal(payload.reportGeneratedAt, null);
  assert.equal(payload.reportError, null, 'a rule is not an error');
  assert.equal(payload.status, 'too_short');
});

// --- duration formatting ---------------------------------------------------

test('durations read naturally', () => {
  assert.equal(formatDurationShort(45), '45s');
  assert.equal(formatDurationShort(60), '1m');
  assert.equal(formatDurationShort(150), '2m 30s');
  assert.equal(formatDurationShort(300), '5m');
  assert.equal(formatDurationShort(0), '0s');
  assert.equal(formatDurationShort(null), 'unknown');
});
