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
    const hrData = readings.map((r) => ({
      timestamp: r.timestamp,
      ecgValue: r.ecgValue,
      temperatureCelsius: r.temperatureCelsius,
    }));

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
        avgHR: session.avgHR,
        minHR: session.minHR,
        maxHR: session.maxHR,
        avgSpo2: session.avgSpo2 || 0,
        minSpo2: session.minSpo2 || 0,
        maxSpo2: session.maxSpo2 || 0,
        location: session.location || null,
        ecgValues,
        temperatureValues,
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
