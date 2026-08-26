const mongoose = require('mongoose');

/**
 * Persisted session-level respiration result.
 *
 * `finalRespirationRate` is null unless the analysis succeeded outright — on a
 * disagreement between the ECG- and PPG-derived estimates neither is chosen,
 * because picking one arbitrarily would present a coin flip as a measurement.
 *
 * The per-estimate `reason` fields record exactly why an estimate is missing
 * (most often that no raw PPG waveform was recorded), so the UI can explain the
 * gap instead of showing an empty card.
 */
const respirationAnalysisSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, unique: true },
    userId: { type: String, required: true },
    deviceId: { type: String, required: true },
    clientId: { type: String, default: 'CLIENT-001' },

    status: {
      type: String,
      enum: ['success', 'insufficient_data', 'poor_signal_quality', 'disagreement', 'no_data'],
      required: true,
    },
    message: { type: String, default: null },

    // Reported rate. Null on anything but a clean success.
    finalRespirationRate: { type: Number, default: null },
    unit: { type: String, default: 'breaths/min' },
    confidence: {
      type: String,
      enum: ['High', 'Moderate', 'Low', 'Unavailable'],
      default: 'Unavailable',
    },
    /** Which signals backed the reported rate. */
    basis: {
      type: String,
      enum: ['ecg_and_ppg', 'ecg_only', 'ppg_only', null],
      default: null,
    },
    /** Whether the rate falls in the resting plausibility band (a check, not a verdict). */
    withinPlausibleRange: { type: Boolean, default: null },

    // ECG-derived (respiratory sinus arrhythmia)
    ecgRespirationRate: { type: Number, default: null },
    ecgFreqHz: { type: Number, default: null },
    ecgProminence: { type: Number, default: null },
    ecgQuality: {
      type: String,
      enum: ['Good', 'Fair', 'Poor', 'Unavailable'],
      default: 'Unavailable',
    },
    ecgIntervalsUsed: { type: Number, default: null },
    ecgUnavailableReason: { type: String, default: null },
    ecgUnavailableDetail: { type: String, default: null },

    // PPG-derived (baseline modulation of the raw waveform)
    ppgRespirationRate: { type: Number, default: null },
    ppgFreqHz: { type: Number, default: null },
    ppgProminence: { type: Number, default: null },
    ppgQuality: {
      type: String,
      enum: ['Good', 'Fair', 'Poor', 'Unavailable'],
      default: 'Unavailable',
    },
    ppgSamplesUsed: { type: Number, default: null },
    ppgUnavailableReason: { type: String, default: null },
    ppgUnavailableDetail: { type: String, default: null },

    // Cross-check between the two
    differenceBpm: { type: Number, default: null },
    agreementStatus: { type: String, default: null },

    recordingDurationSec: { type: Number, default: null },
    analysedDurationSec: { type: Number, default: null },
    artifactPercentage: { type: Number, default: null },
    spectralResolutionBpm: { type: Number, default: null },

    /**
     * Windowed respiration across the recording. Windows whose respiratory peak
     * was too weak are stored with a null rate and `usable: false` rather than
     * omitted, so the chart can show where the estimate was unreliable instead
     * of interpolating across it.
     */
    trend: [
      {
        _id: false,
        offsetSec: { type: Number },
        midpointSec: { type: Number },
        rateBpm: { type: Number, default: null },
        prominence: { type: Number, default: null },
        usable: { type: Boolean, default: false },
        reason: { type: String, default: null },
      },
    ],

    patientSummary: { type: String, default: null },
    technicalSummary: { type: String, default: null },

    analysedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

respirationAnalysisSchema.index({ userId: 1 });
respirationAnalysisSchema.index({ deviceId: 1 });
respirationAnalysisSchema.index({ clientId: 1 });

module.exports = mongoose.model('RespirationAnalysis', respirationAnalysisSchema);
