const { validationResult } = require('express-validator');
const Session = require('../../models/Session');
const User = require('../../models/User');
const { computeAnalytics, ANALYTICS_PERIODS } = require('../../services/analyticsService');

/**
 * GET /api/app/analytics?period=day|week|month|year
 *
 * READ-ONLY aggregation over the user's existing Session records + profile.
 * Only GPS workout sessions (activityType !== 'ecg') count toward training
 * load / distance / calories — mirroring the previous Activity-only semantics.
 * It creates no data and touches no other resource. Returns the same shape the
 * Flutter app computes locally offline.
 */
async function getAnalytics(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, data: null, error: errors.array()[0].msg });
  }

  try {
    const period = ANALYTICS_PERIODS.includes(req.query.period) ? req.query.period : 'week';

    const user = await User.findOne({ id: req.user.userId });
    if (!user) {
      return res.status(404).json({ success: false, data: null, error: 'User not found.' });
    }

    // Pull a 13-month window so the 12-month series + 28-day load are covered.
    // Only the fields the maths needs — no heavy route/HR-sample arrays. Source
    // is now the unified Session record; map its field names to the shape
    // computeAnalytics expects (startTime→startedAt, avgHR→averageHeartRate).
    const cutoff = new Date(Date.now() - 400 * 86400000).toISOString();
    const sessions = await Session.find({
      userId: req.user.userId,
      startTime: { $gte: cutoff },
      activityType: { $ne: 'ecg' },
    })
      .select('activityType startTime activeDurationSeconds distanceMeters calories avgHR')
      .sort({ startTime: 1 })
      .lean();

    const activities = sessions.map((s) => ({
      activityType: s.activityType,
      startedAt: s.startTime,
      activeDurationSeconds: s.activeDurationSeconds || 0,
      distanceMeters: s.distanceMeters || 0,
      calories: s.calories || 0,
      averageHeartRate: s.avgHR || null,
    }));

    const data = computeAnalytics(activities, {
      age: user.age,
      restingHeartRate: user.restingHeartRate,
      period,
    });

    return res.json({ success: true, data, error: null });
  } catch (error) {
    console.error('Get analytics error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

module.exports = { getAnalytics };
