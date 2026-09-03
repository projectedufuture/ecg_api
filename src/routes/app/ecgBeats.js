const express = require('express');
const { body } = require('express-validator');
const appAuth = require('../../middleware/appAuth');
const { uploadEcgBeats } = require('../../controllers/app/ecgBeatsController');

const router = express.Router();

/**
 * POST /api/app/ecg-beats
 *
 * The app's own beat-level ECG analysis. Separate from POST /api/app/readings,
 * which stores raw ECG samples: one endpoint stores the signal, the other
 * stores what the app concluded from it, and merging them would make the
 * sample-storage contract depend on the analyser's output.
 */
router.post(
  '/',
  appAuth,
  [
    body('sessionId').isString().trim().notEmpty().withMessage('sessionId is required.'),
    body('deviceId').isString().trim().notEmpty().withMessage('deviceId is required.'),
    body('beats').isArray({ min: 1 }).withMessage('beats must be a non-empty array.'),

    // Beat identity. Required, because without it a re-upload cannot be
    // recognised as the same beat.
    body('beats.*.rSampleIndex')
      .isInt({ min: 0 })
      .withMessage('Each beat needs a non-negative integer rSampleIndex.'),
    body('beats.*.rSeq').optional().isInt({ min: 0 }).withMessage('rSeq must be a non-negative integer.'),
    // Landmark sample indexes. Same counting as rSampleIndex; each optional,
    // because the app sends only the landmarks it actually located.
    body('beats.*.pSampleIndex')
      .optional()
      .isInt({ min: 0 })
      .withMessage('pSampleIndex must be a non-negative integer.'),
    body('beats.*.qSampleIndex')
      .optional()
      .isInt({ min: 0 })
      .withMessage('qSampleIndex must be a non-negative integer.'),
    body('beats.*.sSampleIndex')
      .optional()
      .isInt({ min: 0 })
      .withMessage('sSampleIndex must be a non-negative integer.'),
    body('beats.*.tSampleIndex')
      .optional()
      .isInt({ min: 0 })
      .withMessage('tSampleIndex must be a non-negative integer.'),
    body('beats.*.timestamp').optional().isISO8601().withMessage('timestamp must be ISO-8601.'),
    body('beats.*.sampleRateHz')
      .optional()
      .isFloat({ min: 0 })
      .withMessage('sampleRateHz must be a positive number.'),

    // PQRST amplitudes. Signed: Q and S are normally negative, so a min:0
    // constraint here would reject valid morphology.
    body('beats.*.p').optional().isFloat().withMessage('p must be numeric.'),
    body('beats.*.q').optional().isFloat().withMessage('q must be numeric.'),
    body('beats.*.r').optional().isFloat().withMessage('r must be numeric.'),
    body('beats.*.s').optional().isFloat().withMessage('s must be numeric.'),
    body('beats.*.t').optional().isFloat().withMessage('t must be numeric.'),

    // Intervals, in ms. Non-negative: a negative duration is not a measurement.
    body('beats.*.prMs').optional().isFloat({ min: 0 }).withMessage('prMs must be a non-negative number.'),
    body('beats.*.qrsMs').optional().isFloat({ min: 0 }).withMessage('qrsMs must be a non-negative number.'),
    body('beats.*.qtMs').optional().isFloat({ min: 0 }).withMessage('qtMs must be a non-negative number.'),
    body('beats.*.qtcMs').optional().isFloat({ min: 0 }).withMessage('qtcMs must be a non-negative number.'),
    body('beats.*.rrMs').optional().isFloat({ min: 0 }).withMessage('rrMs must be a non-negative number.'),

    body('beats.*.pqrstValid').optional().isBoolean().withMessage('pqrstValid must be a boolean.'),
    body('beats.*.rrValid').optional().isBoolean().withMessage('rrValid must be a boolean.'),
  ],
  uploadEcgBeats
);

module.exports = router;
