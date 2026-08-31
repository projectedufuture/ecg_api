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
    // A reading carries its ECG sample either as an explicit numeric field or
    // inside a raw device frame. Exactly one of the two must be usable, so
    // neither can be required on its own.
    body('readings.*.ecgValue').optional().isNumeric().withMessage('ecgValue must be numeric.'),
    body('readings.*.raw')
      .optional()
      .isString()
      .isLength({ max: 2000 })
      .withMessage('raw must be a device frame string.'),
    // NOTE: there is deliberately no batch-level "every reading must have an
    // ECG sample" check here. Failing the whole request on one malformed packet
    // discards up to 5000 good readings with it, which is the worst possible
    // outcome for a device that cannot re-send. Unusable readings are skipped
    // individually and counted in the response instead - see uploadReadings.
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
    // Transmission sequence and the device's own validity flags. All optional
    // and additive, so older firmware keeps working unchanged.
    body('readings.*.seq')
      .optional()
      .isInt({ min: 0 })
      .withMessage('seq must be a non-negative integer packet counter.'),
    body('readings.*.ecgRaw').optional().isFloat().withMessage('ecgRaw must be numeric.'),
    body('readings.*.ecgFiltered').optional().isFloat().withMessage('ecgFiltered must be numeric.'),
    body('readings.*.beatValid').optional().isBoolean().withMessage('beatValid must be a boolean.'),
    body('readings.*.rrValid').optional().isBoolean().withMessage('rrValid must be a boolean.'),
    body('readings.*.hrEcgValid')
      .optional()
      .isBoolean()
      .withMessage('hrEcgValid must be a boolean.'),
    body('readings.*.pqrstValid')
      .optional()
      .isBoolean()
      .withMessage('pqrstValid must be a boolean.'),
    body('readings.*.hrInstant')
      .optional()
      .isFloat({ min: 0 })
      .withMessage('hrInstant must be a positive number.'),
    body('readings.*.hrAvg')
      .optional()
      .isFloat({ min: 0 })
      .withMessage('hrAvg must be a positive number.'),
    body('readings.*.rejectReason')
      .optional()
      .isString()
      .isLength({ max: 200 })
      .withMessage('rejectReason must be a short string.'),
  ],
  uploadReadings
);

router.get('/', appAuth, listReadings);

module.exports = router;
