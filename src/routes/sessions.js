const express = require('express');
const { param } = require('express-validator');
const auth = require('../middleware/auth');
const { applyClientScope } = require('../middleware/rbac');
const { auditLogger } = require('../middleware/auditLogger');
const validate = require('../middleware/validate');
const { listSessions, getSessionById } = require('../controllers/sessionsController');

const router = express.Router();

router.use(auth);
router.use(applyClientScope);
router.use(auditLogger);

router.get('/', listSessions);
router.get(
  '/:sessionId',
  [param('sessionId').isString().trim().notEmpty().withMessage('Session id is required.')],
  validate,
  getSessionById
);

module.exports = router;
