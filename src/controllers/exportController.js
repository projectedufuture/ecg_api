const User = require('../models/User');
const Device = require('../models/Device');
const License = require('../models/License');
const Session = require('../models/Session');
const { exportToCSV, userFields, deviceFields, licenseFields, sessionFields } = require('../utils/csvExport');

async function exportData(req, res) {
  try {
    const { type } = req.params;
    const validTypes = ['users', 'devices', 'licenses', 'sessions'];

    if (!validTypes.includes(type)) {
      return res.status(400).json({
        success: false,
        data: null,
        error: `Invalid export type. Must be one of: ${validTypes.join(', ')}`,
      });
    }

    const filter = {};
    if (req.clientScope) {
      filter.clientId = req.clientScope;
    }

    let data;
    let fields;
    let filename;

    switch (type) {
      case 'users': {
        const users = await User.find(filter).lean();
        data = users.map((u) => ({
          id: u.id,
          name: u.name,
          email: u.email,
          registeredDate: u.registeredDate,
          lastActive: u.lastActive,
          status: u.status,
          deviceId: u.deviceId,
          sessions: u.sessions,
        }));
        fields = userFields;
        filename = 'users_export.csv';
        break;
      }
      case 'devices': {
        const devices = await Device.find(filter).lean();
        data = devices.map((d) => ({
          id: d.id,
          userId: d.userId,
          userName: d.userName,
          lastSeen: d.lastSeen,
          firmware: d.firmware,
          hardwareVersion: d.hardwareVersion,
          licenseStatus: d.licenseStatus,
          batteryLevel: d.batteryLevel,
        }));
        fields = deviceFields;
        filename = 'devices_export.csv';
        break;
      }
      case 'licenses': {
        const licenses = await License.find(filter).lean();
        data = licenses.map((l) => ({
          id: l.id,
          licenseKey: l.licenseKey,
          deviceId: l.deviceId,
          clientId: l.clientId,
          status: l.status,
          activationDate: l.activationDate,
          expiryDate: l.expiryDate,
        }));
        fields = licenseFields;
        filename = 'licenses_export.csv';
        break;
      }
      case 'sessions': {
        const sessions = await Session.find(filter).lean();
        data = sessions.map((s) => ({
          id: s.id,
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
        }));
        fields = sessionFields;
        filename = 'sessions_export.csv';
        break;
      }
    }

    const csv = exportToCSV(data, fields);

    await req.audit('export', type, 'bulk', { recordCount: data.length });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(csv);
  } catch (error) {
    console.error('Export error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

module.exports = { exportData };
