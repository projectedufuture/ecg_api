const mongoose = require('mongoose');

/**
 * Event-level ECG/RR findings for a session (PART 15).
 *
 * Event types are deliberately non-diagnostic: every one names either a timing
 * observation or a possible detection artifact. Nothing here asserts a rhythm
 * diagnosis.
 */
const ecgRrEventSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true },
    userId: { type: String, required: true },
    deviceId: { type: String, required: true },
    clientId: { type: String, default: 'CLIENT-001' },

    // Wall-clock instant of the event, carried from the originating reading.
    timestamp: { type: String, default: null },
    // Device monotonic clock (ms) of the R peak that closed the interval.
    rPeakTimestamp: { type: Number, default: null },

    eventType: {
      type: String,
      enum: [
        'possible_long_rr',
        'rr_irregularity',
        'possible_missed_beat',
        'possible_double_detection',
        'signal_quality_drop',
      ],
      required: true,
    },

    // Length of the finding in ms (the RR itself, or the size of the jump for an
    // irregularity).
    durationMs: { type: Number, default: null },
    rrValue: { type: Number, default: null },

    quality: {
      type: String,
      enum: [
        'valid',
        'short_rr_candidate',
        'long_rr_candidate',
        'possible_missed_beat',
        'possible_double_detection',
        'invalid',
      ],
      default: 'valid',
    },

    description: { type: String, default: null },
  },
  { timestamps: true }
);

ecgRrEventSchema.index({ sessionId: 1, rPeakTimestamp: 1 });
ecgRrEventSchema.index({ userId: 1 });
ecgRrEventSchema.index({ clientId: 1 });
ecgRrEventSchema.index({ eventType: 1 });

module.exports = mongoose.model('EcgRrEvent', ecgRrEventSchema);
