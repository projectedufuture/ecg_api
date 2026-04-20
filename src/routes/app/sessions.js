const express = require('express');
const { body, param } = require('express-validator');
const appAuth = require('../../middleware/appAuth');
const {
  createSession,
  stopSession,
  listSessions,
  getSession,
  deleteSession,
} = require('../../controllers/app/sessionsController');

const router = express.Router();

router.post(
  '/',
  appAuth,
  [
    body('deviceId').isString().trim().notEmpty().withMessage('deviceId is required.'),
    body('startTime').optional().isISO8601().withMessage('startTime must be ISO-8601.'),
    body('name').optional().isString().trim(),
  ],
  createSession
);

router.put(
  '/:sessionId',
  appAuth,
  [
    param('sessionId').isString().notEmpty(),
    body('endTime').optional().isISO8601().withMessage('endTime must be ISO-8601.'),
    body('duration').optional().isInt({ min: 0 }).withMessage('duration must be a positive integer.'),
    body('bpmAvg').optional().isFloat({ min: 0 }),
    body('bpmPeak').optional().isFloat({ min: 0 }),
    body('bpmMin').optional().isFloat({ min: 0 }),
    body('avgTemp').optional().isFloat(),
  ],
  stopSession
);

router.get('/', appAuth, listSessions);

router.get(
  '/:sessionId',
  appAuth,
  [param('sessionId').isString().notEmpty()],
  getSession
);

router.delete(
  '/:sessionId',
  appAuth,
  [param('sessionId').isString().notEmpty()],
  deleteSession
);

module.exports = router;
