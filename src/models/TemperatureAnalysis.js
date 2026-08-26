const mongoose = require('mongoose');

/**
 * Persisted session-level temperature result.
 *
 * `regime` records whether the readings look like a skin-surface or a
 * body-temperature measurement. A garment thermistor normally reads several
 * degrees below core, so no fever threshold is applied anywhere: findings are
 * expressed relative to this recording's own baseline instead.
 */
const temperatureAnalysisSchema = new mongoose.Schema(
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

    meanC: { type: Number, default: null },
    medianC: { type: Number, default: null },
    minC: { type: Number, default: null },
    maxC: { type: Number, default: null },
    sdC: { type: Number, default: null },
    startC: { type: Number, default: null },
    endC: { type: Number, default: null },
    totalChangeC: { type: Number, default: null },
    driftCPerMin: { type: Number, default: null },

    elevationEvents: { type: Number, default: 0 },
    depressionEvents: { type: Number, default: 0 },

    regime: {
      type: String,
      enum: ['Surface / skin range', 'Body-temperature range', 'Mixed range', 'Unavailable'],
      default: 'Unavailable',
    },
    trend: {
      type: String,
      enum: ['Rising', 'Falling', 'Stable', 'Unavailable'],
      default: 'Unavailable',
    },
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

    series: [
      {
        _id: false,
        offsetSec: { type: Number },
        timestamp: { type: String, default: null },
        tempC: { type: Number },
        baseline: { type: Number, default: null },
      },
    ],

    analysedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

temperatureAnalysisSchema.index({ userId: 1 });
temperatureAnalysisSchema.index({ clientId: 1 });

module.exports = mongoose.model('TemperatureAnalysis', temperatureAnalysisSchema);
