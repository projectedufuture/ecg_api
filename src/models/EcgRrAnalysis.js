const mongoose = require('mongoose');

/**
 * Persisted session-level ECG/RR analysis result (PART 14).
 *
 * One document per session. The report endpoint reads this rather than
 * re-deriving RR statistics from every reading on each request (PART 30).
 *
 * Statistical fields are nullable on purpose: when a recording cannot support
 * analysis (`available: false`) they stay null so the UI shows the reason
 * instead of a card full of zeros.
 */
const ecgRrAnalysisSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, unique: true },
    userId: { type: String, required: true },
    deviceId: { type: String, required: true },
    clientId: { type: String, default: 'CLIENT-001' },

    // False when the recording was too short, too sparse or too noisy.
    available: { type: Boolean, default: false },
    unavailableReason: {
      type: String,
      enum: ['no_data', 'insufficient_data', 'poor_signal_quality', null],
      default: null,
    },
    unavailableMessage: { type: String, default: null },

    recordingDurationSec: { type: Number, default: null },

    // Beat accounting
    beatsDetected: { type: Number, default: 0 },
    validBeats: { type: Number, default: 0 },
    invalidBeats: { type: Number, default: 0 },
    usableBeatPercentage: { type: Number, default: null },

    // RR statistics (ms)
    meanRR: { type: Number, default: null },
    minRR: { type: Number, default: null },
    maxRR: { type: Number, default: null },
    rrStandardDeviation: { type: Number, default: null },
    rrCoefficientVariation: { type: Number, default: null },

    // HR statistics (BPM), derived as 60000 / RR
    meanHR: { type: Number, default: null },
    minHR: { type: Number, default: null },
    maxHR: { type: Number, default: null },

    // Beat-to-beat analysis
    meanAbsRrDifference: { type: Number, default: null },
    maxAbsRrDifference: { type: Number, default: null },
    beatToBeatVariation: {
      type: String,
      enum: ['Low', 'Moderate', 'High', 'Unavailable'],
      default: 'Unavailable',
    },

    // Descriptive rhythm timing - not a diagnosis.
    rhythmRegularity: {
      type: String,
      enum: ['Regular', 'Mostly Regular', 'Variable', 'Highly Variable', 'Unavailable'],
      default: 'Unavailable',
    },

    longRREventCount: { type: Number, default: 0 },

    signalQuality: {
      type: String,
      enum: ['Good', 'Fair', 'Limited', 'Poor', 'Unavailable'],
      default: 'Unavailable',
    },

    patientSummary: { type: String, default: null },
    technicalSummary: { type: String, default: null },

    /**
     * Downsampled per-interval series backing the RR and HR trend charts. Only
     * analysable intervals are stored, so the charts never plot an artifact as a
     * real measurement.
     */
    series: [
      {
        _id: false,
        offsetSec: { type: Number },
        timestamp: { type: String, default: null },
        rr: { type: Number },
        hr: { type: Number },
      },
    ],

    // Set on every (re)calculation so a stale report is identifiable.
    analysedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

ecgRrAnalysisSchema.index({ userId: 1 });
ecgRrAnalysisSchema.index({ deviceId: 1 });
ecgRrAnalysisSchema.index({ clientId: 1 });

module.exports = mongoose.model('EcgRrAnalysis', ecgRrAnalysisSchema);
