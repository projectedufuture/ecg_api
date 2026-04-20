const express = require('express');
const { body } = require('express-validator');
const appAuth = require('../../middleware/appAuth');
const { validateLicense } = require('../../controllers/app/licensesController');

const router = express.Router();

router.post(
  '/validate',
  appAuth,
  [
    body('licenseKey').isString().trim().notEmpty().withMessage('licenseKey is required.'),
    body('deviceId').optional().isString().trim().notEmpty(),
  ],
  validateLicense
);

module.exports = router;
