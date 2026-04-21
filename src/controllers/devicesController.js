const crypto = require('crypto');
const { validationResult } = require('express-validator');
const Device = require('../models/Device');
const License = require('../models/License');
const Session = require('../models/Session');

const DEVICE_ID_RE = /^ECG-(\d{4,5})$/;
const DEVICE_PAD = 5; // ECG-00001 style. Set to 4 if you prefer ECG-0001.

function generateLicenseKey() {
  const prefix = ['A', 'B', 'C', 'D'][Math.floor(Math.random() * 4)];
  const seg1 = crypto.randomBytes(3).toString('hex').toUpperCase().slice(0, 4);
  const seg2 = crypto.randomBytes(3).toString('hex').toUpperCase().slice(0, 4);
  return `${prefix}${seg1}-${seg2}`;
}

async function findNextDeviceNumber() {
  // Pull the highest numeric ID by parsing the suffix. We sort by id desc,
  // then walk matches until we find one parseable — works regardless of pad width.
  const recent = await Device.find({ id: /^ECG-\d+$/ })
    .sort({ id: -1 })
    .limit(50)
    .lean();

  let max = 0;
  for (const d of recent) {
    const m = DEVICE_ID_RE.exec(d.id);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  return max + 1;
}

async function createDeviceWithLicense({ deviceId, clientId, firmware, hardwareVersion, licenseYears = 1 }) {
  const now = new Date();
  const expiry = new Date(now);
  expiry.setFullYear(expiry.getFullYear() + licenseYears);

  const device = await Device.create({
    id: deviceId,
    userId: null,
    userName: 'Unassigned',
    lastSeen: now.toISOString(),
    firmware: firmware || '1.0.0',
    hardwareVersion: hardwareVersion || 'HW-2.0',
    licenseStatus: 'active',
    batteryLevel: 100,
    status: 'active',
    clientId: clientId || 'CLIENT-001',
  });

  // Ensure a unique license key
  let licenseKey;
  for (let i = 0; i < 5; i += 1) {
    const candidate = generateLicenseKey();
    const clash = await License.findOne({ licenseKey: candidate }).lean();
    if (!clash) {
      licenseKey = candidate;
      break;
    }
  }
  if (!licenseKey) licenseKey = `${generateLicenseKey()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;

  const count = await License.countDocuments();
  const licId = `LIC-${String(5000 + count).padStart(6, '0')}`;

  const license = await License.create({
    id: licId,
    licenseKey,
    deviceId,
    clientId: device.clientId,
    status: 'active',
    activationDate: now.toISOString().split('T')[0],
    expiryDate: expiry.toISOString().split('T')[0],
  });

  return { device, license };
}

async function listDevices(req, res) {
  try {
    const {
      page = 1,
      limit = 25,
      sort = 'lastSeen',
      order = 'desc',
      licenseStatus,
      firmware,
      lastSeenFrom,
      lastSeenTo,
      search,
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
    const sortOrder = order === 'asc' ? 1 : -1;

    const filter = {};

    if (req.clientScope) {
      filter.clientId = req.clientScope;
    }

    if (licenseStatus && ['active', 'inactive', 'expired'].includes(licenseStatus)) {
      filter.licenseStatus = licenseStatus;
    }

    if (firmware) {
      filter.firmware = firmware;
    }

    if (search) {
      filter.id = new RegExp(search, 'i');
    }

    if (lastSeenFrom || lastSeenTo) {
      filter.lastSeen = {};
      if (lastSeenFrom) filter.lastSeen.$gte = new Date(lastSeenFrom).toISOString();
      if (lastSeenTo) filter.lastSeen.$lte = new Date(lastSeenTo).toISOString();
    }

    const total = await Device.countDocuments(filter);
    const totalPages = Math.ceil(total / limitNum);

    const devices = await Device.find(filter)
      .sort({ [sort]: sortOrder })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean();

    // Batch-fetch licenses for the page of devices
    const deviceIds = devices.map((d) => d.id);
    const licenses = await License.find({ deviceId: { $in: deviceIds } }).lean();
    const licenseMap = new Map();
    for (const l of licenses) licenseMap.set(l.deviceId, l);

    return res.json({
      success: true,
      data: devices.map((d) => {
        const l = licenseMap.get(d.id);
        return {
          id: d.id,
          userId: d.userId,
          userName: d.userName,
          lastSeen: d.lastSeen,
          firmware: d.firmware,
          hardwareVersion: d.hardwareVersion,
          licenseStatus: d.licenseStatus,
          batteryLevel: d.batteryLevel,
          createdAt: d.createdAt,
          licenseKey: l ? l.licenseKey : null,
          licenseId: l ? l.id : null,
          licenseExpiry: l ? l.expiryDate : null,
        };
      }),
      error: null,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages,
      },
    });
  } catch (error) {
    console.error('List devices error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

async function getDeviceById(req, res) {
  try {
    const { id } = req.params;

    const filter = { id };
    if (req.clientScope) {
      filter.clientId = req.clientScope;
    }

    const device = await Device.findOne(filter).lean();
    if (!device) {
      return res.status(404).json({ success: false, data: null, error: 'Device not found.' });
    }

    // Get license for this device
    const license = await License.findOne({ deviceId: device.id }).lean();
    const licenseData = license
      ? {
          id: license.id,
          licenseKey: license.licenseKey,
          deviceId: license.deviceId,
          clientId: license.clientId,
          status: license.status,
          activationDate: license.activationDate,
          expiryDate: license.expiryDate,
        }
      : null;

    // Get recent sessions for this device
    const sessions = await Session.find({ deviceId: device.id })
      .sort({ startTime: -1 })
      .limit(10)
      .lean();

    const recentSessions = sessions.map((s) => ({
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

    return res.json({
      success: true,
      data: {
        id: device.id,
        userId: device.userId,
        userName: device.userName,
        lastSeen: device.lastSeen,
        firmware: device.firmware,
        hardwareVersion: device.hardwareVersion,
        licenseStatus: device.licenseStatus,
        batteryLevel: device.batteryLevel,
        license: licenseData,
        recentSessions,
      },
      error: null,
    });
  } catch (error) {
    console.error('Get device error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

async function deactivateDevice(req, res) {
  try {
    const { id } = req.params;

    const filter = { id };
    if (req.clientScope) {
      filter.clientId = req.clientScope;
    }

    const device = await Device.findOne(filter);
    if (!device) {
      return res.status(404).json({ success: false, data: null, error: 'Device not found.' });
    }

    device.status = 'inactive';
    device.licenseStatus = 'inactive';
    await device.save();

    // Also deactivate the associated license
    await License.findOneAndUpdate({ deviceId: id }, { status: 'inactive' });

    await req.audit('deactivate', 'device', id, { reason: req.body.reason || 'No reason provided' });

    return res.json({
      success: true,
      data: {
        id: device.id,
        userId: device.userId,
        userName: device.userName,
        lastSeen: device.lastSeen,
        firmware: device.firmware,
        hardwareVersion: device.hardwareVersion,
        licenseStatus: device.licenseStatus,
        batteryLevel: device.batteryLevel,
      },
      error: null,
    });
  } catch (error) {
    console.error('Deactivate device error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

async function reactivateDevice(req, res) {
  try {
    const { id } = req.params;

    const filter = { id };
    if (req.clientScope) {
      filter.clientId = req.clientScope;
    }

    const device = await Device.findOne(filter);
    if (!device) {
      return res.status(404).json({ success: false, data: null, error: 'Device not found.' });
    }

    device.status = 'active';
    device.licenseStatus = 'active';
    await device.save();

    await License.findOneAndUpdate({ deviceId: id }, { status: 'active' });

    await req.audit('reactivate', 'device', id, {});

    return res.json({
      success: true,
      data: {
        id: device.id,
        userId: device.userId,
        userName: device.userName,
        lastSeen: device.lastSeen,
        firmware: device.firmware,
        hardwareVersion: device.hardwareVersion,
        licenseStatus: device.licenseStatus,
        batteryLevel: device.batteryLevel,
      },
      error: null,
    });
  } catch (error) {
    console.error('Reactivate device error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

async function registerDevice(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, data: null, error: errors.array()[0].msg });
  }

  try {
    const { deviceId, firmware, hardwareVersion } = req.body;

    if (!DEVICE_ID_RE.test(deviceId)) {
      return res.status(400).json({
        success: false,
        data: null,
        error: 'Device ID must be in format ECG-NNNNN.',
      });
    }

    const existing = await Device.findOne({ id: deviceId });
    if (existing) {
      return res.status(409).json({ success: false, data: null, error: 'Device ID already registered.' });
    }

    const { device, license } = await createDeviceWithLicense({
      deviceId,
      clientId: req.admin.clientId,
      firmware,
      hardwareVersion,
    });

    await req.audit('register', 'device', deviceId, { firmware, hardwareVersion, licenseKey: license.licenseKey });

    return res.status(201).json({
      success: true,
      data: {
        id: device.id,
        userId: device.userId,
        userName: device.userName,
        lastSeen: device.lastSeen,
        firmware: device.firmware,
        hardwareVersion: device.hardwareVersion,
        licenseStatus: device.licenseStatus,
        batteryLevel: device.batteryLevel,
        license: {
          id: license.id,
          licenseKey: license.licenseKey,
          status: license.status,
          activationDate: license.activationDate,
          expiryDate: license.expiryDate,
        },
      },
      error: null,
    });
  } catch (error) {
    console.error('Register device error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

async function createBulkDevices(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, data: null, error: errors.array()[0].msg });
  }

  try {
    const count = parseInt(req.body.numberOfDevices, 10);
    if (!Number.isFinite(count) || count < 1 || count > 500) {
      return res.status(400).json({
        success: false,
        data: null,
        error: 'numberOfDevices must be between 1 and 500.',
      });
    }

    const firmware = req.body.firmware || '1.0.0';
    const hardwareVersion = req.body.hardwareVersion || 'HW-2.0';
    const startNum = await findNextDeviceNumber();

    const created = [];
    for (let i = 0; i < count; i += 1) {
      const num = startNum + i;
      const deviceId = `ECG-${String(num).padStart(DEVICE_PAD, '0')}`;

      const { device, license } = await createDeviceWithLicense({
        deviceId,
        clientId: req.admin.clientId,
        firmware,
        hardwareVersion,
      });

      created.push({
        id: device.id,
        firmware: device.firmware,
        hardwareVersion: device.hardwareVersion,
        licenseStatus: device.licenseStatus,
        license: {
          id: license.id,
          licenseKey: license.licenseKey,
          status: license.status,
          activationDate: license.activationDate,
          expiryDate: license.expiryDate,
        },
      });
    }

    await req.audit('bulk_register', 'device', `${count}x`, {
      range: `${created[0].id}..${created[created.length - 1].id}`,
    });

    return res.status(201).json({
      success: true,
      data: {
        created: created.length,
        devices: created,
        range: { first: created[0].id, last: created[created.length - 1].id },
      },
      error: null,
    });
  } catch (error) {
    console.error('Bulk create devices error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

module.exports = {
  listDevices,
  getDeviceById,
  deactivateDevice,
  reactivateDevice,
  registerDevice,
  createBulkDevices,
};
