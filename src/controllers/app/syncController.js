const crypto = require('crypto');
const Reading = require('../../models/Reading');
const Session = require('../../models/Session');
const Device = require('../../models/Device');
const User = require('../../models/User');
const { normalizeBeatFields, expandDeviceFrame } = require('../../utils/rPeakIngest');
const { generateSessionReports } = require('../../services/ecgRrService');

function readingId() {
  return `rdg_${crypto.randomBytes(8).toString('hex')}`;
}

function sessionId() {
  return `sess_${crypto.randomBytes(8).toString('hex')}`;
}

async function syncData(req, res) {
  const { sessions = [], readings = [] } = req.body || {};

  if (!Array.isArray(sessions) || !Array.isArray(readings)) {
    return res.status(400).json({
      success: false,
      data: null,
      error: 'sessions and readings must be arrays.',
    });
  }

  try {
    const user = await User.findOne({ id: req.user.userId });
    if (!user) {
      return res.status(404).json({ success: false, data: null, error: 'User not found.' });
    }

    const pairedDevices = await Device.find({ userId: req.user.userId }).lean();
    const deviceIdSet = new Set(pairedDevices.map((d) => d.id));

    const sessionIdMap = {};
    const sessionsCreated = [];

    for (const s of sessions) {
      if (!s.deviceId || !deviceIdSet.has(s.deviceId)) continue;

      const existing = s.id ? await Session.findOne({ id: s.id, userId: req.user.userId }) : null;
      if (existing) {
        sessionIdMap[s.id] = existing.id;
        continue;
      }

      const newId = s.id || sessionId();
      const start = s.startTime ? new Date(s.startTime).toISOString() : new Date().toISOString();
      const end = s.endTime ? new Date(s.endTime).toISOString() : start;

      const session = await Session.create({
        id: newId,
        userId: user.id,
        userEmail: user.email,
        userName: user.name,
        deviceId: s.deviceId,
        startTime: start,
        endTime: end,
        duration: s.duration || 0,
        dataPoints: 0,
        dataSource: 'stored',
        avgTemp: s.avgTemp !== undefined ? String(s.avgTemp) : '0',
        avgHR: s.bpmAvg || 0,
        minHR: s.bpmMin || 0,
        maxHR: s.bpmPeak || 0,
        clientId: user.clientId || 'CLIENT-001',
      });

      sessionIdMap[s.id || newId] = session.id;
      sessionsCreated.push(session.id);
    }

    // One posted frame can carry N ECG samples, so this loop expands each into
    // its own row - the offline path must not lose samples the live path keeps.
    const readingDocs = [];
    let unparsableFrames = 0;
    const expanded = [];

    for (const raw of readings) {
      const frame = raw.raw ?? raw.frame;
      if (typeof frame !== 'string') {
        expanded.push(raw);
        continue;
      }
      const rows = expandDeviceFrame(frame, raw.timestamp);
      if (!rows || !rows.length) {
        unparsableFrames += 1;
        expanded.push(raw);
        continue;
      }
      for (const row of rows) {
        const out = { ...row };
        for (const [k, v] of Object.entries(raw)) {
          if (v === undefined || k === 'raw' || k === 'frame') continue;
          if (k === 'timestamp' && rows.length > 1) continue;
          out[k] = v;
        }
        expanded.push(out);
      }
    }

    for (const r of expanded) {
      if (r.ecgValue === undefined || r.ecgValue === null || r.ecgValue === '') continue;

      const mappedSessionId = sessionIdMap[r.sessionId] || r.sessionId;
      if (!mappedSessionId || !r.deviceId || !deviceIdSet.has(r.deviceId)) continue;

      readingDocs.push({
        id: readingId(),
        sessionId: mappedSessionId,
        userId: req.user.userId,
        deviceId: r.deviceId,
        timestamp: new Date(r.timestamp).toISOString(),
        ecgValue: Number(r.ecgValue),
        temperatureCelsius:
          r.temperature !== undefined ? Number(r.temperature) : Number(r.temperatureCelsius ?? 0),
        hr: r.hr !== undefined ? Number(r.hr) : 0,
        spo2: r.spo2 !== undefined ? Number(r.spo2) : 0,
        clientId: user.clientId || 'CLIENT-001',
        ...normalizeBeatFields(r),
        // Same two frame-level values the live path carries through.
        sampleRateHz: r.sampleRateHz ?? null,
        ...(r.pqrst ? { pqrst: r.pqrst } : {}),
      });
    }

    if (readingDocs.length) {
      await Reading.insertMany(readingDocs, { ordered: false });
    }

    const countsBySession = readingDocs.reduce((acc, r) => {
      acc[r.sessionId] = (acc[r.sessionId] || 0) + 1;
      return acc;
    }, {});
    await Promise.all(
      Object.entries(countsBySession).map(([sid, count]) =>
        Session.updateOne({ id: sid, userId: req.user.userId }, { $inc: { dataPoints: count } })
      )
    );

    user.lastActive = new Date().toISOString();
    await user.save();

    // An offline sync delivers a complete recording, so the ECG/RR analysis is
    // computed and persisted here rather than on first report request. Only
    // sessions that actually received beats are analysed.
    const sessionsWithBeats = [
      ...new Set(readingDocs.filter((d) => d.beat).map((d) => d.sessionId)),
    ];
    for (const sid of sessionsWithBeats) {
      // Status-aware so an offline upload leaves the same trace as a live stop.
      await generateSessionReports(sid);
    }

    return res.json({
      success: true,
      data: {
        sessionsSynced: sessionsCreated.length,
        readingsSynced: readingDocs.length,
        ...(unparsableFrames ? { unparsableFrames } : {}),
        sessionIdMap,
      },
      error: null,
    });
  } catch (error) {
    console.error('Sync error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

module.exports = { syncData };
