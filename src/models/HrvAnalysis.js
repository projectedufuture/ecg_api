const mongoose = require('mongoose');

/**
 * Persisted session-level HRV result.
 *
 * One document per session, mirroring EcgRrAnalysis. Session, user and device
 * identity are carried only as the keys needed for scoping and baseline lookup;
 * everything else about the recording is reached through the Session relation.
 *
 * Metric fields are nullable on purpose: when a recording cannot support HRV
 * (`status !== 'success'`) they stay null so the UI reports the reason instead of
 * a card reading "SDNN 0 ms".
 */
const hrvAnalysisSchema = new mongoose.Schema(
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

    // Durations. analysisDurationSec is the time the accepted NN intervals
    // actually cover, which is what the metrics were computed over.
    recordingDurationSec: { type: Number, default: null },
    analysisDurationSec: { type: Number, default: null },
    shortRecording: { type: Boolean, default: false },
    ultraShortRecording: { type: Boolean, default: false },

    // Interval accounting
    totalRRIntervals: { type: Number, default: 0 },
    validNNIntervals: { type: Number, default: 0 },
    excludedIntervals: { type: Number, default: 0 },
    usablePercentage: { type: Number, default: null },
    artifactPercentage: { type: Number, default: null },
    successivePairs: { type: Number, default: 0 },
    successivePairsSkipped: { type: Number, default: 0 },

    // Time-domain metrics (ms, except pNN50 in %)
    meanNNMs: { type: Number, default: null },
    minNNMs: { type: Number, default: null },
    maxNNMs: { type: Number, default: null },
    sdnnMs: { type: Number, default: null },
    rmssdMs: { type: Number, default: null },
    pnn50Percent: { type: Number, default: null },

    quality: {
      type: String,
      enum: ['Good', 'Acceptable', 'Limited', 'Insufficient'],
      default: 'Insufficient',
    },
    // The upstream ECG assessment this HRV result inherits.
    ecgSignalQuality: { type: String, default: null },

    // Personal baseline from the same user's prior valid sessions. Never a
    // population norm.
    personalBaselineAvailable: { type: Boolean, default: false },
    baselineSessionsUsed: { type: Number, default: 0 },
    baselineRmssdMs: { type: Number, default: null },
    baselineSdnnMs: { type: Number, default: null },
    rmssdChangePercent: { type: Number, default: null },
    baselineComparison: {
      type: String,
      enum: ['in_line', 'higher', 'lower', null],
      default: null,
    },

    patientSummary: { type: String, default: null },
    technicalSummary: { type: String, default: null },

    /** Downsampled cleaned NN sequence backing the HRV trend chart. */
    series: [
      {
        _id: false,
        offsetSec: { type: Number },
        rPeakTimestamp: { type: Number, default: null },
        timestamp: { type: String, default: null },
        nnMs: { type: Number },
      },
    ],

    analysedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

hrvAnalysisSchema.index({ userId: 1 });
hrvAnalysisSchema.index({ deviceId: 1 });
hrvAnalysisSchema.index({ clientId: 1 });
// Backs the personal-baseline lookup: this user's successful analyses, newest first.
hrvAnalysisSchema.index({ userId: 1, status: 1, analysedAt: -1 });

module.exports = mongoose.model('HrvAnalysis', hrvAnalysisSchema);
