const Session = require('../models/Session');
const User = require('../models/User');

// ── Session-activity digest ─────────────────────────────────────────────────
// Builds the data that goes into a scheduled summary email: who was active
// (logins), and the sessions recorded in the window with each one's start time
// and duration. `clientScope` is null for super_admin (all clients) or a
// clientId string for a client_admin.
//
// Note: the platform has no dedicated login-event log, so "logins" is
// approximated by users whose `lastActive` timestamp falls inside the window —
// the closest available signal for "when a user was last using the app".
async function buildSummaryDigest({ from, to, clientScope }) {
  const fromISO = from.toISOString();
  const toISO = to.toISOString();

  const sessionFilter = { startTime: { $gte: fromISO, $lt: toISO } };
  const userFilter = { lastActive: { $gte: fromISO, $lt: toISO } };
  if (clientScope) {
    sessionFilter.clientId = clientScope;
    userFilter.clientId = clientScope;
  }

  const [sessions, activeUsers] = await Promise.all([
    Session.find(sessionFilter)
      .select('id userName userEmail startTime endTime duration activityType deviceId')
      .sort({ startTime: 1 })
      .lean(),
    User.find(userFilter)
      .select('name email lastActive')
      .sort({ lastActive: -1 })
      .lean(),
  ]);

  // `duration` is stored in whole minutes.
  const totalDurationMin = sessions.reduce((sum, s) => sum + (Number(s.duration) || 0), 0);

  const sessionRows = sessions.map((s) => ({
    id: s.id,
    userName: s.userName,
    userEmail: s.userEmail,
    startTime: s.startTime,
    endTime: s.endTime,
    durationMin: Number(s.duration) || 0,
    activityType: s.activityType || 'ecg',
  }));

  const loginRows = activeUsers.map((u) => ({
    name: u.name,
    email: u.email,
    lastActive: u.lastActive,
  }));

  return {
    sessionCount: sessions.length,
    totalDurationMin,
    uniqueSessionUsers: new Set(sessions.map((s) => s.userEmail)).size,
    activeUserCount: activeUsers.length,
    sessions: sessionRows,
    logins: loginRows,
  };
}

module.exports = { buildSummaryDigest };
