const mongoose = require('mongoose');

/**
 * Persisted session-level rhythm screening result.
 *
 * One document per session, mirroring EcgRrAnalysis and HrvAnalysis. Metric
 * fields are nullable: on any non-success status they stay null so the UI shows
 * the reason rather than a card reading "0 BPM".
 *
 * Event types are non-diagnostic by construction — see rhythmScreening.js.
 */
const rhythmAnalysisSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, unique: true },
    userId: { type: String, required: true },
    deviceId: { type: String, required: true },
    clientId: { type: String, default: 'CLIENT-001' },

    status: {
      type: String,
      enum: ['success', 'insufficient_data', 'poor_signal_quality', 'no_data'],
      required: true,
    },
    message: { type: String, default: null },

    // Descriptive RR timing, shared with the ECG/RR report's classifier.
    rhythmPattern: {
      type: String,
      enum: ['Regular', 'Mostly Regular', 'Variable', 'Highly Variable', 'Unavailable'],
      default: 'Unavailable',
    },
    classificationConfidence: { type: Number, default: null },
    rrCvPercent: { type: Number, default: null },

    // Heart rate, derived from the validated RR sequence (60000/NN).
    averageHR: { type: Number, default: null },
    minimumHR: { type: Number, default: null },
    maximumHR: { type: Number, default: null },

    analysedBeats: { type: Number, default: 0 },
    recordingDurationSec: { type: Number, default: null },

    // Aggregated screening periods, not per-beat counts.
    elevatedHRPeriods: { type: Number, default: 0 },
    lowHRPeriods: { type: Number, default: 0 },
    irregularRRPeriods: { type: Number, default: 0 },

    // Quality flags carried over from the ECG/RR analysis, not recomputed.
    possibleLongRREvents: { type: Number, default: 0 },
    possibleMissedBeats: { type: Number, default: 0 },
    possibleDoubleDetections: { type: Number, default: 0 },

    signalQuality: {
      type: String,
      enum: ['Good', 'Fair', 'Limited', 'Poor', 'Unavailable'],
      default: 'Unavailable',
    },
    usablePercentage: { type: Number, default: null },
    beatsDetected: { type: Number, default: 0 },
    validBeats: { type: Number, default: 0 },
    invalidBeats: { type: Number, default: 0 },

    patientSummary: { type: String, default: null },
    technicalSummary: { type: String, default: null },

    analysedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

rhythmAnalysisSchema.index({ userId: 1 });
rhythmAnalysisSchema.index({ deviceId: 1 });
rhythmAnalysisSchema.index({ clientId: 1 });

module.exports = mongoose.model('RhythmAnalysis', rhythmAnalysisSchema);
