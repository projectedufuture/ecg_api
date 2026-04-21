const express = require('express');
const { param } = require('express-validator');
const auth = require('../middleware/auth');
const { applyClientScope } = require('../middleware/rbac');
const { auditLogger } = require('../middleware/auditLogger');
const validate = require('../middleware/validate');
const {
  listLicenses,
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

// Manual license generation has been removed. Licenses are now auto-created
// during POST /admin/devices/register and POST /admin/devices/bulk. The
// activate/deactivate endpoints below stay for revocation/reactivation flows.

router.put('/:id/activate', licenseIdParam, validate, activateLicense);
router.put('/:id/deactivate', licenseIdParam, validate, deactivateLicense);

module.exports = router;
