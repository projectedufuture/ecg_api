const crypto = require('crypto');
const { validationResult } = require('express-validator');
const Session = require('../../models/Session');
const Device = require('../../models/Device');
const Reading = require('../../models/Reading');
const User = require('../../models/User');

function makeSessionId() {
  return `sess_${crypto.randomBytes(8).toString('hex')}`;
}

async function createSession(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, data: null, error: errors.array()[0].msg });
  }

  const { deviceId, startTime, name, location } = req.body;

  try {
    const device = await Device.findOne({ id: deviceId, userId: req.user.userId });
    if (!device) {
      return res
        .status(403)
        .json({ success: false, data: null, error: 'Device not paired to this user.' });
    }

    const user = await User.findOne({ id: req.user.userId });
    if (!user) {
      return res.status(404).json({ success: false, data: null, error: 'User not found.' });
    }

    const start = startTime ? new Date(startTime).toISOString() : new Date().toISOString();

    // Accept an optional location captured at session start. Falls back to the
    // user's last known location so admins always see something on the map.
    let sessionLocation = null;
    if (location && Number.isFinite(Number(location.lat)) && Number.isFinite(Number(location.lng))) {
      sessionLocation = {
        lat: Number(location.lat),
        lng: Number(location.lng),
        accuracy: location.accuracy != null ? Number(location.accuracy) : null,
        address: location.address || null,
      };
      // Also update the user's "current" location since this is fresher.
      user.lastLocation = { ...sessionLocation, capturedAt: new Date() };
      await user.save();
    } else if (user.lastLocation && user.lastLocation.lat != null && user.lastLocation.lng != null) {
      sessionLocation = {
        lat: user.lastLocation.lat,
        lng: user.lastLocation.lng,
        accuracy: user.lastLocation.accuracy,
        address: user.lastLocation.address,
      };
    }

    const session = await Session.create({
      id: makeSessionId(),
      userId: user.id,
      userEmail: user.email,
      userName: user.name,
      deviceId: device.id,
      startTime: start,
      endTime: start,
      duration: 0,
      dataPoints: 0,
      dataSource: 'live',
      avgTemp: '0',
      avgHR: 0,
      minHR: 0,
      maxHR: 0,
      clientId: user.clientId || 'CLIENT-001',
      location: sessionLocation,
    });

    return res.status(201).json({
      success: true,
      data: { ...session.toFrontend(), name: name || null },
      error: null,
    });
  } catch (error) {
    console.error('Create session error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

async function stopSession(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, data: null, error: errors.array()[0].msg });
  }

  const { sessionId } = req.params;
  const { endTime, duration, bpmAvg, bpmPeak, bpmMin, avgTemp } = req.body;

  try {
    const session = await Session.findOne({ id: sessionId, userId: req.user.userId });
    if (!session) {
      return res.status(404).json({ success: false, data: null, error: 'Session not found.' });
    }

    const end = endTime ? new Date(endTime).toISOString() : new Date().toISOString();
    session.endTime = end;
    if (typeof duration === 'number') session.duration = duration;
    if (typeof bpmAvg === 'number') session.avgHR = bpmAvg;
    if (typeof bpmPeak === 'number') session.maxHR = bpmPeak;
    if (typeof bpmMin === 'number') session.minHR = bpmMin;
    if (avgTemp !== undefined) session.avgTemp = String(avgTemp);

    const dataPoints = await Reading.countDocuments({ sessionId, userId: req.user.userId });
    session.dataPoints = dataPoints;

    await session.save();

    await User.findOneAndUpdate(
      { id: req.user.userId },
      { $inc: { sessions: 1 }, $set: { lastActive: new Date().toISOString() } }
    );

    return res.json({ success: true, data: session.toFrontend(), error: null });
  } catch (error) {
    console.error('Stop session error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

async function listSessions(req, res) {
  try {
    const { page = 1, limit = 20, from, to } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));

    const filter = { userId: req.user.userId };
    if (from || to) {
      filter.startTime = {};
      if (from) filter.startTime.$gte = new Date(from).toISOString();
      if (to) filter.startTime.$lte = new Date(to).toISOString();
    }

    const total = await Session.countDocuments(filter);
    const sessions = await Session.find(filter)
      .sort({ startTime: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean();

    return res.json({
      success: true,
      data: sessions.map((s) => ({
        id: s.id,
        deviceId: s.deviceId,
        startTime: s.startTime,
        endTime: s.endTime,
        duration: s.duration,
        dataPoints: s.dataPoints,
        avgHR: s.avgHR,
        minHR: s.minHR,
        maxHR: s.maxHR,
        avgTemp: s.avgTemp,
      })),
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
      error: null,
    });
  } catch (error) {
    console.error('List sessions error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

async function getSession(req, res) {
  try {
    const { sessionId } = req.params;
    const session = await Session.findOne({ id: sessionId, userId: req.user.userId }).lean();
    if (!session) {
      return res.status(404).json({ success: false, data: null, error: 'Session not found.' });
    }

    const { includeReadings } = req.query;
    let readings = [];
    if (includeReadings === 'true') {
      readings = await Reading.find({ sessionId, userId: req.user.userId })
        .sort({ timestamp: 1 })
        .lean();
    }

    return res.json({
      success: true,
      data: {
        id: session.id,
        deviceId: session.deviceId,
        startTime: session.startTime,
        endTime: session.endTime,
        duration: session.duration,
        dataPoints: session.dataPoints,
        avgHR: session.avgHR,
        minHR: session.minHR,
        maxHR: session.maxHR,
        avgTemp: session.avgTemp,
        readings: readings.map((r) => ({
          timestamp: r.timestamp,
          ecgValue: r.ecgValue,
          temperature: r.temperatureCelsius,
        })),
      },
      error: null,
    });
  } catch (error) {
    console.error('Get session error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

async function deleteSession(req, res) {
  try {
    const { sessionId } = req.params;
    const session = await Session.findOneAndDelete({ id: sessionId, userId: req.user.userId });
    if (!session) {
      return res.status(404).json({ success: false, data: null, error: 'Session not found.' });
    }

    await Reading.deleteMany({ sessionId, userId: req.user.userId });

    return res.json({ success: true, data: null, error: null });
  } catch (error) {
    console.error('Delete session error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

module.exports = { createSession, stopSession, listSessions, getSession, deleteSession };
