/**
 * Unit tests for the device beat / R-peak field normalisation used by both
 * ingest paths (POST /api/app/readings and POST /api/app/sync).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeBeatFields } = require('../src/utils/rPeakIngest');

test('a reading with no beat fields is not a beat', () => {
  // Everything the firmware did not report stays null - never 0, never false
  // where false would mean "the device said no".
  assert.deepEqual(normalizeBeatFields({ ecgValue: 512 }), {
    beat: false,
    rPeakTimestamp: null,
    beatConfidence: null,
    leadOff: false,
    rrIntervalMs: null,
    ecgQuality: null,
    ppgIr: null,
    ppgRed: null,
    seq: null,
    ecgRaw: null,
    ecgFiltered: null,
    beatValid: null,
    rrValid: null,
    hrEcgValid: null,
    pqrstValid: null,
    hrInstant: null,
    hrAvg: null,
    rejectReason: null,
  });
});

test('an unreported validity flag is null, not false', () => {
  // "the device rejected this beat" and "the device did not say" must never be
  // stored as the same value.
  const absent = normalizeBeatFields({ ecgValue: 512 });
  assert.equal(absent.beatValid, null);
  assert.equal(absent.pqrstValid, null);

  const rejected = normalizeBeatFields({ ecgValue: 512, BEAT_VALID: 0, PQRST_VALID: 0 });
  assert.equal(rejected.beatValid, false);
  assert.equal(rejected.pqrstValid, false);

  const accepted = normalizeBeatFields({ ecgValue: 512, BEAT_VALID: 1, PQRST_VALID: 1 });
  assert.equal(accepted.beatValid, true);
  assert.equal(accepted.pqrstValid, true);
});

test('the documented JSON payload is accepted', () => {
  const result = normalizeBeatFields({ beat: true, rPeakTimestamp: 125430 });

  assert.equal(result.beat, true);
  assert.equal(result.rPeakTimestamp, 125430);
});

test('the raw device field names are accepted', () => {
  // BEAT:1 / R_TIME:125430 forwarded with minimal translation.
  const result = normalizeBeatFields({ BEAT: 1, R_TIME: 125430, LEAD_OFF: 0 });

  assert.equal(result.beat, true);
  assert.equal(result.rPeakTimestamp, 125430);
  assert.equal(result.leadOff, false);
});

test('firmware truthy forms are coerced consistently', () => {
  assert.equal(normalizeBeatFields({ beat: 1 }).beat, true);
  assert.equal(normalizeBeatFields({ beat: '1' }).beat, true);
  assert.equal(normalizeBeatFields({ beat: 'true' }).beat, true);
  assert.equal(normalizeBeatFields({ beat: 0 }).beat, false);
  assert.equal(normalizeBeatFields({ beat: '0' }).beat, false);
  assert.equal(normalizeBeatFields({ beat: false }).beat, false);
});

test('an R-peak time implies a beat even when the flag is missing', () => {
  assert.equal(normalizeBeatFields({ rPeakTimestamp: 900 }).beat, true);
});

test('an invalid R-peak time is discarded rather than stored as NaN', () => {
  assert.equal(normalizeBeatFields({ beat: true, rPeakTimestamp: 'abc' }).rPeakTimestamp, null);
  assert.equal(normalizeBeatFields({ beat: true, rPeakTimestamp: -5 }).rPeakTimestamp, null);
  assert.equal(normalizeBeatFields({ beat: true, rPeakTimestamp: null }).rPeakTimestamp, null);
  // The beat flag itself still stands, so the pipeline falls back to the
  // reading's ISO timestamp.
  assert.equal(normalizeBeatFields({ beat: true, rPeakTimestamp: 'abc' }).beat, true);
});

test('confidence outside 0..1 is discarded rather than clamped', () => {
  assert.equal(normalizeBeatFields({ beat: true, beatConfidence: 0.94 }).beatConfidence, 0.94);
  assert.equal(normalizeBeatFields({ beat: true, beatConfidence: 94 }).beatConfidence, null);
  assert.equal(normalizeBeatFields({ beat: true, beatConfidence: -1 }).beatConfidence, null);
});

test('leadOn is inverted into the canonical leadOff form', () => {
  assert.equal(normalizeBeatFields({ beat: true, leadOn: true }).leadOff, false);
  assert.equal(normalizeBeatFields({ beat: true, leadOn: false }).leadOff, true);
  // An explicit leadOff always wins over the inverted form.
  assert.equal(normalizeBeatFields({ beat: true, leadOff: true, leadOn: true }).leadOff, true);
});

// ── Raw device frame parsing ────────────────────────────────────────
// These use the exact frames captured from the device, so a firmware format
// change breaks a test rather than silently dropping data in production.

const { parseDeviceFrame } = require('../src/utils/rPeakIngest');

test('the real device frame parses to the canonical reading fields', () => {
  const r = parseDeviceFrame('ECG:1343,HR:0,TEMP:30.84,LEAD:1,BEAT:0,SPO2:0,RR:521,QUALITY:1');
  assert.equal(r.ecgValue, 1343);
  assert.equal(r.temperature, 30.84);
  assert.equal(r.ecgQuality, 1);
  assert.equal(r.leadOff, false, 'LEAD:1 is read as electrode connected');
  assert.equal(r.beat, false, 'BEAT:0 is not a beat');
  assert.equal(r.rPeakTimestamp, null);
});

test('a log line with its timestamp and RX prefix still parses', () => {
  const r = parseDeviceFrame(
    '[15:50:31.460] RX: ECG:1343,HR:0,TEMP:30.84,LEAD:1,BEAT:0,SPO2:0,RR:521,QUALITY:1'
  );
  assert.equal(r.ecgValue, 1343);
  assert.equal(r.temperature, 30.84);
});

test('a negative ECG sample keeps its sign', () => {
  // The device swings well below zero; a non-negative coercion would destroy
  // half of every waveform.
  assert.equal(parseDeviceFrame('ECG:-9025,HR:0,TEMP:30.84,LEAD:1,BEAT:0').ecgValue, -9025);
  assert.equal(parseDeviceFrame('ECG:-6977,LEAD:1').ecgValue, -6977);
});

test('BEAT:0 with a repeated RR does not become a beat', () => {
  // The device repeats its last known RR on every packet. Ten identical
  // frames must produce zero beats, not ten 521 ms intervals.
  const frames = Array.from({ length: 10 }, () =>
    parseDeviceFrame('ECG:100,HR:0,TEMP:30.84,LEAD:1,BEAT:0,SPO2:0,RR:521,QUALITY:1')
  );
  assert.equal(frames.filter((f) => f.beat).length, 0);
  // The RR value is still retained for cross-checking, just not as an interval.
  assert.equal(frames[0].rrIntervalMs, 521);
});

test('BEAT:1 in a frame is a beat', () => {
  const r = parseDeviceFrame('ECG:512,HR:74,TEMP:33.4,LEAD:1,BEAT:1,SPO2:98,RR:812,QUALITY:1');
  assert.equal(r.beat, true);
  assert.equal(r.hr, 74);
  assert.equal(r.spo2, 98);
});

test('R_TIME in a frame marks a beat and is kept as the R-peak clock', () => {
  const r = parseDeviceFrame('ECG:512,HR:74,BEAT:0,R_TIME:125430,LEAD:1');
  assert.equal(r.rPeakTimestamp, 125430);
  assert.equal(r.beat, true, 'a precise R-peak timestamp is itself a beat');
});

test('HR:0 and SPO2:0 stay 0 in the frame result, for the schema to store', () => {
  // The 0 = not-measured convention is unwound at the analysis boundary, not
  // here, so the stored row keeps matching the existing schema defaults.
  const r = parseDeviceFrame('ECG:100,HR:0,SPO2:0,RR:-1,LEAD:1');
  assert.equal(r.hr, 0);
  assert.equal(r.spo2, 0);
  assert.equal(r.rrIntervalMs, null, 'RR:-1 is not a measurement');
});

test('raw PPG is picked up when the firmware sends it', () => {
  const r = parseDeviceFrame('ECG:100,IR:123456,RED:112345,LEAD:1');
  assert.equal(r.ppgIr, 123456);
  assert.equal(r.ppgRed, 112345);
});

test('unknown fields are ignored rather than breaking the frame', () => {
  const r = parseDeviceFrame('ECG:88,HR:70,SOMETHING_NEW:42,BEAT:0,LEAD:1');
  assert.equal(r.ecgValue, 88);
  assert.equal(r.hr, 70);
});

test('lower-case keys parse the same as upper-case', () => {
  const r = parseDeviceFrame('ecg:77,hr:60,temp:31.2,beat:1,lead:1');
  assert.equal(r.ecgValue, 77);
  assert.equal(r.hr, 60);
  assert.equal(r.temperature, 31.2);
  assert.equal(r.beat, true);
});

test('a frame with no usable ECG sample is rejected, not stored as zero', () => {
  assert.equal(parseDeviceFrame('HR:70,BEAT:1,LEAD:1'), null);
  assert.equal(parseDeviceFrame('ECG:,HR:70'), null);
  assert.equal(parseDeviceFrame('ECG:abc,HR:70'), null);
  assert.equal(parseDeviceFrame('no colons here'), null);
  assert.equal(parseDeviceFrame(''), null);
  assert.equal(parseDeviceFrame('   '), null);
  assert.equal(parseDeviceFrame(null), null);
  assert.equal(parseDeviceFrame(undefined), null);
  assert.equal(parseDeviceFrame(42), null);
});

test('ECG:0 is a real sample and must not be rejected as falsy', () => {
  const r = parseDeviceFrame('ECG:0,HR:0,LEAD:1');
  assert.notEqual(r, null);
  assert.equal(r.ecgValue, 0);
});
