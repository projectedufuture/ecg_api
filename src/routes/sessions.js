const express = require('express');
const { param } = require('express-validator');
const auth = require('../middleware/auth');
const { applyClientScope } = require('../middleware/rbac');
const { auditLogger } = require('../middleware/auditLogger');
const validate = require('../middleware/validate');
const { listSessions, getSessionById } = require('../controllers/sessionsController');
const {
  getEcgRrReport,
  recalculateEcgRrReport,
  getHrvReport,
  getHrvTrend,
  getRhythmReport,
  getRespirationReport,
  getSpo2Report,
  getTemperatureReport,
  getCombinedReport,
} = require('../controllers/reportsController');

const router = express.Router();

router.use(auth);
router.use(applyClientScope);
router.use(auditLogger);

const sessionIdParam = [
  param('sessionId').isString().trim().notEmpty().withMessage('Session id is required.'),
];

router.get('/', listSessions);

// Report routes are declared before '/:sessionId' so the more specific paths
// are matched first.
router.get('/:sessionId/reports/ecg-rr', sessionIdParam, validate, getEcgRrReport);
router.post(
  '/:sessionId/reports/ecg-rr/recalculate',
  sessionIdParam,
  validate,
  recalculateEcgRrReport
);
router.get('/:sessionId/reports/hrv/trend', sessionIdParam, validate, getHrvTrend);
router.get('/:sessionId/reports/hrv', sessionIdParam, validate, getHrvReport);
router.get('/:sessionId/reports/rhythm', sessionIdParam, validate, getRhythmReport);
router.get('/:sessionId/reports/respiration', sessionIdParam, validate, getRespirationReport);
router.get('/:sessionId/reports/spo2', sessionIdParam, validate, getSpo2Report);
router.get('/:sessionId/reports/temperature', sessionIdParam, validate, getTemperatureReport);
router.get('/:sessionId/reports/combined', sessionIdParam, validate, getCombinedReport);

router.get('/:sessionId', sessionIdParam, validate, getSessionById);

module.exports = router;
