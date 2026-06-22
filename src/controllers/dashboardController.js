const User = require('../models/User');
const Session = require('../models/Session');
const Device = require('../models/Device');
const License = require('../models/License');

// Build a 12-element array (oldest → current month) from a list of date strings.
// Each element = count of items whose date falls in that calendar month.
function bucketByMonth(dateStrings) {
  const buckets = new Array(12).fill(0);
  const now = new Date();
  // Start of the month 11 months ago
  const start = new Date(now.getFullYear(), now.getMonth() - 11, 1);

  for (const s of dateStrings) {
    if (!s) continue;
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) continue;
    const idx = (d.getFullYear() - start.getFullYear()) * 12 + (d.getMonth() - start.getMonth());
    if (idx >= 0 && idx < 12) buckets[idx] += 1;
  }
  return buckets;
}

function monthLabels() {
  const names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const now = new Date();
  const labels = [];
  for (let i = 11; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    labels.push(names[d.getMonth()]);
  }
  return labels;
}

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

    // Real monthly series for charts (last 12 months including current)
    const startOfWindow = new Date();
    startOfWindow.setFullYear(startOfWindow.getFullYear() - 1);
    startOfWindow.setDate(1);
    startOfWindow.setHours(0, 0, 0, 0);

    const [usersInWindow, sessionsInWindow] = await Promise.all([
      User.find({ ...filter, registeredDate: { $gte: startOfWindow.toISOString().split('T')[0] } })
        .select('registeredDate')
        .lean(),
      Session.find({ ...filter, startTime: { $gte: startOfWindow.toISOString() } })
        .select('startTime')
        .lean(),
    ]);

    const usersMonthly = bucketByMonth(usersInWindow.map((u) => u.registeredDate));
    const sessionsMonthly = bucketByMonth(sessionsInWindow.map((s) => s.startTime));
    const labels = monthLabels();

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
        charts: {
          labels,
          usersMonthly,
          sessionsMonthly,
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
