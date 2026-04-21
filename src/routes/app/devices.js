const express = require('express');
const { body } = require('express-validator');
const appAuth = require('../../middleware/appAuth');
const { pairDevice, getMyDevice } = require('../../controllers/app/devicesController');

const router = express.Router();

router.post(
  '/pair',
  appAuth,
  [
    body('deviceId').isString().trim().notEmpty().withMessage('deviceId is required.'),
    body('licenseKey').isString().trim().notEmpty().withMessage('licenseKey is required.'),
  ],
  pairDevice
);

router.get('/mine', appAuth, getMyDevice);

// User-initiated unpair has been removed. Device assignment is owned by the
// admin: POST /api/admin/users/:id/assign-device  and
// DELETE /api/admin/users/:id/assign-device.

module.exports = router;
