const express = require('express');
const { body } = require('express-validator');
const appAuth = require('../../middleware/appAuth');
const { uploadReadings, listReadings } = require('../../controllers/app/readingsController');

const router = express.Router();

router.post(
  '/',
  appAuth,
  [
    body('sessionId').isString().trim().notEmpty().withMessage('sessionId is required.'),
    body('deviceId').isString().trim().notEmpty().withMessage('deviceId is required.'),
    body('readings').isArray({ min: 1 }).withMessage('readings must be a non-empty array.'),
    body('readings.*.timestamp').isISO8601().withMessage('Each reading needs an ISO-8601 timestamp.'),
    body('readings.*.ecgValue').isNumeric().withMessage('ecgValue must be numeric.'),
    body('readings.*.hr').optional().isFloat({ min: 0 }).withMessage('hr must be a positive number.'),
    body('readings.*.spo2').optional().isFloat({ min: 0, max: 100 }).withMessage('spo2 must be 0–100.'),
  ],
  uploadReadings
);

router.get('/', appAuth, listReadings);

module.exports = router;
