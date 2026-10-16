const express = require('express');
const auth = require('../middleware/auth');
const { applyClientScope } = require('../middleware/rbac');
const { auditLogger } = require('../middleware/auditLogger');
const { listAlerts } = require('../controllers/alertsController');

const router = express.Router();

router.use(auth);
router.use(applyClientScope);
router.use(auditLogger);

router.get('/', listAlerts);

module.exports = router;
