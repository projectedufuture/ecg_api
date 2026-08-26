const express = require('express');
const { body } = require('express-validator');
const appAuth = require('../../middleware/appAuth');
const { uploadReadings, listReadings } = require('../../controllers/app/readingsController');
const { parseDeviceFrame } = require('../../utils/rPeakIngest');

const router = express.Router();

router.post(
  '/',
  appAuth,
  [
    body('sessionId').isString().trim().notEmpty().withMessage('sessionId is required.'),
    body('deviceId').isString().trim().notEmpty().withMessage('deviceId is required.'),
    body('readings').isArray({ min: 1 }).withMessage('readings must be a non-empty array.'),
    body('readings.*.timestamp').isISO8601().withMessage('Each reading needs an ISO-8601 timestamp.'),
    // A reading carries its ECG sample either as an explicit numeric field or
    // inside a raw device frame. Exactly one of the two must be usable, so
    // neither can be required on its own.
    body('readings.*.ecgValue').optional().isNumeric().withMessage('ecgValue must be numeric.'),
    body('readings.*.raw')
      .optional()
      .isString()
      .isLength({ max: 2000 })
      .withMessage('raw must be a device frame string.'),
    body('readings').custom((rows) => {
      if (!Array.isArray(rows)) return true;
      for (let i = 0; i < rows.length; i += 1) {
        const r = rows[i] || {};
        const hasEcg = r.ecgValue !== undefined && r.ecgValue !== null && r.ecgValue !== '';
        const frame = r.raw ?? r.frame;
        const hasFrame = typeof frame === 'string' && parseDeviceFrame(frame) !== null;
        if (!hasEcg && !hasFrame) {
          throw new Error(
            `readings[${i}] needs either a numeric ecgValue or a parsable raw device frame.`
          );
        }
      }
      return true;
    }),
    body('readings.*.hr').optional().isFloat({ min: 0 }).withMessage('hr must be a positive number.'),
    body('readings.*.spo2').optional().isFloat({ min: 0, max: 100 }).withMessage('spo2 must be 0–100.'),
    // R-peak / beat fields for ECG/RR analysis. All optional and additive, so
    // firmware that does not report beats keeps working unchanged.
    body('readings.*.beat').optional().isBoolean().withMessage('beat must be a boolean.'),
    body('readings.*.rPeakTimestamp')
      .optional()
      .isFloat({ min: 0 })
      .withMessage('rPeakTimestamp must be a non-negative device-clock value in ms.'),
    body('readings.*.beatConfidence')
      .optional()
      .isFloat({ min: 0, max: 1 })
      .withMessage('beatConfidence must be between 0 and 1.'),
    body('readings.*.leadOff').optional().isBoolean().withMessage('leadOff must be a boolean.'),
    // Device RR / QUALITY / raw PPG. All optional and additive.
    body('readings.*.rrIntervalMs')
      .optional()
      .isFloat({ min: -1 })
      .withMessage('rrIntervalMs must be a number (-1 = not measured).'),
    body('readings.*.ecgQuality')
      .optional()
      .isFloat({ min: 0 })
      .withMessage('ecgQuality must be a non-negative number.'),
    body('readings.*.ppgIr')
      .optional()
      .isFloat({ min: 0 })
      .withMessage('ppgIr must be a non-negative raw PPG sample.'),
    body('readings.*.ppgRed')
      .optional()
      .isFloat({ min: 0 })
      .withMessage('ppgRed must be a non-negative raw PPG sample.'),
  ],
  uploadReadings
);

router.get('/', appAuth, listReadings);

module.exports = router;
