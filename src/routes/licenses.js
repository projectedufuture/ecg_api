const express = require('express');
const { body, param } = require('express-validator');
const auth = require('../middleware/auth');
const { applyClientScope } = require('../middleware/rbac');
const { auditLogger } = require('../middleware/auditLogger');
const validate = require('../middleware/validate');
const Device = require('../models/Device');
const {
  listLicenses,
  generateLicense,
  activateLicense,
  deactivateLicense,
} = require('../controllers/licensesController');

const router = express.Router();

router.use(auth);
router.use(applyClientScope);
router.use(auditLogger);

const licenseIdParam = [
  param('id').isString().trim().notEmpty().withMessage('License id is required.'),
];

router.get('/', listLicenses);

router.post(
  '/generate',
  [
    body('deviceId')
      .notEmpty()
      .withMessage('Device ID is required.')
      .matches(/^ECG-\d{5}$/)
      .withMessage('Device ID must be in format ECG-XXXXX.')
      .bail()
      .custom(async (value) => {
        const device = await Device.findOne({ id: value }).lean();
        if (!device) {
          throw new Error('Device not found.');
        }
        return true;
      }),
  ],
  validate,
  generateLicense
);

router.put('/:id/activate', licenseIdParam, validate, activateLicense);
router.put('/:id/deactivate', licenseIdParam, validate, deactivateLicense);

module.exports = router;
