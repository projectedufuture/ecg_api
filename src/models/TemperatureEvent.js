const mongoose = require('mongoose');

/**
 * Temperature excursions relative to the recording's own rolling baseline.
 *
 * Deliberately not absolute thresholds: a contact thermistor's absolute reading
 * depends on sensor placement, garment fit and ambient conditions, none of which
 * is knowable from the stored data, while a change within one recording is.
 */
const temperatureEventSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true },
    userId: { type: String, required: true },
    deviceId: { type: String, required: true },
    clientId: { type: String, default: 'CLIENT-001' },

    eventType: {
      type: String,
      enum: ['relative_elevation', 'relative_depression'],
      required: true,
    },

    startSec: { type: Number, default: null },
    endSec: { type: Number, default: null },
    durationSec: { type: Number, default: null },
    timestamp: { type: String, default: null },

    baselineC: { type: Number, default: null },
    peakC: { type: Number, default: null },
    changeC: { type: Number, default: null },
    samples: { type: Number, default: null },

    description: { type: String, default: null },
  },
  { timestamps: true }
);

temperatureEventSchema.index({ sessionId: 1, startSec: 1 });
temperatureEventSchema.index({ clientId: 1 });

module.exports = mongoose.model('TemperatureEvent', temperatureEventSchema);
