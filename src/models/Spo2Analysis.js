const mongoose = require('mongoose');

/**
 * Persisted session-level SpO2 result. One document per session.
 *
 * Metric fields stay null on any non-success status, so the UI reports the
 * reason rather than a card reading 0 percent.
 */
const spo2AnalysisSchema = new mongoose.Schema(
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

    meanPct: { type: Number, default: null },
    medianPct: { type: Number, default: null },
    minPct: { type: Number, default: null },
    maxPct: { type: Number, default: null },
    sdPct: { type: Number, default: null },

    desaturationEvents: { type: Number, default: 0 },
    strictDesaturationEvents: { type: Number, default: 0 },
    recoveredDesaturations: { type: Number, default: 0 },
    lowSaturationPeriods: { type: Number, default: 0 },

    timeBelow90Sec: { type: Number, default: null },
    timeBelow90Percent: { type: Number, default: null },
    timeBelow88Sec: { type: Number, default: null },
    timeBelow88Percent: { type: Number, default: null },

    stability: {
      type: String,
      enum: ['Stable', 'Moderately variable', 'Variable', 'Unavailable'],
      default: 'Unavailable',
    },

    totalSamples: { type: Number, default: 0 },
    usableSamples: { type: Number, default: 0 },
    excludedSamples: { type: Number, default: 0 },
    coveragePct: { type: Number, default: null },
    analysedDurationSec: { type: Number, default: null },
    recordingDurationSec: { type: Number, default: null },

    patientSummary: { type: String, default: null },
    technicalSummary: { type: String, default: null },

    /** Saturation trace with its rolling baseline, for the chart. */
    series: [
      {
        _id: false,
        offsetSec: { type: Number },
        timestamp: { type: String, default: null },
        spo2: { type: Number },
        baseline: { type: Number, default: null },
      },
    ],

    analysedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

spo2AnalysisSchema.index({ userId: 1 });
spo2AnalysisSchema.index({ clientId: 1 });

module.exports = mongoose.model('Spo2Analysis', spo2AnalysisSchema);
