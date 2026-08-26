const crypto = require('crypto');
const { validationResult } = require('express-validator');
const Reading = require('../../models/Reading');
const Session = require('../../models/Session');
const Device = require('../../models/Device');
const { normalizeBeatFields, parseDeviceFrame } = require('../../utils/rPeakIngest');
const { invalidateSessionAnalysis } = require('../../services/ecgRrService');

const MAX_BATCH = 5000;

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
    const rejectedFrames = [];
    const merged = readings.map((r, i) => {
      const raw = r.raw ?? r.frame;
      if (typeof raw !== 'string') return r;
      const parsed = parseDeviceFrame(raw);
      if (!parsed) {
        rejectedFrames.push(i);
        return r;
      }
      // Explicit fields take precedence over the parsed frame.
      const out = { ...parsed };
      for (const [k, v] of Object.entries(r)) {
        if (v !== undefined && k !== 'raw' && k !== 'frame') out[k] = v;
      }
      return out;
    });

    const docs = merged.map((r) => ({
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
        // Report unparsable frames explicitly rather than dropping them
        // quietly - a firmware field rename should be visible, not silent.
        ...(rejectedFrames.length ? { unparsableFrames: rejectedFrames.length } : {}),
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
