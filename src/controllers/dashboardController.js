const User = require('../models/User');
const Session = require('../models/Session');
const Device = require('../models/Device');
const License = require('../models/License');

async function getDashboard(req, res) {
  try {
    const filter = {};
    if (req.clientScope) {
      filter.clientId = req.clientScope;
    }

    // Total users
    const totalUsers = await User.countDocuments(filter);

    // Total sessions
    const totalSessions = await Session.countDocuments(filter);

    // Total devices
    const totalDevices = await Device.countDocuments(filter);

    // Active devices (last 24h)
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const activeDevices = await Device.countDocuments({
      ...filter,
      lastSeen: { $gte: twentyFourHoursAgo },
    });

    // Active licenses
    const activeLicenses = await License.countDocuments({ ...filter, status: 'active' });

    // Trends: compare last 7 days vs previous 7 days for users and sessions
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const recentUsers = await User.countDocuments({
      ...filter,
      registeredDate: { $gte: sevenDaysAgo },
    });
    const previousUsers = await User.countDocuments({
      ...filter,
      registeredDate: { $gte: fourteenDaysAgo, $lt: sevenDaysAgo },
    });

    const recentSessions = await Session.countDocuments({
      ...filter,
      startTime: { $gte: new Date(sevenDaysAgo).toISOString() },
    });
    const previousSessions = await Session.countDocuments({
      ...filter,
      startTime: {
        $gte: new Date(fourteenDaysAgo).toISOString(),
        $lt: new Date(sevenDaysAgo).toISOString(),
      },
    });

    const usersTrend = previousUsers === 0
      ? (recentUsers > 0 ? 100 : 0)
      : Math.round(((recentUsers - previousUsers) / previousUsers) * 100);

    const sessionsTrend = previousSessions === 0
      ? (recentSessions > 0 ? 100 : 0)
      : Math.round(((recentSessions - previousSessions) / previousSessions) * 100);

    return res.json({
      success: true,
      data: {
        totalUsers,
        totalSessions,
        activeDevices,
        totalDevices,
        activeLicenses,
        systemHealth: 'green',
        trends: {
          usersTrend,
          sessionsTrend,
        },
      },
      error: null,
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

module.exports = { getDashboard };
