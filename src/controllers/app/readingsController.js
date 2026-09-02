const crypto = require('crypto');
const { validationResult } = require('express-validator');
const Reading = require('../../models/Reading');
const Session = require('../../models/Session');
const Device = require('../../models/Device');
const { normalizeBeatFields, expandDeviceFrame } = require('../../utils/rPeakIngest');
const { invalidateSessionAnalysis } = require('../../services/ecgRrService');

const MAX_BATCH = 5000;
// A batched frame becomes one row per ECG sample, so the posted array size is
// not the number of rows written. This caps the expanded total.
const MAX_EXPANDED = 60000;

function readingId() {
  return `rdg_${crypto.randomBytes(8).toString('hex')}`;
}

async function uploadReadings(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, data: null, error: errors.array()[0].msg });
  }

  const { sessionId, deviceId, readings } = req.body;

  if (!Array.isArray(readings) || readings.length === 0) {
    return res
      .status(400)
      .json({ success: false, data: null, error: 'readings must be a non-empty array.' });
  }

  if (readings.length > MAX_BATCH) {
    return res.status(413).json({
      success: false,
      data: null,
      error: `Batch size exceeds maximum of ${MAX_BATCH} readings.`,
    });
  }

  try {
    const session = await Session.findOne({ id: sessionId, userId: req.user.userId });
    if (!session) {
      return res.status(404).json({ success: false, data: null, error: 'Session not found.' });
    }

    const device = await Device.findOne({ id: deviceId, userId: req.user.userId });
    if (!device) {
      return res
        .status(403)
        .json({ success: false, data: null, error: 'Device not paired to this user.' });
    }

    // A reading may arrive either as explicit JSON fields or as the raw device
    // frame ("ECG:1343,HR:0,TEMP:30.84,..."). Parsing the frame server-side
    // keeps one authoritative parser; explicit JSON fields still win, so an app
    // can send both and override anything it has already decoded.
    // A device frame may carry MANY ECG samples (N:5,SEQ_START:...,ECG_RAW:a,b,c,d,e),
    // so one posted reading can expand into N rows. Keeping only the first
    // sample - which a 1:1 mapping does - silently discards most of the
    // waveform, so the frame is expanded here instead.
    const rejectedFrames = [];
    let expandedFrames = 0;
    let framesWithCountMismatch = 0;
    const merged = [];

    for (let i = 0; i < readings.length; i += 1) {
      const r = readings[i];
      const raw = r.raw ?? r.frame;

      if (typeof raw !== 'string') {
        merged.push(r);
        continue;
      }

      const rows = expandDeviceFrame(raw, r.timestamp);
      if (!rows || !rows.length) {
        rejectedFrames.push(i);
        merged.push(r);
        continue;
      }

      if (rows.length > 1) expandedFrames += 1;
      if (rows.frameMeta && rows.frameMeta.countMismatch) framesWithCountMismatch += 1;

      for (const row of rows) {
        // Explicit fields posted alongside the frame still win, except the
        // timestamp: the frame's expansion computes a per-sample time from the
        // device's own rate, which is more precise than one time for all N.
        const out = { ...row };
        for (const [k, v] of Object.entries(r)) {
          if (v === undefined || k === 'raw' || k === 'frame') continue;
          if (k === 'timestamp' && rows.length > 1) continue;
          out[k] = v;
        }
        merged.push(out);
      }
    }

    // Expansion multiplies the row count, so the batch cap has to be re-checked
    // against what will actually be written, not what was posted.
    if (merged.length > MAX_EXPANDED) {
      return res.status(413).json({
        success: false,
        data: null,
        error:
          `This batch expands to ${merged.length} ECG samples, over the limit of ` +
          `${MAX_EXPANDED}. Send fewer frames per request.`,
      });
    }

    // A reading with no usable ECG sample is skipped, not stored as zero and
    // not allowed to fail the batch. Storing a fabricated 0 would put a sample
    // in the waveform that the sensor never produced.
    const skipped = [];
    const usable = merged.filter((r, i) => {
      const v = r && r.ecgValue;
      const ok = v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v));
      if (!ok) skipped.push(i);
      return ok;
    });

    if (!usable.length) {
      // Nothing at all was usable: that is a payload-shape problem worth
      // failing loudly, and the message names the keys that did arrive so the
      // client does not have to guess.
      const sample = merged[0] || {};
      const keys = Object.keys(readings[0] || {}).join(', ') || '(none)';
      return res.status(400).json({
        success: false,
        data: null,
        error:
          'No reading carried a usable ECG sample. Each reading needs a numeric ' +
          'ecgValue, or a raw device frame containing ECG / ECG_RAW / ECG_FILTERED. ' +
          `Received keys on readings[0]: ${keys}.` +
          (typeof readings[0]?.raw === 'string'
            ? ` raw frame began: "${String(readings[0].raw).slice(0, 80)}".`
            : '') +
          (sample.ecgValue === undefined ? '' : ` Parsed ecgValue was: ${sample.ecgValue}.`),
      });
    }

    const docs = usable.map((r) => ({
      id: readingId(),
      sessionId,
      userId: req.user.userId,
      deviceId,
      timestamp: new Date(r.timestamp).toISOString(),
      ecgValue: Number(r.ecgValue),
      temperatureCelsius:
        r.temperature !== undefined ? Number(r.temperature) : Number(r.temperatureCelsius ?? 0),
      hr: r.hr !== undefined ? Number(r.hr) : 0,
      spo2: r.spo2 !== undefined ? Number(r.spo2) : 0,
      clientId: session.clientId || 'CLIENT-001',
      ...normalizeBeatFields(r),
      // Carried through from the frame: the device's declared rate (which is
      // the chart's time base) and the gated PQRST for the frame's beat.
      sampleRateHz: r.sampleRateHz ?? null,
      ...(r.pqrst ? { pqrst: r.pqrst } : {}),
    }));

    await Reading.insertMany(docs, { ordered: false });

    session.dataPoints = (session.dataPoints || 0) + docs.length;
    await session.save();

    device.lastSeen = new Date().toISOString();
    await device.save();

    // New beats change the RR sequence, so any stored ECG/RR report for this
    // session is now stale. Dropping it is cheap; the next report request
    // recomputes from the full set of readings (PART 30).
    if (docs.some((d) => d.beat)) {
      await invalidateSessionAnalysis(sessionId);
    }

    return res.status(201).json({
      success: true,
      data: {
        inserted: docs.length,
        sessionId,
        totalDataPoints: session.dataPoints,
        // Report anything dropped explicitly rather than losing it quietly - a
        // firmware field rename should be visible, not silent.
        ...(rejectedFrames.length ? { unparsableFrames: rejectedFrames.length } : {}),
        ...(skipped.length
          ? { skippedReadings: skipped.length, skippedIndexes: skipped.slice(0, 20) }
          : {}),
        // Makes batching visible: N frames in, more rows out.
        ...(expandedFrames ? { expandedFrames, framesPosted: readings.length } : {}),
        ...(framesWithCountMismatch ? { framesWithCountMismatch } : {}),
      },
      error: null,
    });
  } catch (error) {
    console.error('Upload readings error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

async function listReadings(req, res) {
  try {
    const { sessionId } = req.query;
    if (!sessionId) {
      return res
        .status(400)
        .json({ success: false, data: null, error: 'sessionId query param is required.' });
    }

    const session = await Session.findOne({ id: sessionId, userId: req.user.userId }).lean();
    if (!session) {
      return res.status(404).json({ success: false, data: null, error: 'Session not found.' });
    }

    const limit = Math.min(10000, Math.max(1, parseInt(req.query.limit, 10) || 1000));

    const readings = await Reading.find({ sessionId, userId: req.user.userId })
      .sort({ timestamp: 1 })
      .limit(limit)
      .lean();

    return res.json({
      success: true,
      data: readings.map((r) => ({
        timestamp: r.timestamp,
        ecgValue: r.ecgValue,
        temperature: r.temperatureCelsius,
      })),
      error: null,
    });
  } catch (error) {
    console.error('List readings error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

module.exports = { uploadReadings, listReadings };
