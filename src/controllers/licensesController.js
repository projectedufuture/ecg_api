const { validationResult } = require('express-validator');
const License = require('../models/License');
const Device = require('../models/Device');
const crypto = require('crypto');

async function listLicenses(req, res) {
  try {
    const {
      page = 1,
      limit = 25,
      sort = 'activationDate',
      order = 'desc',
      status,
      deviceId,
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
    const sortOrder = order === 'asc' ? 1 : -1;

    const filter = {};

    if (req.clientScope) {
      filter.clientId = req.clientScope;
    }

    if (status && ['active', 'inactive', 'expired'].includes(status)) {
      filter.status = status;
    }

    if (deviceId) {
      filter.deviceId = deviceId;
    }

    const total = await License.countDocuments(filter);
    const totalPages = Math.ceil(total / limitNum);

    const licenses = await License.find(filter)
      .sort({ [sort]: sortOrder })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean();

    return res.json({
      success: true,
      data: licenses.map((l) => ({
        id: l.id,
        licenseKey: l.licenseKey,
        deviceId: l.deviceId,
        clientId: l.clientId,
        status: l.status,
        activationDate: l.activationDate,
        expiryDate: l.expiryDate,
        createdAt: l.createdAt,
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
    console.error('List licenses error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

async function generateLicense(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, data: null, error: errors.array()[0].msg });
  }

  try {
    const { deviceId } = req.body;

    // Validate device exists
    const device = await Device.findOne({ id: deviceId });
    if (!device) {
      return res.status(404).json({ success: false, data: null, error: 'Device not found.' });
    }

    // Check if device already has an active license
    const existingLicense = await License.findOne({ deviceId, status: 'active' });
    if (existingLicense) {
      return res.status(409).json({
        success: false,
        data: null,
        error: 'Device already has an active license.',
      });
    }

    // Generate license key
    const prefix = ['A', 'B', 'C', 'D'][Math.floor(Math.random() * 4)];
    const seg1 = crypto.randomBytes(3).toString('hex').toUpperCase().slice(0, 4);
    const seg2 = crypto.randomBytes(3).toString('hex').toUpperCase().slice(0, 4);
    const licenseKey = `${prefix}${seg1}-${seg2}`;

    // Generate license ID
    const count = await License.countDocuments();
    const licId = `LIC-${String(5000 + count).padStart(6, '0')}`;

    const now = new Date();
    const expiry = new Date(now);
    expiry.setFullYear(expiry.getFullYear() + 1);

    const license = await License.create({
      id: licId,
      licenseKey,
      deviceId,
      clientId: device.clientId || req.admin.clientId || 'CLIENT-001',
      status: 'inactive',
      activationDate: now.toISOString().split('T')[0],
      expiryDate: expiry.toISOString().split('T')[0],
    });

    await req.audit('generate', 'license', licId, { deviceId, licenseKey });

    return res.status(201).json({
      success: true,
      data: {
        id: license.id,
        licenseKey: license.licenseKey,
        deviceId: license.deviceId,
        clientId: license.clientId,
        status: license.status,
        activationDate: license.activationDate,
        expiryDate: license.expiryDate,
      },
      error: null,
    });
  } catch (error) {
    console.error('Generate license error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

async function activateLicense(req, res) {
  try {
    const { id } = req.params;

    const filter = { id };
    if (req.clientScope) {
      filter.clientId = req.clientScope;
    }

    const license = await License.findOne(filter);
    if (!license) {
      return res.status(404).json({ success: false, data: null, error: 'License not found.' });
    }

    if (license.status === 'active') {
      return res.status(400).json({ success: false, data: null, error: 'License is already active.' });
    }

    license.status = 'active';
    license.activationDate = new Date().toISOString().split('T')[0];
    await license.save();

    // Update device license status
    await Device.findOneAndUpdate({ id: license.deviceId }, { licenseStatus: 'active' });

    await req.audit('activate', 'license', id, { deviceId: license.deviceId });

    return res.json({
      success: true,
      data: {
        id: license.id,
        licenseKey: license.licenseKey,
        deviceId: license.deviceId,
        clientId: license.clientId,
        status: license.status,
        activationDate: license.activationDate,
        expiryDate: license.expiryDate,
      },
      error: null,
    });
  } catch (error) {
    console.error('Activate license error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

async function deactivateLicense(req, res) {
  try {
    const { id } = req.params;

    const filter = { id };
    if (req.clientScope) {
      filter.clientId = req.clientScope;
    }

    const license = await License.findOne(filter);
    if (!license) {
      return res.status(404).json({ success: false, data: null, error: 'License not found.' });
    }

    if (license.status === 'inactive') {
      return res.status(400).json({ success: false, data: null, error: 'License is already inactive.' });
    }

    license.status = 'inactive';
    await license.save();

    await Device.findOneAndUpdate({ id: license.deviceId }, { licenseStatus: 'inactive' });

    await req.audit('deactivate', 'license', id, { deviceId: license.deviceId });

    return res.json({
      success: true,
      data: {
        id: license.id,
        licenseKey: license.licenseKey,
        deviceId: license.deviceId,
        clientId: license.clientId,
        status: license.status,
        activationDate: license.activationDate,
        expiryDate: license.expiryDate,
      },
      error: null,
    });
  } catch (error) {
    console.error('Deactivate license error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

module.exports = { listLicenses, generateLicense, activateLicense, deactivateLicense };
