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
  createBulkDevices,
} = require('../controllers/devicesController');

const router = express.Router();

router.use(auth);
router.use(applyClientScope);
router.use(auditLogger);

const deviceIdParam = [
  param('id')
    .matches(/^ECG-\d{4,5}$/)
    .withMessage('Device ID must be in format ECG-NNNN or ECG-NNNNN.'),
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
      .matches(/^ECG-\d{4,5}$/)
      .withMessage('Device ID must be in format ECG-NNNN or ECG-NNNNN.'),
    body('hardwareVersion').optional().isString().trim().isLength({ min: 1, max: 32 }),
    body('firmware').optional().isString().trim().isLength({ min: 1, max: 32 }),
  ],
  validate,
  registerDevice
);

router.post(
  '/bulk',
  requireRole('super_admin'),
  [
    body('numberOfDevices')
      .isInt({ min: 1, max: 500 })
      .withMessage('numberOfDevices must be an integer between 1 and 500.'),
    body('firmware').optional().isString().trim().isLength({ min: 1, max: 32 }),
    body('hardwareVersion').optional().isString().trim().isLength({ min: 1, max: 32 }),
  ],
  validate,
  createBulkDevices
);

module.exports = router;
