const express = require('express');
const { body, param } = require('express-validator');
const auth = require('../middleware/auth');
const { requireRole, applyClientScope } = require('../middleware/rbac');
const { auditLogger } = require('../middleware/auditLogger');
const validate = require('../middleware/validate');
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

const deviceIdParam = [
  param('id')
    .matches(/^ECG-\d{5}$/)
    .withMessage('Device ID must be in format ECG-XXXXX.'),
];
const reasonBody = [body('reason').optional().isString().trim().isLength({ max: 500 })];

router.get('/', listDevices);
router.get('/:id', deviceIdParam, validate, getDeviceById);
router.put('/:id/deactivate', deviceIdParam, reasonBody, validate, deactivateDevice);
router.put('/:id/reactivate', deviceIdParam, reasonBody, validate, reactivateDevice);

router.post(
  '/register',
  requireRole('super_admin'),
  [
    body('deviceId')
      .notEmpty()
      .withMessage('Device ID is required.')
      .matches(/^ECG-\d{5}$/)
      .withMessage('Device ID must be in format ECG-XXXXX.'),
    body('hardwareVersion').optional().isString().trim().isLength({ min: 1, max: 32 }),
    body('firmware').optional().isString().trim().isLength({ min: 1, max: 32 }),
    body('userId').optional().isString().trim(),
  ],
  validate,
  registerDevice
);

module.exports = router;
