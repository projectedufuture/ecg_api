const { validationResult } = require('express-validator');
const EcgBeatAnalysis = require('../../models/EcgBeatAnalysis');
const Session = require('../../models/Session');
const Device = require('../../models/Device');

/**
 * Upload of the APP's own beat-level ECG analysis.
 *
 * The app analyses its continuous ECG_FILTERED buffer and posts one entry per
 * detected beat. This endpoint only stores them - it does not re-analyse, and
 * it never reads the firmware's PQRST from Reading.pqrst.
 */

const MAX_BEATS = 5000;

/**
 * Shape one stored beat for an API response.
 *
 * Exported and used by BOTH session GET endpoints (app and admin) so the two
 * clients cannot be served different shapes of the same record. The PQRST
 * fields are flattened onto the beat because that is the shape the clients
 * asked for; the stored document keeps them nested.
 */
function toBeatResponse(beat) {
  const pqrst = beat.pqrst || {};
  return {
    rSampleIndex: beat.rSampleIndex,
    rSeq: beat.rSeq ?? null,
    pSampleIndex: beat.pSampleIndex ?? null,
    qSampleIndex: beat.qSampleIndex ?? null,
    sSampleIndex: beat.sSampleIndex ?? null,
    tSampleIndex: beat.tSampleIndex ?? null,
    timestamp: beat.timestamp ?? null,
    sampleRateHz: beat.sampleRateHz ?? null,

    p: pqrst.p ?? null,
    q: pqrst.q ?? null,
    r: pqrst.r ?? null,
    s: pqrst.s ?? null,
    t: pqrst.t ?? null,

    prMs: pqrst.prMs ?? null,
    qrsMs: pqrst.qrsMs ?? null,
    qtMs: pqrst.qtMs ?? null,
    qtcMs: pqrst.qtcMs ?? null,

    rrMs: beat.rrMs ?? null,

    pqrstValid: beat.pqrstValid ?? null,
    rrValid: beat.rrValid ?? null,
  };
}

/** Load every beat of a session, oldest first, ready for a response. */
async function loadSessionBeats(sessionId) {
  const beats = await EcgBeatAnalysis.find({ sessionId })
    .sort({ rSampleIndex: 1 })
    .lean();
  return beats.map(toBeatResponse);
}

/** Finite number or null. Accepts negatives: Q and S amplitudes are negative. */
function num(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Tri-state: null when the app did not report the flag at all. */
function triState(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === '1' || v === 'true') return true;
    if (v === '0' || v === 'false') return false;
  }
  return null;
}

/**
 * POST /api/app/ecg-beats
 *
 * Idempotent per beat: the write is an upsert keyed on
 * (sessionId, rSampleIndex), so a retry after a dropped response updates each
 * beat rather than doubling the recording.
 */
async function uploadEcgBeats(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, data: null, error: errors.array()[0].msg });
  }

  const { sessionId, deviceId, beats } = req.body;

  if (beats.length > MAX_BEATS) {
    return res.status(413).json({
      success: false,
      data: null,
      error: `Batch size exceeds maximum of ${MAX_BEATS} beats.`,
    });
  }

  try {
    // Scoped to the caller: a user may only add beats to their OWN session.
    const session = await Session.findOne({ id: sessionId, userId: req.user.userId }).lean();
    if (!session) {
      return res.status(404).json({ success: false, data: null, error: 'Session not found.' });
    }

    const device = await Device.findOne({ id: deviceId, userId: req.user.userId }).lean();
    if (!device) {
      return res
        .status(403)
        .json({ success: false, data: null, error: 'Device not paired to this user.' });
    }

    const skipped = [];
    const ops = [];

    beats.forEach((b, i) => {
      const rSampleIndex = num(b.rSampleIndex);
      // Without an R-peak index the beat has no identity, so it cannot be
      // stored idempotently and is reported rather than written.
      if (rSampleIndex === null) {
        skipped.push(i);
        return;
      }

      const pqrstValid = triState(b.pqrstValid);
      const rrValid = triState(b.rrValid);

      // An invalid beat is stored as a beat with nulls, NOT dropped and NOT
      // filled in. The app detected something there; what it could not measure
      // stays unmeasured, and the record still marks the beat's existence.
      const pqrst =
        pqrstValid === true
          ? {
              p: num(b.p),
              q: num(b.q),
              r: num(b.r),
              s: num(b.s),
              t: num(b.t),
              prMs: num(b.prMs),
              qrsMs: num(b.qrsMs),
              qtMs: num(b.qtMs),
              qtcMs: num(b.qtcMs),
            }
          : {
              p: null,
              q: null,
              r: null,
              s: null,
              t: null,
              prMs: null,
              qrsMs: null,
              qtMs: null,
              qtcMs: null,
            };

      ops.push({
        updateOne: {
          filter: { sessionId, rSampleIndex },
          update: {
            $set: {
              sessionId,
              userId: req.user.userId,
              deviceId,
              clientId: session.clientId || 'CLIENT-001',
              rSampleIndex,
              rSeq: num(b.rSeq),
              // Landmark positions, stored beside the amplitudes they belong
              // to so a replay never has to re-derive them.
              pSampleIndex: num(b.pSampleIndex),
              qSampleIndex: num(b.qSampleIndex),
              sSampleIndex: num(b.sSampleIndex),
              tSampleIndex: num(b.tSampleIndex),
              timestamp: b.timestamp || null,
              sampleRateHz: num(b.sampleRateHz),
              pqrst,
              rrMs: rrValid === true ? num(b.rrMs) : null,
              pqrstValid,
              rrValid,
            },
          },
          upsert: true,
        },
      });
    });

    let inserted = 0;
    let updated = 0;
    if (ops.length) {
      const result = await EcgBeatAnalysis.bulkWrite(ops, { ordered: false });
      inserted = result.upsertedCount || 0;
      updated = result.modifiedCount || 0;
    }

    const totalBeats = await EcgBeatAnalysis.countDocuments({ sessionId });

    return res.status(201).json({
      success: true,
      data: {
        sessionId,
        received: beats.length,
        inserted,
        // A re-upload lands here rather than in `inserted`, which is what makes
        // the duplicate protection visible to the client.
        updated,
        totalBeats,
        ...(skipped.length
          ? { skippedBeats: skipped.length, skippedIndexes: skipped.slice(0, 20) }
          : {}),
      },
      error: null,
    });
  } catch (error) {
    console.error('Upload ECG beats error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

module.exports = {
  uploadEcgBeats,
  toBeatResponse,
  loadSessionBeats,
  MAX_BEATS,
};
