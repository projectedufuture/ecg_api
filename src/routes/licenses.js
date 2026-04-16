const express = require('express');
const { body } = require('express-validator');
const auth = require('../middleware/auth');
const { applyClientScope } = require('../middleware/rbac');
const { auditLogger } = require('../middleware/auditLogger');
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

router.get('/', listLicenses);

router.post(
  '/generate',
  [body('deviceId').notEmpty().withMessage('Device ID is required.')],
  generateLicense
);

router.put('/:id/activate', activateLicense);
router.put('/:id/deactivate', deactivateLicense);

module.exports = router;
