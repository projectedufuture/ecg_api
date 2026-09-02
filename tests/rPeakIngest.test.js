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

// ── Batched frame expansion ─────────────────────────────────────────
// The current firmware sends N ECG samples per frame. These tests exist
// because a parser that splits the frame on commas first keeps only the
// FIRST sample and drops the rest silently - no error, most of the ECG gone.

const { expandDeviceFrame } = require('../src/utils/rPeakIngest');

const BATCHED =
  'N:5,RATE_HZ:128,SEQ_START:10240,ECG_FILTERED:1342,1351,1349,1338,1330,' +
  'HR:72,TEMP:36.75,LEAD:1,BEAT:1,SPO2:98,RR:832,QUALITY:1,' +
  'PQRST_VALID:1,P:120,Q:-40,R:980,S:-150,T:210,PR:156,QRS:94,QT:356,QTC:390';

test('EVERY sample of a batched frame is preserved', () => {
  const rows = expandDeviceFrame(BATCHED, '2026-09-02T10:00:00.000Z');
  assert.equal(rows.length, 5, 'one row per ECG sample');
  assert.deepEqual(
    rows.map((r) => r.ecgFiltered),
    [1342, 1351, 1349, 1338, 1330],
    'all five samples, in order'
  );
});

test('each sample gets its own SEQ, counted from SEQ_START', () => {
  // Per-sample SEQ is what makes a transmission gap detectable per sample
  // rather than only per frame.
  const rows = expandDeviceFrame(BATCHED, '2026-09-02T10:00:00.000Z');
  assert.deepEqual(rows.map((r) => r.seq), [10240, 10241, 10242, 10243, 10244]);
});

test('per-sample timestamps come from the declared rate', () => {
  const rows = expandDeviceFrame(BATCHED, '2026-09-02T10:00:00.000Z');
  const ms = rows.map((r) => Date.parse(r.timestamp) - Date.parse('2026-09-02T10:00:00.000Z'));
  // 128 Hz is 7.8125 ms per sample, rounded to whole ms.
  assert.deepEqual(ms, [0, 8, 16, 23, 31]);
  assert.equal(rows[0].sampleRateHz, 128, 'the rate travels with every row');
});

test('with no declared rate, samples share the frame time rather than a guessed spread', () => {
  const rows = expandDeviceFrame('SEQ_START:9,ECG_RAW:5,6,7', '2026-09-02T10:00:00.000Z');
  const stamps = new Set(rows.map((r) => r.timestamp));
  assert.equal(stamps.size, 1, 'no interval is invented from an unknown rate');
});

test("the frame's single set of vitals is not multiplied across its samples", () => {
  // HR:72 describes the whole batch. Writing it to all five rows would turn
  // one measurement into five and bias every average that reads the column.
  const rows = expandDeviceFrame(BATCHED, '2026-09-02T10:00:00.000Z');
  assert.equal(rows.filter((r) => r.hr > 0).length, 1);
  assert.equal(rows.filter((r) => r.beat === true).length, 1);
  assert.equal(rows.filter((r) => r.spo2 > 0).length, 1);
});

test('PQRST is attached only when the device says it is valid', () => {
  const valid = expandDeviceFrame(BATCHED, '2026-09-02T10:00:00.000Z');
  assert.equal(valid[0].pqrst.qrsMs, 94);
  assert.equal(valid[0].pqrst.prMs, 156);

  // The firmware leaves the PREVIOUS beat's values in the frame when the flag
  // is 0, so an ungated copy would attribute a stale complex to this beat.
  const stale = expandDeviceFrame(
    'N:2,RATE_HZ:128,SEQ_START:1,ECG_RAW:10,11,PQRST_VALID:0,PR:156,QRS:94,QT:356',
    '2026-09-02T10:00:00.000Z'
  );
  assert.equal(stale[0].pqrst, null);
  assert.equal(stale[0].pqrstValid, false);
});

test('the sample block is found whichever separator the firmware uses', () => {
  for (const sep of [',', ' ', ';', '|']) {
    const rows = expandDeviceFrame(
      `N:3,RATE_HZ:128,SEQ_START:1,ECG_RAW:100${sep}101${sep}102,HR:70`,
      '2026-09-02T10:00:00.000Z'
    );
    assert.equal(rows.length, 3, `separator "${sep}" yielded ${rows.length} rows`);
    assert.deepEqual(rows.map((r) => r.ecgValue), [100, 101, 102]);
  }
});

test('N is a checksum, not a truncation rule', () => {
  // Discarding real decoded samples to satisfy a header would be worse than
  // the mismatch, so every sample is kept and the disagreement reported.
  const rows = expandDeviceFrame(
    'N:9,RATE_HZ:128,SEQ_START:1,ECG_RAW:1,2,3',
    '2026-09-02T10:00:00.000Z'
  );
  assert.equal(rows.length, 3);
  assert.equal(rows.frameMeta.countMismatch, true);
  assert.equal(rows.frameMeta.declaredCount, 9);
});

test('raw and filtered ECG are never conflated', () => {
  const filtered = expandDeviceFrame('ECG_FILTERED:1342,1351,RATE_HZ:128', '2026-09-02T10:00:00.000Z');
  assert.equal(filtered[0].ecgFiltered, 1342);
  assert.equal(filtered[0].ecgRaw, null);

  const raw = expandDeviceFrame('ECG_RAW:1342,1351,RATE_HZ:128', '2026-09-02T10:00:00.000Z');
  assert.equal(raw[0].ecgRaw, 1342);
  assert.equal(raw[0].ecgFiltered, null);
});

test('a legacy single-sample frame still yields exactly one row', () => {
  const rows = expandDeviceFrame(
    'ECG:1343,HR:0,TEMP:30.84,LEAD:1,BEAT:0,SPO2:0,RR:521,QUALITY:1',
    '2026-09-02T10:00:00.000Z'
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ecgValue, 1343);
  assert.equal(rows[0].temperature, 30.84);
});
