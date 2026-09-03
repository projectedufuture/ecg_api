/**
 * App-generated beat-level ECG analysis.
 *
 * These cover the pure parts: the response mapper, the validity gating, and
 * the schema contract. The upsert-idempotency and the two session GET
 * endpoints need a live database, so they are exercised by the integration
 * driver rather than here.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const EcgBeatAnalysis = require('../src/models/EcgBeatAnalysis');
const { toBeatResponse } = require('../src/controllers/app/ecgBeatsController');
const Reading = require('../src/models/Reading');

const storedBeat = (over = {}) => ({
  sessionId: 'ses_ab12',
  userId: 'USR-1',
  deviceId: 'ECG-7A3F',
  rSampleIndex: 2818,
  rSeq: 2818,
  timestamp: '2026-09-02T10:00:00.000Z',
  sampleRateHz: 128,
  pqrst: {
    p: 817,
    q: 1148,
    r: 2818,
    s: 987,
    t: 7980,
    prMs: 61,
    qrsMs: 87,
    qtMs: 156,
    qtcMs: 168,
  },
  rrMs: 859,
  pqrstValid: true,
  rrValid: true,
  ...over,
});

// ── schema ────────────────────────────────────────────────────────────

test('every PQRST component is its own numeric field', () => {
  for (const f of ['p', 'q', 'r', 's', 't', 'prMs', 'qrsMs', 'qtMs', 'qtcMs']) {
    const path = EcgBeatAnalysis.schema.path(`pqrst.${f}`);
    assert.ok(path, `pqrst.${f} is not a schema path`);
    assert.equal(path.instance, 'Number');
    assert.equal(path.defaultValue, null, `pqrst.${f} should default to null`);
  }
});

test('beat identity and the validity flags are their own fields', () => {
  assert.equal(EcgBeatAnalysis.schema.path('rSampleIndex').instance, 'Number');
  assert.equal(EcgBeatAnalysis.schema.path('rSampleIndex').isRequired, true);
  assert.equal(EcgBeatAnalysis.schema.path('rSeq').instance, 'Number');
  assert.equal(EcgBeatAnalysis.schema.path('sampleRateHz').instance, 'Number');
  assert.equal(EcgBeatAnalysis.schema.path('rrMs').instance, 'Number');
  assert.equal(EcgBeatAnalysis.schema.path('pqrstValid').instance, 'Boolean');
  assert.equal(EcgBeatAnalysis.schema.path('rrValid').instance, 'Boolean');
});

test('sessionId + rSampleIndex is a UNIQUE index', () => {
  // This is what makes a re-upload update a beat instead of duplicating it.
  const idx = EcgBeatAnalysis.schema.indexes();
  const unique = idx.find(
    ([fields, opts]) =>
      fields.sessionId === 1 && fields.rSampleIndex === 1 && opts && opts.unique === true
  );
  assert.ok(unique, 'no unique index on { sessionId, rSampleIndex }');
});

test('the flags are tri-state, so "not reported" differs from "invalid"', () => {
  assert.equal(EcgBeatAnalysis.schema.path('pqrstValid').defaultValue, null);
  assert.equal(EcgBeatAnalysis.schema.path('rrValid').defaultValue, null);
});

test('NO heart-rate field exists on the beat analysis', () => {
  // Heart rate stays on Reading.hr, from the MAX30102. A second HR here would
  // create two numbers for one quantity with no rule for which wins.
  for (const f of ['hr', 'heartRate', 'heartRateBpm', 'ecgHeartRateBpm', 'bpm']) {
    assert.equal(EcgBeatAnalysis.schema.path(f), undefined, `${f} must not exist`);
  }
});

test('the firmware PQRST on Reading is left in place, separate from this model', () => {
  // Two analysers, two records. Reading.pqrst is the firmware's per-sample
  // result; EcgBeatAnalysis.pqrst is the app's per-beat result.
  assert.ok(Reading.schema.path('pqrst.qrsMs'), 'Reading.pqrst must still exist');
  assert.ok(Reading.schema.path('hr'), 'Reading.hr (MAX30102) must still exist');
  assert.equal(Reading.schema.path('hr').instance, 'Number');
});

// ── response mapping ──────────────────────────────────────────────────

test('a beat is returned with PQRST flattened onto it', () => {
  const r = toBeatResponse(storedBeat());
  assert.deepEqual(r, {
    rSampleIndex: 2818,
    rSeq: 2818,
    timestamp: '2026-09-02T10:00:00.000Z',
    sampleRateHz: 128,
    p: 817,
    q: 1148,
    r: 2818,
    s: 987,
    t: 7980,
    prMs: 61,
    qrsMs: 87,
    qtMs: 156,
    qtcMs: 168,
    rrMs: 859,
    pqrstValid: true,
    rrValid: true,
  });
});

test('the response carries no heart rate', () => {
  const r = toBeatResponse(storedBeat());
  for (const f of ['hr', 'heartRate', 'heartRateBpm', 'ecgHeartRateBpm', 'bpm']) {
    assert.equal(r[f], undefined, `${f} must not be in the response`);
  }
});

test('an invalid beat returns nulls, never fabricated values', () => {
  const r = toBeatResponse(
    storedBeat({
      pqrst: {
        p: null,
        q: null,
        r: null,
        s: null,
        t: null,
        prMs: null,
        qrsMs: null,
        qtMs: null,
        qtcMs: null,
      },
      rrMs: null,
      pqrstValid: false,
      rrValid: false,
    })
  );
  for (const f of ['p', 'q', 'r', 's', 't', 'prMs', 'qrsMs', 'qtMs', 'qtcMs', 'rrMs']) {
    assert.equal(r[f], null, `${f} should be null on an invalid beat`);
  }
  assert.equal(r.pqrstValid, false);
  assert.equal(r.rrValid, false);
  // The beat itself is still reported: the app detected something there.
  assert.equal(r.rSampleIndex, 2818);
});

test('a beat with valid PQRST but invalid RR keeps its morphology', () => {
  // The two verdicts are independent - the first beat of a recording has no
  // predecessor and therefore no RR, but its complex is perfectly measurable.
  const r = toBeatResponse(storedBeat({ rrMs: null, rrValid: false }));
  assert.equal(r.qrsMs, 87);
  assert.equal(r.p, 817);
  assert.equal(r.rrMs, null);
  assert.equal(r.rrValid, false);
  assert.equal(r.pqrstValid, true);
});

test('a missing pqrst subdocument maps to nulls rather than throwing', () => {
  const r = toBeatResponse({ rSampleIndex: 5, rrMs: 800 });
  assert.equal(r.p, null);
  assert.equal(r.qrsMs, null);
  assert.equal(r.rSampleIndex, 5);
  assert.equal(r.rrMs, 800);
  assert.equal(r.rSeq, null);
});

test('a negative amplitude survives the mapping', () => {
  // Q and S are normally negative; coercing them to 0 or dropping them would
  // lose real morphology.
  const r = toBeatResponse(storedBeat({ pqrst: { ...storedBeat().pqrst, q: -40, s: -150 } }));
  assert.equal(r.q, -40);
  assert.equal(r.s, -150);
});
