const express = require('express');
const auth = require('../middleware/auth');
const { applyClientScope } = require('../middleware/rbac');
const { auditLogger } = require('../middleware/auditLogger');
const { listSessions, getSessionById } = require('../controllers/sessionsController');

const router = express.Router();

router.use(auth);
router.use(applyClientScope);
router.use(auditLogger);

router.get('/', listSessions);
router.get('/:sessionId', getSessionById);

module.exports = router;
