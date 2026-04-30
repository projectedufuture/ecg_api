const { validationResult } = require('express-validator');
const Device = require('../../models/Device');
const User = require('../../models/User');
const License = require('../../models/License');

// Error codes the mobile app can switch on to render the right UI without
// having to string-match the human message.
const PAIR_ERR = {
  DEVICE_NOT_FOUND: 'DEVICE_NOT_FOUND',
  DEVICE_INACTIVE: 'DEVICE_INACTIVE',
  DEVICE_NOT_ASSIGNED: 'DEVICE_NOT_ASSIGNED',
  DEVICE_OWNED_BY_OTHER: 'DEVICE_OWNED_BY_OTHER',
  LICENSE_NOT_FOUND: 'LICENSE_NOT_FOUND',
  LICENSE_INVALID: 'LICENSE_INVALID',
  LICENSE_INACTIVE: 'LICENSE_INACTIVE',
  LICENSE_EXPIRED: 'LICENSE_EXPIRED',
};

function pairFailure(res, status, code, message) {
  return res.status(status).json({
    success: false,
    data: null,
    error: message,
    code,
  });
}

/**
 * POST /api/app/devices/pair
 *
 * Mobile flow:
 *   1. Flutter app scans Bluetooth (client-side, no backend call) and shows
 *      the user a list of nearby ECG devices advertising their device ID.
 *   2. User taps a device. The app prompts for the license key (which the
 *      admin emailed to the user).
 *   3. The app calls this endpoint with { deviceId, licenseKey }.
 *   4. Backend validates ownership + license. On success the app proceeds to
 *      open the BLE GATT connection. On failure the app shows the message
 *      from `error` and can branch on `code`.
 *
 * Response on success includes the device + license details so the app can
 * cache them (no extra round-trip needed).
 */
async function pairDevice(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, data: null, error: errors.array()[0].msg });
  }

  const { deviceId, licenseKey } = req.body;

  try {
    const device = await Device.findOne({ id: deviceId });
    if (!device) {
      return pairFailure(res, 404, PAIR_ERR.DEVICE_NOT_FOUND, 'Device not found.');
    }

    if (device.status === 'inactive') {
      return pairFailure(
        res,
        403,
        PAIR_ERR.DEVICE_INACTIVE,
        'Device is inactive. Contact your administrator.'
      );
    }

    if (!device.userId) {
      return pairFailure(
        res,
        403,
        PAIR_ERR.DEVICE_NOT_ASSIGNED,
        'This device has not been assigned to any user. Contact your administrator.'
      );
    }
    if (device.userId !== req.user.userId) {
      return pairFailure(
        res,
        403,
        PAIR_ERR.DEVICE_OWNED_BY_OTHER,
        'This device is assigned to another user.'
      );
    }

    const license = await License.findOne({ deviceId });
    if (!license) {
      return pairFailure(
        res,
        404,
        PAIR_ERR.LICENSE_NOT_FOUND,
        'No license found for this device. Contact your administrator.'
      );
    }
    if (license.licenseKey !== licenseKey) {
      return pairFailure(
        res,
        400,
        PAIR_ERR.LICENSE_INVALID,
        'Invalid license key for this device.'
      );
    }
    if (license.status !== 'active') {
      return pairFailure(
        res,
        403,
        PAIR_ERR.LICENSE_INACTIVE,
        `License is ${license.status}. Contact your administrator.`
      );
    }
    const expiry = new Date(license.expiryDate);
    if (Number.isFinite(expiry.getTime()) && expiry < new Date()) {
      return pairFailure(
        res,
        403,
        PAIR_ERR.LICENSE_EXPIRED,
        'License has expired. Contact your administrator.'
      );
    }

    const user = await User.findOne({ id: req.user.userId });
    if (!user) {
      return res.status(404).json({ success: false, data: null, error: 'User not found.' });
    }

    device.lastSeen = new Date().toISOString();
    if (!device.pairedAt) device.pairedAt = new Date();
    await device.save();

    user.lastActive = new Date().toISOString();
    await user.save();

    return res.json({
      success: true,
      data: {
        device: {
          id: device.id,
          firmware: device.firmware,
          hardwareVersion: device.hardwareVersion,
          batteryLevel: device.batteryLevel,
          lastSeen: device.lastSeen,
        },
        license: {
          licenseKey: license.licenseKey,
          status: license.status,
          activationDate: license.activationDate,
          expiryDate: license.expiryDate,
        },
        message: 'Device paired successfully. You may now connect over Bluetooth.',
      },
      error: null,
    });
  } catch (error) {
    console.error('Pair device error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

/**
 * GET /api/app/devices/mine
 *
 * Returns the device admin has assigned to this user, plus the license
 * details. Mobile app uses this on launch to know which device ID to expect
 * during the BLE scan, and which license key the user should already have
 * received via email.
 */
async function getMyDevice(req, res) {
  try {
    const device = await Device.findOne({ userId: req.user.userId });
    if (!device) {
      return res.status(404).json({
        success: false,
        data: null,
        error: 'No device assigned to this account. Contact your administrator.',
      });
    }

    const license = await License.findOne({ deviceId: device.id }).lean();

    return res.json({
      success: true,
      data: {
        device: {
          id: device.id,
          firmware: device.firmware,
          hardwareVersion: device.hardwareVersion,
          batteryLevel: device.batteryLevel,
          lastSeen: device.lastSeen,
          status: device.status,
        },
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

module.exports = { pairDevice, getMyDevice };
