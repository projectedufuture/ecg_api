const crypto = require('crypto');
const { validationResult } = require('express-validator');
const Activity = require('../../models/Activity');
const User = require('../../models/User');
const {
  normalizeActivityType,
  nonNeg,
  deriveAverageSpeedMps,
  derivePaceSecPerKm,
  sanitizeRoutePoints,
  sanitizeHeartRateSamples,
  sanitizeMetricSamples,
  optPosInt,
} = require('../../services/activityService');

function makeActivityId() {
  return `act_${crypto.randomBytes(8).toString('hex')}`;
}

/**
 * POST /api/app/activities
 * Save a completed activity (created in one shot by the app). Derived metrics
 * (avg speed / pace) are recomputed server-side from distance + active time so
 * the stored values are internally consistent.
 */
async function createActivity(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, data: null, error: errors.array()[0].msg });
  }

  try {
    const user = await User.findOne({ id: req.user.userId });
    if (!user) {
      return res.status(404).json({ success: false, data: null, error: 'User not found.' });
    }

    const b = req.body;
    const activityType = normalizeActivityType(b.activityType);
    const startedAt = b.startedAt ? new Date(b.startedAt).toISOString() : new Date().toISOString();
    const endedAt = b.endedAt ? new Date(b.endedAt).toISOString() : null;

    const distanceMeters = nonNeg(b.distanceMeters);
    const activeDurationSeconds = Math.round(nonNeg(b.activeDurationSeconds));
    const totalDurationSeconds = Math.round(nonNeg(b.totalDurationSeconds, activeDurationSeconds));
    const pausedDurationSeconds = Math.round(
      nonNeg(b.pausedDurationSeconds, Math.max(0, totalDurationSeconds - activeDurationSeconds))
    );

    const routePoints = sanitizeRoutePoints(b.routePoints);
    const heartRateSamples = sanitizeHeartRateSamples(b.heartRateSamples);
    const spo2Samples = sanitizeMetricSamples(b.spo2Samples);
    const temperatureSamples = sanitizeMetricSamples(b.temperatureSamples);
    const hrvSamples = sanitizeMetricSamples(b.hrvSamples);

    // Recompute derived speed/pace rather than trusting the client blindly.
    const averageSpeedMps = deriveAverageSpeedMps(distanceMeters, activeDurationSeconds);
    const averagePaceSecPerKm = derivePaceSecPerKm(distanceMeters, activeDurationSeconds);

    let startLocation = null;
    const loc = b.startLocation;
    if (loc && Number.isFinite(Number(loc.lat)) && Number.isFinite(Number(loc.lng))) {
      startLocation = {
        lat: Number(loc.lat),
        lng: Number(loc.lng),
        accuracy: loc.accuracy != null ? Number(loc.accuracy) : null,
        address: loc.address || null,
      };
    }

    const activity = await Activity.create({
      id: makeActivityId(),
      userId: user.id,
      userEmail: user.email,
      userName: user.name,
      clientId: b.clientId || null,
      activityType,
      startedAt,
      endedAt,
      totalDurationSeconds,
      activeDurationSeconds,
      pausedDurationSeconds,
      distanceMeters,
      averageSpeedMps,
      maxSpeedMps: nonNeg(b.maxSpeedMps),
      averagePaceSecPerKm,
      averageHeartRate: optPosInt(b.averageHeartRate),
      maxHeartRate: optPosInt(b.maxHeartRate),
      rmssd: optPosInt(b.rmssd),
      sdnn: optPosInt(b.sdnn),
      calories: Math.round(nonNeg(b.calories)),
      startLocation,
      routePoints,
      heartRateSamples,
      spo2Samples,
      temperatureSamples,
      hrvSamples,
    });

    return res.status(201).json({ success: true, data: activity.toFrontend(), error: null });
  } catch (error) {
    console.error('Create activity error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

/** GET /api/app/activities — paginated history (summaries, newest first). */
async function listActivities(req, res) {
  try {
    const { page = 1, limit = 20, from, to } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));

    const filter = { userId: req.user.userId };
    if (from || to) {
      filter.startedAt = {};
      if (from) filter.startedAt.$gte = new Date(from).toISOString();
      if (to) filter.startedAt.$lte = new Date(to).toISOString();
    }

    const total = await Activity.countDocuments(filter);
    const activities = await Activity.find(filter)
      .sort({ startedAt: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum);

    return res.json({
      success: true,
      data: activities.map((a) => a.toSummary()),
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
      error: null,
    });
  } catch (error) {
    console.error('List activities error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

/** GET /api/app/activities/:activityId — full record incl. route + HR samples. */
async function getActivity(req, res) {
  try {
    const { activityId } = req.params;
    const activity = await Activity.findOne({ id: activityId, userId: req.user.userId });
    if (!activity) {
      return res.status(404).json({ success: false, data: null, error: 'Activity not found.' });
    }
    return res.json({ success: true, data: activity.toFrontend(), error: null });
  } catch (error) {
    console.error('Get activity error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

/** DELETE /api/app/activities/:activityId */
async function deleteActivity(req, res) {
  try {
    const { activityId } = req.params;
    const activity = await Activity.findOneAndDelete({ id: activityId, userId: req.user.userId });
    if (!activity) {
      return res.status(404).json({ success: false, data: null, error: 'Activity not found.' });
    }
    return res.json({ success: true, data: null, error: null });
  } catch (error) {
    console.error('Delete activity error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

module.exports = { createActivity, listActivities, getActivity, deleteActivity };
