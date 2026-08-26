const mongoose = require('mongoose');

/**
 * Event-level rhythm screening findings for a session.
 *
 * Events are AGGREGATED periods, not per-beat rows: a sustained elevated-HR
 * stretch is one document, not one per heartbeat.
 *
 * `requiresContext` marks a finding that cannot be interpreted without activity
 * or rest information (an elevated heart rate during exercise is expected).
 * `requiresQualityReview` marks a probable detection artifact rather than a
 * physiological observation.
 */
const rhythmEventSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true },
    userId: { type: String, required: true },
    deviceId: { type: String, required: true },
    clientId: { type: String, default: 'CLIENT-001' },

    eventType: {
      type: String,
      enum: [
        'elevated_heart_rate',
        'low_heart_rate',
        'irregular_rr_period',
        'possible_long_rr',
        'possible_missed_beat',
        'possible_double_detection',
        'signal_quality_drop',
      ],
      required: true,
    },

    // Seconds from the first R peak; null for carried-over per-beat flags.
    startSec: { type: Number, default: null },
    endSec: { type: Number, default: null },
    durationSec: { type: Number, default: null },

    timestamp: { type: String, default: null },
    rPeakTimestamp: { type: Number, default: null },

    heartRateBpm: { type: Number, default: null },
    meanHeartRateBpm: { type: Number, default: null },
    cvPercent: { type: Number, default: null },
    rrValue: { type: Number, default: null },
    beats: { type: Number, default: null },

    requiresContext: { type: Boolean, default: false },
    requiresQualityReview: { type: Boolean, default: false },

    description: { type: String, default: null },
  },
  { timestamps: true }
);

rhythmEventSchema.index({ sessionId: 1, rPeakTimestamp: 1 });
rhythmEventSchema.index({ userId: 1 });
rhythmEventSchema.index({ clientId: 1 });
rhythmEventSchema.index({ eventType: 1 });

module.exports = mongoose.model('RhythmEvent', rhythmEventSchema);
