const mongoose = require('mongoose');

/**
 * Persisted session-level combined (cross-signal) result.
 *
 * Each pairwise relationship is stored with the number of synchronised pairs
 * behind it, so a correlation can never be read without the evidence supporting
 * it. Relationships with too few pairs are stored as `available: false` with the
 * reason, rather than omitted.
 */
const combinedAnalysisSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, unique: true },
    userId: { type: String, required: true },
    deviceId: { type: String, required: true },
    clientId: { type: String, default: 'CLIENT-001' },

    status: {
      type: String,
      enum: ['success', 'insufficient_data', 'no_data'],
      required: true,
    },
    message: { type: String, default: null },

    relationships: [
      {
        _id: false,
        label: { type: String },
        available: { type: Boolean, default: false },
        pairs: { type: Number, default: 0 },
        minPairs: { type: Number, default: null },
        spanSec: { type: Number, default: null },
        r: { type: Number, default: null },
        rSquared: { type: Number, default: null },
        association: { type: String, default: 'Unavailable' },
        direction: { type: String, default: 'Unavailable' },
        reason: { type: String, default: null },
        detail: { type: String, default: null },
      },
    ],

    concurrentEvents: [
      {
        _id: false,
        startSec: { type: Number },
        signals: [{ type: String }],
        spo2EventType: { type: String, default: null },
        otherEventType: { type: String, default: null },
        description: { type: String, default: null },
      },
    ],

    rows: { type: Number, default: 0 },
    hrPresent: { type: Number, default: 0 },
    spo2Present: { type: Number, default: 0 },
    tempPresent: { type: Number, default: 0 },
    analysedDurationSec: { type: Number, default: null },
    recordingDurationSec: { type: Number, default: null },

    patientSummary: { type: String, default: null },
    technicalSummary: { type: String, default: null },

    /** Time-aligned multi-signal series; null where a signal was absent. */
    series: [
      {
        _id: false,
        offsetSec: { type: Number },
        timestamp: { type: String, default: null },
        hr: { type: Number, default: null },
        spo2: { type: Number, default: null },
        tempC: { type: Number, default: null },
      },
    ],

    analysedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

combinedAnalysisSchema.index({ userId: 1 });
combinedAnalysisSchema.index({ clientId: 1 });

module.exports = mongoose.model('CombinedAnalysis', combinedAnalysisSchema);
