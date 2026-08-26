const express = require('express');
const { param, query } = require('express-validator');
const appAuth = require('../../middleware/appAuth');
const {
  listReportSessions,
  getReportOverview,
  getReportModule,
  MODULE_NAMES,
} = require('../../controllers/app/reportsController');

const router = express.Router();

// Every route is behind appAuth, and each handler additionally scopes its
// lookup to req.user.userId - a token alone is not authorization to read a
// given session's reports.
router.use(appAuth);

/**
 * GET /api/app/reports/sessions
 *
 * The user's recordings with the state of their reports. Mounted before the
 * ":sessionId" route so "sessions" is never mistaken for a session id.
 */
router.get(
  '/sessions',
  [query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('limit must be 1-100.')],
  listReportSessions
);

/** GET /api/app/reports/:sessionId - headline numbers for all seven modules. */
router.get(
  '/:sessionId',
  [param('sessionId').isString().trim().notEmpty().withMessage('sessionId is required.')],
  getReportOverview
);

/** GET /api/app/reports/:sessionId/:module - one module in full. */
router.get(
  '/:sessionId/:module',
  [
    param('sessionId').isString().trim().notEmpty().withMessage('sessionId is required.'),
    param('module')
      .isIn(MODULE_NAMES)
      .withMessage(`module must be one of: ${MODULE_NAMES.join(', ')}.`),
  ],
  getReportModule
);

module.exports = router;
