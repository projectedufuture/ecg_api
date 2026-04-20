const { validationResult } = require('express-validator');
const Device = require('../../models/Device');
const User = require('../../models/User');
const License = require('../../models/License');

async function pairDevice(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, data: null, error: errors.array()[0].msg });
  }

  const { deviceId } = req.body;

  try {
    const device = await Device.findOne({ id: deviceId });
    if (!device) {
      return res.status(404).json({ success: false, data: null, error: 'Device not found.' });
    }

    if (device.status === 'inactive') {
      return res
        .status(403)
        .json({ success: false, data: null, error: 'Device is inactive. Contact support.' });
    }

    if (device.userId && device.userId !== req.user.userId) {
      return res
        .status(409)
        .json({ success: false, data: null, error: 'Device already paired to another user.' });
    }

    const user = await User.findOne({ id: req.user.userId });
    if (!user) {
      return res.status(404).json({ success: false, data: null, error: 'User not found.' });
    }

    device.userId = user.id;
    device.userName = user.name;
    device.lastSeen = new Date().toISOString();
    await device.save();

    user.deviceId = device.id;
    user.lastActive = new Date().toISOString();
    await user.save();

    return res.json({ success: true, data: device.toFrontend(), error: null });
  } catch (error) {
    console.error('Pair device error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

async function getMyDevice(req, res) {
  try {
    const device = await Device.findOne({ userId: req.user.userId });
    if (!device) {
      return res
        .status(404)
        .json({ success: false, data: null, error: 'No device paired to this account.' });
    }

    const license = await License.findOne({ deviceId: device.id }).lean();

    return res.json({
      success: true,
      data: {
        ...device.toFrontend(),
        license: license
          ? {
              id: license.id,
              licenseKey: license.licenseKey,
              status: license.status,
              activationDate: license.activationDate,
              expiryDate: license.expiryDate,
            }
          : null,
      },
      error: null,
    });
  } catch (error) {
    console.error('Get my device error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

async function unpairDevice(req, res) {
  try {
    const device = await Device.findOne({ userId: req.user.userId });
    if (!device) {
      return res
        .status(404)
        .json({ success: false, data: null, error: 'No device paired to this account.' });
    }

    device.userId = null;
    device.userName = 'Unassigned';
    await device.save();

    await User.findOneAndUpdate({ id: req.user.userId }, { deviceId: null });

    return res.json({ success: true, data: null, error: null });
  } catch (error) {
    console.error('Unpair device error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

module.exports = { pairDevice, getMyDevice, unpairDevice };
