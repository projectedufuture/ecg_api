const express = require('express');
const { body, param } = require('express-validator');
const appAuth = require('../../middleware/appAuth');
const {
  createActivity,
  listActivities,
  getActivity,
  deleteActivity,
} = require('../../controllers/app/activitiesController');

const router = express.Router();

router.post(
  '/',
  appAuth,
  [
    body('activityType')
      .isIn([
        'walking',
        'running',
        'cycling',
        'hiking',
        'training',
        'recovery_walk',
        'interval_run',
        'other',
      ])
      .withMessage('activityType is not a recognised type.'),
    body('startedAt').optional().isISO8601().withMessage('startedAt must be ISO-8601.'),
    body('endedAt').optional().isISO8601().withMessage('endedAt must be ISO-8601.'),
    body('totalDurationSeconds').optional().isInt({ min: 0 }),
    body('activeDurationSeconds').optional().isInt({ min: 0 }),
    body('pausedDurationSeconds').optional().isInt({ min: 0 }),
    body('distanceMeters').optional().isFloat({ min: 0 }),
    body('averageSpeedMps').optional().isFloat({ min: 0 }),
    body('maxSpeedMps').optional().isFloat({ min: 0 }),
    body('averagePaceSecPerKm').optional().isInt({ min: 0 }),
    body('averageHeartRate').optional().isFloat({ min: 0 }),
    body('maxHeartRate').optional().isFloat({ min: 0 }),
    body('rmssd').optional().isFloat({ min: 0 }),
    body('sdnn').optional().isFloat({ min: 0 }),
    body('calories').optional().isFloat({ min: 0 }),
    body('clientId').optional().isString().trim().isLength({ max: 100 }),
    body('startLocation.lat').optional().isFloat({ min: -90, max: 90 }),
    body('startLocation.lng').optional().isFloat({ min: -180, max: 180 }),
    body('startLocation.accuracy').optional().isFloat({ min: 0 }),
    body('startLocation.address').optional().isString().trim().isLength({ max: 500 }),
    body('routePoints').optional().isArray(),
    body('routePoints.*.latitude').optional().isFloat({ min: -90, max: 90 }),
    body('routePoints.*.longitude').optional().isFloat({ min: -180, max: 180 }),
    body('heartRateSamples').optional().isArray(),
    body('spo2Samples').optional().isArray(),
    body('temperatureSamples').optional().isArray(),
    body('hrvSamples').optional().isArray(),
  ],
  createActivity
);

router.get('/', appAuth, listActivities);

router.get(
  '/:activityId',
  appAuth,
  [param('activityId').isString().notEmpty()],
  getActivity
);

router.delete(
  '/:activityId',
  appAuth,
  [param('activityId').isString().notEmpty()],
  deleteActivity
);

module.exports = router;
