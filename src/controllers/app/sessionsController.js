const crypto = require('crypto');
const { validationResult } = require('express-validator');
const Session = require('../../models/Session');
const Device = require('../../models/Device');
const Reading = require('../../models/Reading');
const User = require('../../models/User');
const EcgRrAnalysis = require('../../models/EcgRrAnalysis');
const EcgRrEvent = require('../../models/EcgRrEvent');
const HrvAnalysis = require('../../models/HrvAnalysis');
const RhythmAnalysis = require('../../models/RhythmAnalysis');
const RhythmEvent = require('../../models/RhythmEvent');
const RespirationAnalysis = require('../../models/RespirationAnalysis');
const Spo2Analysis = require('../../models/Spo2Analysis');
const Spo2Event = require('../../models/Spo2Event');
const TemperatureAnalysis = require('../../models/TemperatureAnalysis');
const TemperatureEvent = require('../../models/TemperatureEvent');
const CombinedAnalysis = require('../../models/CombinedAnalysis');
const { queueSessionReports } = require('../../services/ecgRrService');
const { loadSessionBeats } = require('./ecgBeatsController');
const EcgBeatAnalysis = require('../../models/EcgBeatAnalysis');
const { attachCachedAddress, queueResolve } = require('../../services/locationService');

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
      // Cache-only address lookup; a miss is resolved in the background after
      // the response so starting a session never waits on a geocoding service.
      sessionLocation = await attachCachedAddress({
        lat: Number(location.lat),
        lng: Number(location.lng),
        accuracy: location.accuracy != null ? Number(location.accuracy) : null,
        address: location.address || null,
      });
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
      name: name || null,
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

    if (sessionLocation && !sessionLocation.address) {
      queueResolve({
        userId: user.id,
        sessionId: session.id,
        lat: sessionLocation.lat,
        lng: sessionLocation.lng,
      });
    }

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
  const { endTime, duration, bpmAvg, bpmPeak, bpmMin, avgTemp, spo2Avg, spo2Peak, spo2Min } =
    req.body;

  try {
    const session = await Session.findOne({ id: sessionId, userId: req.user.userId });
    if (!session) {
      return res.status(404).json({ success: false, data: null, error: 'Session not found.' });
    }

    // A client-supplied endTime that predates the start makes the recording
    // length unknowable - and an unknowable length cannot be measured against
    // the minimum-duration rule. Rather than store contradictory timestamps,
    // fall back to the server clock, which is at least monotonic with the
    // start we recorded ourselves.
    let end = endTime ? new Date(endTime).toISOString() : new Date().toISOString();
    if (Date.parse(end) < Date.parse(session.startTime)) {
      console.warn(
        `Session ${sessionId}: endTime ${end} precedes startTime ${session.startTime}; ` +
          'using the server clock instead.'
      );
      end = new Date().toISOString();
    }
    session.endTime = end;

    // Duration is authoritative from the timestamps (in whole minutes), so it can
    // never disagree with the displayed Start/End regardless of what the client sent.
    const elapsedMs = new Date(end).getTime() - new Date(session.startTime).getTime();
    session.duration = Math.max(0, Math.round(elapsedMs / 60000));

    // Compute HR / SpO2 / temperature summaries FROM the stored readings — the
    // backend is the source of truth, so the app never has to send avg/min/max.
    // 0-values (no-finger samples) are excluded from HR/SpO2 via the per-facet $match.
    const [agg] = await Reading.aggregate([
      { $match: { sessionId, userId: req.user.userId } },
      {
        $facet: {
          hr: [
            { $match: { hr: { $gt: 0 } } },
            { $group: { _id: null, avg: { $avg: '$hr' }, min: { $min: '$hr' }, max: { $max: '$hr' } } },
          ],
          spo2: [
            { $match: { spo2: { $gt: 0 } } },
            { $group: { _id: null, avg: { $avg: '$spo2' }, min: { $min: '$spo2' }, max: { $max: '$spo2' } } },
          ],
          // 0 = not-measured (sensor not yet reading / lost contact), same
          // convention as hr/spo2 above — must be excluded or it drags the
          // average down toward zero.
          temp: [
            { $match: { temperatureCelsius: { $gt: 0 } } },
            { $group: { _id: null, avg: { $avg: '$temperatureCelsius' } } },
          ],
          count: [{ $count: 'n' }],
        },
      },
    ]);

    const hr = agg?.hr?.[0];
    const spo2 = agg?.spo2?.[0];
    const temp = agg?.temp?.[0];

    // HR — from readings if present, else fall back to whatever the client sent.
    if (hr) {
      session.avgHR = Math.round(hr.avg);
      session.minHR = hr.min;
      session.maxHR = hr.max;
    } else {
      if (typeof bpmAvg === 'number') session.avgHR = bpmAvg;
      if (typeof bpmPeak === 'number') session.maxHR = bpmPeak;
      if (typeof bpmMin === 'number') session.minHR = bpmMin;
    }

    // SpO2 — same rule.
    if (spo2) {
      session.avgSpo2 = Math.round(spo2.avg);
      session.minSpo2 = spo2.min;
      session.maxSpo2 = spo2.max;
    } else {
      if (typeof spo2Avg === 'number') session.avgSpo2 = spo2Avg;
      if (typeof spo2Peak === 'number') session.maxSpo2 = spo2Peak;
      if (typeof spo2Min === 'number') session.minSpo2 = spo2Min;
    }

    // Temperature — average of readings, rounded to 1 decimal (avoids float noise).
    if (temp && temp.avg != null) session.avgTemp = String(temp.avg.toFixed(1));
    else if (avgTemp !== undefined) session.avgTemp = String(Number(avgTemp).toFixed(1));

    // The recording is finished — it is no longer a live stream.
    session.dataSource = 'stored';

    session.dataPoints = agg?.count?.[0]?.n || 0;

    // The recording is finished, so report generation is due. Mark it queued
    // BEFORE saving, so a client that reads the session immediately after the
    // stop response sees "pending" rather than the stale "not_started".
    session.reportStatus = 'pending';
    session.reportError = null;

    await session.save();

    await User.findOneAndUpdate(
      { id: req.user.userId },
      { $inc: { sessions: 1 }, $set: { lastActive: new Date().toISOString() } }
    );

    // Generate every report for the finished recording. This runs AFTER the
    // response: the session is already saved, and analysing a long recording
    // is not something the device should wait on - a client timeout here would
    // make the app believe the recording failed when it did not. The outcome is
    // recorded on the session as reportStatus, so nothing is silent.
    queueSessionReports(session.id);

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
        name: s.name || null,
        deviceId: s.deviceId,
        startTime: s.startTime,
        endTime: s.endTime,
        duration: s.duration,
        dataPoints: s.dataPoints,
        avgHR: s.avgHR,
        minHR: s.minHR,
        maxHR: s.maxHR,
        avgSpo2: s.avgSpo2 || 0,
        minSpo2: s.minSpo2 || 0,
        maxSpo2: s.maxSpo2 || 0,
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
      // Ordered by timestamp AND seq: a batched frame's samples can share one
      // wall-clock timestamp, so timestamp alone leaves their intra-frame
      // order undefined and the waveform can come back scrambled.
      readings = await Reading.find({ sessionId, userId: req.user.userId })
        .sort({ timestamp: 1, seq: 1 })
        .lean();
    }

    // The app's own beat-level analysis, always included. It is small (one
    // document per beat, not per sample) and it is what the client needs to
    // show intervals alongside the trace, so it is not gated behind
    // includeReadings - that flag is about the bulk sample payload.
    const ecgBeatAnalyses = await loadSessionBeats(sessionId);

    return res.json({
      success: true,
      data: {
        id: session.id,
        name: session.name || null,
        deviceId: session.deviceId,
        startTime: session.startTime,
        endTime: session.endTime,
        duration: session.duration,
        dataPoints: session.dataPoints,
        avgHR: session.avgHR,
        minHR: session.minHR,
        maxHR: session.maxHR,
        avgSpo2: session.avgSpo2 || 0,
        minSpo2: session.minSpo2 || 0,
        maxSpo2: session.maxSpo2 || 0,
        avgTemp: session.avgTemp,
        readings: readings.map((r) => ({
          timestamp: r.timestamp,
          ecgValue: r.ecgValue,
          temperature: r.temperatureCelsius,
          // MAX30102 heart rate, unchanged. No ECG-derived HR is added.
          hr: r.hr || 0,
          spo2: r.spo2 || 0,
          // Sample identity and the rate that makes the time axis meaningful.
          ecgFiltered: r.ecgFiltered ?? null,
          ecgRaw: r.ecgRaw ?? null,
          seq: r.seq ?? null,
          sampleRateHz: r.sampleRateHz ?? null,
        })),
        // APP-generated, beat-level. Distinct from Reading.pqrst, which is the
        // firmware's own per-sample analysis and is not used here.
        ecgBeatAnalyses,
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

    // Derived report data belongs to the deleted recording, so it goes with it.
    await Promise.all([
      EcgRrAnalysis.deleteOne({ sessionId }),
      EcgRrEvent.deleteMany({ sessionId }),
      HrvAnalysis.deleteOne({ sessionId }),
      RhythmAnalysis.deleteOne({ sessionId }),
      RhythmEvent.deleteMany({ sessionId }),
      RespirationAnalysis.deleteOne({ sessionId }),
      Spo2Analysis.deleteOne({ sessionId }),
      Spo2Event.deleteMany({ sessionId }),
      TemperatureAnalysis.deleteOne({ sessionId }),
      TemperatureEvent.deleteMany({ sessionId }),
      CombinedAnalysis.deleteOne({ sessionId }),
      // The app's beat analyses belong to this recording too. NOTE: they are
      // deleted only here, on an explicit session delete - never by
      // invalidateSessionAnalysis, because they are uploaded source data and
      // not something the backend can regenerate.
      EcgBeatAnalysis.deleteMany({ sessionId }),
    ]);

    return res.json({ success: true, data: null, error: null });
  } catch (error) {
    console.error('Delete session error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

module.exports = { createSession, stopSession, listSessions, getSession, deleteSession };
