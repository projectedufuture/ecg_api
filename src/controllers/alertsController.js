const Device = require('../models/Device');
const License = require('../models/License');
const Session = require('../models/Session');

/**
 * GET /admin/alerts
 * System alerts derived live from real fleet state — no mock data:
 *   - devices low on battery / offline
 *   - licenses expired / expiring soon
 *   - sessions that disconnected (ended with no data)
 */
async function listAlerts(req, res) {
  try {
    const scope = req.clientScope ? { clientId: req.clientScope } : {};
    const now = Date.now();
    const DAY = 86400000;
    const alerts = [];

    // ── Devices ──────────────────────────────────────────────
    const devices = await Device.find(scope).select('id batteryLevel lastSeen licenseStatus pairedAt').lean();
    for (const d of devices) {
      const seenMs = d.lastSeen ? new Date(d.lastSeen).getTime() : 0;
      if (typeof d.batteryLevel === 'number' && d.batteryLevel <= 20) {
        alerts.push({
          id: `alert_batt_${d.id}`,
          category: 'device',
          severity: d.batteryLevel <= 10 ? 'critical' : 'warning',
          title: 'Low battery',
          message: `Device ${d.id} battery at ${d.batteryLevel}%.`,
          entityType: 'device',
          entityId: d.id,
          createdAt: d.lastSeen || new Date(),
        });
      }
      if (d.licenseStatus === 'active' && d.pairedAt && seenMs > 0 && now - seenMs > DAY) {
        const hrs = Math.round((now - seenMs) / 3600000);
        alerts.push({
          id: `alert_off_${d.id}`,
          category: 'device',
          severity: now - seenMs > 7 * DAY ? 'critical' : 'warning',
          title: 'Device offline',
          message: `Device ${d.id} has not reported in ${hrs >= 48 ? `${Math.round(hrs / 24)} days` : `${hrs}h`}.`,
          entityType: 'device',
          entityId: d.id,
          createdAt: d.lastSeen,
        });
      }
    }

    // ── Licenses ─────────────────────────────────────────────
    const licenses = await License.find(scope).select('id licenseKey deviceId status expiryDate').lean();
    for (const l of licenses) {
      const exp = l.expiryDate ? new Date(l.expiryDate).getTime() : 0;
      if (l.status === 'expired' || (exp > 0 && exp < now)) {
        alerts.push({
          id: `alert_licexp_${l.id}`,
          category: 'license',
          severity: 'critical',
          title: 'License expired',
          message: `License ${l.licenseKey || l.id}${l.deviceId ? ` (${l.deviceId})` : ''} has expired.`,
          entityType: 'license',
          entityId: l.id,
          createdAt: l.expiryDate || new Date(),
        });
      } else if (exp > 0 && exp - now <= 30 * DAY) {
        const days = Math.ceil((exp - now) / DAY);
        alerts.push({
          id: `alert_licsoon_${l.id}`,
          category: 'license',
          severity: 'warning',
          title: 'License expiring soon',
          message: `License ${l.licenseKey || l.id}${l.deviceId ? ` (${l.deviceId})` : ''} expires in ${days} day${days === 1 ? '' : 's'}.`,
          entityType: 'license',
          entityId: l.id,
          createdAt: l.expiryDate,
        });
      }
    }

    // ── Sessions that disconnected (ended with no data), last 14 days ──
    const since = new Date(now - 14 * DAY).toISOString();
    const dropped = await Session.find({ ...scope, dataPoints: 0, startTime: { $gte: since } })
      .select('id userName deviceId startTime')
      .sort({ startTime: -1 })
      .limit(50)
      .lean();
    for (const s of dropped) {
      alerts.push({
        id: `alert_sess_${s.id}`,
        category: 'session',
        severity: 'info',
        title: 'Session disconnected',
        message: `${s.userName || 'A user'}'s session on ${s.deviceId || 'a device'} ended with no data recorded.`,
        entityType: 'session',
        entityId: s.id,
        createdAt: s.startTime,
      });
    }

    const rank = { critical: 0, warning: 1, info: 2 };
    alerts.sort((a, b) => (rank[a.severity] - rank[b.severity]) || (new Date(b.createdAt) - new Date(a.createdAt)));

    const counts = {
      total: alerts.length,
      critical: alerts.filter((a) => a.severity === 'critical').length,
      warning: alerts.filter((a) => a.severity === 'warning').length,
      info: alerts.filter((a) => a.severity === 'info').length,
    };

    return res.json({ success: true, data: { alerts, counts }, error: null });
  } catch (error) {
    console.error('List alerts error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

module.exports = { listAlerts };
