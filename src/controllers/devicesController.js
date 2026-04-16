const { validationResult } = require('express-validator');
const Device = require('../models/Device');
const License = require('../models/License');
const Session = require('../models/Session');

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

    return res.json({
      success: true,
      data: devices.map((d) => ({
        id: d.id,
        userId: d.userId,
        userName: d.userName,
        lastSeen: d.lastSeen,
        firmware: d.firmware,
        hardwareVersion: d.hardwareVersion,
        licenseStatus: d.licenseStatus,
        batteryLevel: d.batteryLevel,
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
    const { deviceId, userId, firmware, hardwareVersion } = req.body;

    // Validate device ID format: ECG-XXXXX
    if (!/^ECG-\d{5}$/.test(deviceId)) {
      return res.status(400).json({
        success: false,
        data: null,
        error: 'Device ID must be in format ECG-XXXXX (5 digits).',
      });
    }

    // Check if device already exists
    const existing = await Device.findOne({ id: deviceId });
    if (existing) {
      return res.status(409).json({ success: false, data: null, error: 'Device ID already registered.' });
    }

    const device = await Device.create({
      id: deviceId,
      userId: userId || null,
      userName: 'Unassigned',
      lastSeen: new Date().toISOString(),
      firmware: firmware || '1.0.0',
      hardwareVersion: hardwareVersion || 'HW-2.0',
      licenseStatus: 'inactive',
      batteryLevel: 100,
      status: 'active',
      clientId: req.admin.clientId || 'CLIENT-001',
    });

    await req.audit('register', 'device', deviceId, { firmware, hardwareVersion });

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
      },
      error: null,
    });
  } catch (error) {
    console.error('Register device error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

module.exports = { listDevices, getDeviceById, deactivateDevice, reactivateDevice, registerDevice };
