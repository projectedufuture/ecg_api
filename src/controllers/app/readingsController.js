const crypto = require('crypto');
const { validationResult } = require('express-validator');
const Reading = require('../../models/Reading');
const Session = require('../../models/Session');
const Device = require('../../models/Device');

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

    const docs = readings.map((r) => ({
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
    }));

    await Reading.insertMany(docs, { ordered: false });

    session.dataPoints = (session.dataPoints || 0) + docs.length;
    await session.save();

    device.lastSeen = new Date().toISOString();
    await device.save();

    return res.status(201).json({
      success: true,
      data: { inserted: docs.length, sessionId, totalDataPoints: session.dataPoints },
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
