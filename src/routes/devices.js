const express = require('express');
const { body } = require('express-validator');
const auth = require('../middleware/auth');
const { requireRole, applyClientScope } = require('../middleware/rbac');
const { auditLogger } = require('../middleware/auditLogger');
const {
  listDevices,
  getDeviceById,
  deactivateDevice,
  reactivateDevice,
  registerDevice,
} = require('../controllers/devicesController');

const router = express.Router();

router.use(auth);
router.use(applyClientScope);
router.use(auditLogger);

router.get('/', listDevices);
router.get('/:id', getDeviceById);
router.put('/:id/deactivate', deactivateDevice);
router.put('/:id/reactivate', reactivateDevice);

router.post(
  '/register',
  requireRole('super_admin'),
  [
    body('deviceId')
      .notEmpty()
      .withMessage('Device ID is required.')
      .matches(/^ECG-\d{5}$/)
      .withMessage('Device ID must be in format ECG-XXXXX.'),
  ],
  registerDevice
);

module.exports = router;
