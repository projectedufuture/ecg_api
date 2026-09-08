const Session = require('../models/Session');
const Reading = require('../models/Reading');
const { loadSessionBeats } = require('./app/ecgBeatsController');

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

    // Get all readings for this session.
    // Ordered by timestamp AND seq: a batched frame's samples can share one
    // wall-clock timestamp, so timestamp alone leaves their intra-frame order
    // undefined and the waveform can come back scrambled.
    const readings = await Reading.find({ sessionId: session.id })
      .sort({ timestamp: 1, seq: 1 })
      .lean();

    // The APP's own beat-level analysis, through the SAME mapper the app
    // endpoint uses - so admin and app can never be served different shapes of
    // the same record. Distinct from ecg.pqrst below, which is the firmware's.
    const ecgBeatAnalyses = await loadSessionBeats(session.id);

    // ── ECG waveform block ────────────────────────────────────────────
    //
    // The admin chart renders the SAME real samples the phone does, through
    // the same geometry, so it needs the same three things the phone gets:
    // the samples, the device's declared rate (which IS the time base), and
    // the contact/quality flags that decide whether the trace is trustworthy.
    //
    // Polarity is left exactly as the device sent it. The MAX30003 outputs
    // inverted, and the phone negates at render time - so the renderer, not
    // this projection, owns that transform. Negating here would double it.
    // WHY A WINDOW AND NOT A DECIMATION.
    //
    // Thinning 42,000 samples down to 4,000 and still calling them 128 Hz
    // makes the chart believe it is showing 31 s when the samples actually
    // span 330 s - the time axis is then wrong by 10.6x, and every interval
    // read off it is wrong by that factor. It also aliases the QRS, because
    // each drawn complex is built from every tenth sample.
    //
    // So the samples are never thinned. The most recent window is returned at
    // the FULL device rate, which keeps the axis true. The chart can only
    // legibly draw about 25 s at 25 mm/s anyway (its own minimum px-per-mm
    // rule), so a longer payload would be discarded at render time regardless.
    const ECG_WINDOW_SEC = 60;
    const ecgAll = readings.map((r) => r.ecgValue);

    // The rate the device actually reported. Sessions recorded before the
    // firmware sent RATE_HZ have none, and null must survive to the chart so
    // it declines to claim a calibrated axis.
    const reportedRate = readings.find((r) => r.sampleRateHz > 0);
    // The most recent valid PQRST in the session; the amplitudes cannot place
    // a landmark, so only the intervals are useful to the renderer.
    const lastPqrst = [...readings].reverse().find((r) => r.pqrst && r.pqrst.qrsMs !== null);
    // Contact and quality: degraded if ANY sample says so is too harsh, so
    // these report the dominant state across the recording.
    const leadOffCount = readings.filter((r) => r.leadOff === true).length;
    const poorQualityCount = readings.filter((r) => r.ecgQuality === 0).length;

    const rateHz = reportedRate ? reportedRate.sampleRateHz : null;
    // With no reported rate there is no way to convert seconds to samples, so
    // fall back to a fixed count. The chart will decline to claim a time base
    // for those samples anyway.
    const windowSamples = rateHz && rateHz > 0 ? Math.round(ECG_WINDOW_SEC * rateHz) : 4000;
    const windowStart = Math.max(0, ecgAll.length - windowSamples);

    const ecg = {
      // Full-rate, newest-last. Never thinned, so sample i really is
      // i / sampleRateHz seconds after the first one drawn.
      samples: ecgAll.slice(windowStart),
      totalSamples: ecgAll.length,
      windowStartIndex: windowStart,
      windowed: windowStart > 0,
      sampleRateHz: rateHz,
      leadOn: readings.length > 0 ? leadOffCount < readings.length / 2 : true,
      quality:
        readings.length === 0 || poorQualityCount === 0
          ? 'unknown'
          : poorQualityCount > readings.length / 2
            ? 'poor'
            : 'good',
      pqrst: lastPqrst
        ? {
            prMs: lastPqrst.pqrst.prMs ?? null,
            qrsMs: lastPqrst.pqrst.qrsMs ?? null,
            qtMs: lastPqrst.pqrst.qtMs ?? null,
            qtcMs: lastPqrst.pqrst.qtcMs ?? null,
          }
        : null,
    };

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
      // Device-reported RR interval (device RR field) and PR interval (from
      // the device's own PQRST, present only on the sample it belongs to).
      // Sparse by nature - most readings carry neither - so the client
      // forward-fills them the same way it already does for hr/temp, holding
      // the last real value until the next one arrives.
      rrIntervalMs: r.rrIntervalMs ?? null,
      prMs: r.pqrst?.prMs ?? null,
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
        ecg,
        // APP-generated, beat-level, one document per detected beat.
        ecgBeatAnalyses,
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
