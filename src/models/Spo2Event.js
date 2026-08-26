const mongoose = require('mongoose');

/**
 * Event-level SpO2 findings.
 *
 * Non-diagnostic by construction: a "possible desaturation" is a drop to review,
 * because motion artifact on a reflectance PPG produces the same trace as a true
 * desaturation. `recovered: false` means saturation never returned to baseline,
 * which more often indicates a sensor or contact change than a physiological drop.
 */
const spo2EventSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true },
    userId: { type: String, required: true },
    deviceId: { type: String, required: true },
    clientId: { type: String, default: 'CLIENT-001' },

    eventType: {
      type: String,
      enum: ['possible_desaturation', 'low_saturation_period', 'signal_gap'],
      required: true,
    },

    startSec: { type: Number, default: null },
    endSec: { type: Number, default: null },
    durationSec: { type: Number, default: null },
    timestamp: { type: String, default: null },

    baselinePct: { type: Number, default: null },
    nadirPct: { type: Number, default: null },
    dropPct: { type: Number, default: null },
    meanPct: { type: Number, default: null },
    thresholdPct: { type: Number, default: null },
    recovered: { type: Boolean, default: null },
    recoverySec: { type: Number, default: null },
    samples: { type: Number, default: null },

    description: { type: String, default: null },
  },
  { timestamps: true }
);

spo2EventSchema.index({ sessionId: 1, startSec: 1 });
spo2EventSchema.index({ clientId: 1 });

module.exports = mongoose.model('Spo2Event', spo2EventSchema);
