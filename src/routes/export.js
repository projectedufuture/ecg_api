const express = require('express');
const auth = require('../middleware/auth');
const { applyClientScope } = require('../middleware/rbac');
const { auditLogger } = require('../middleware/auditLogger');
const { exportData } = require('../controllers/exportController');

const router = express.Router();

router.use(auth);
router.use(applyClientScope);
router.use(auditLogger);

router.get('/:type', exportData);

module.exports = router;
