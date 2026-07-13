const Session = require('../models/Session');
const Reading = require('../models/Reading');

async function listSessions(req, res) {
  try {
    const {
      page = 1,
      limit = 25,
      sort = 'startTime',
      order = 'desc',
      userId,
      dateFrom,
      dateTo,
      dataSource,
      search,
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
    const sortOrder = order === 'asc' ? 1 : -1;

    const filter = {};

    if (req.clientScope) {
      filter.clientId = req.clientScope;
    }

    if (userId) {
      filter.userId = userId;
    }

    if (search) {
      const searchRegex = new RegExp(search, 'i');
      filter.$or = [{ userEmail: searchRegex }, { userName: searchRegex }];
    }

    if (dataSource && ['live', 'stored', 'mixed'].includes(dataSource)) {
      filter.dataSource = dataSource;
    }

    if (dateFrom || dateTo) {
      filter.startTime = {};
      if (dateFrom) filter.startTime.$gte = new Date(dateFrom).toISOString();
      if (dateTo) filter.startTime.$lte = new Date(dateTo).toISOString();
    }

    const total = await Session.countDocuments(filter);
    const totalPages = Math.ceil(total / limitNum);

    const sessions = await Session.find(filter)
      .sort({ [sort]: sortOrder })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean();

    return res.json({
      success: true,
      data: sessions.map((s) => ({
        id: s.id,
        name: s.name || null,
        userId: s.userId,
        userEmail: s.userEmail,
        userName: s.userName,
        deviceId: s.deviceId,
        startTime: s.startTime,
        endTime: s.endTime,
        duration: s.duration,
        dataPoints: s.dataPoints,
        dataSource: s.dataSource,
        avgTemp: s.avgTemp,
        avgHR: s.avgHR,
        minHR: s.minHR,
        maxHR: s.maxHR,
        avgSpo2: s.avgSpo2 || 0,
        minSpo2: s.minSpo2 || 0,
        maxSpo2: s.maxSpo2 || 0,
        location: s.location || null,
      })),
      error: null,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages,
      },
    });
  } catch (error) {
    console.error('List sessions error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

async function getSessionById(req, res) {
  try {
    const { sessionId } = req.params;

    const filter = { id: sessionId };
    if (req.clientScope) {
      filter.clientId = req.clientScope;
    }

    const session = await Session.findOne(filter).lean();
    if (!session) {
      return res.status(404).json({ success: false, data: null, error: 'Session not found.' });
    }

    // Get all readings for this session
    const readings = await Reading.find({ sessionId: session.id })
      .sort({ timestamp: 1 })
      .lean();

    const ecgValues = readings.map((r) => r.ecgValue);
    const temperatureValues = readings.map((r) => r.temperatureCelsius);
    const timestamps = readings.map((r) => r.timestamp);
    const hrValues = readings.map((r) => r.hr || 0);
    const spo2Values = readings.map((r) => r.spo2 || 0);
    const hrData = readings.map((r) => ({
      timestamp: r.timestamp,
      ecgValue: r.ecgValue,
      temperatureCelsius: r.temperatureCelsius,
      hr: r.hr || 0,
      spo2: r.spo2 || 0,
    }));

    // Compute avg/min/max from the actual readings (ignoring 0 = no-finger samples).
    // Falls back to the stored session summary when readings carry no HR/SpO2 data.
    const stats = (values, fallback) => {
      const valid = values.filter((v) => v > 0);
      if (valid.length === 0) return fallback;
      const sum = valid.reduce((a, b) => a + b, 0);
      return {
        avg: Math.round(sum / valid.length),
        min: Math.min(...valid),
        max: Math.max(...valid),
      };
    };

    const hrStats = stats(hrValues, {
      avg: session.avgHR,
      min: session.minHR,
      max: session.maxHR,
    });
    const spo2Stats = stats(spo2Values, {
      avg: session.avgSpo2 || 0,
      min: session.minSpo2 || 0,
      max: session.maxSpo2 || 0,
    });

    return res.json({
      success: true,
      data: {
        id: session.id,
        name: session.name || null,
        userId: session.userId,
        userEmail: session.userEmail,
        userName: session.userName,
        deviceId: session.deviceId,
        startTime: session.startTime,
        endTime: session.endTime,
        duration: session.duration,
        dataPoints: session.dataPoints,
        dataSource: session.dataSource,
        avgTemp: session.avgTemp,
        avgHR: hrStats.avg,
        minHR: hrStats.min,
        maxHR: hrStats.max,
        avgSpo2: spo2Stats.avg,
        minSpo2: spo2Stats.min,
        maxSpo2: spo2Stats.max,
        location: session.location || null,
        ecgValues,
        temperatureValues,
        hrValues,
        spo2Values,
        timestamps,
        readings: hrData,
      },
      error: null,
    });
  } catch (error) {
    console.error('Get session error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

module.exports = { listSessions, getSessionById };
