const { validationResult } = require('express-validator');
const License = require('../../models/License');
const Device = require('../../models/Device');

async function validateLicense(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, data: null, error: errors.array()[0].msg });
  }

  const { licenseKey, deviceId } = req.body;

  try {
    const filter = { licenseKey };
    if (deviceId) filter.deviceId = deviceId;

    const license = await License.findOne(filter).lean();
    if (!license) {
      return res.status(404).json({
        success: false,
        data: { valid: false, reason: 'License not found.' },
        error: null,
      });
    }

    if (deviceId) {
      const device = await Device.findOne({ id: deviceId, userId: req.user.userId });
      if (!device) {
        return res.status(403).json({
          success: false,
          data: { valid: false, reason: 'Device not paired to this user.' },
          error: null,
        });
      }
    }

    const now = new Date();
    const expiry = new Date(license.expiryDate);
    const isExpired = Number.isFinite(expiry.getTime()) && expiry < now;

    const valid = license.status === 'active' && !isExpired;

    return res.json({
      success: true,
      data: {
        valid,
        status: isExpired ? 'expired' : license.status,
        licenseKey: license.licenseKey,
        deviceId: license.deviceId,
        activationDate: license.activationDate,
        expiryDate: license.expiryDate,
      },
      error: null,
    });
  } catch (error) {
    console.error('Validate license error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

module.exports = { validateLicense };
