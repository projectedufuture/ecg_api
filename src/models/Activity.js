const mongoose = require('mongoose');

/// GPS fitness activity (walking / running / cycling / other) recorded by the
/// mobile app. Mirrors the Session model's house style exactly: a string
/// business `id` (never the Mongo _id), plain-string `userId` ownership (no
/// ObjectId refs), ISO-string timestamps, nested subdocs for location, and a
/// `toFrontend()` serializer. Route points + HR samples are embedded arrays,
/// the same approach Session uses for its nested data.
const routePointSchema = new mongoose.Schema(
  {
    latitude: { type: Number, required: true },
    longitude: { type: Number, required: true },
    timestamp: { type: String, default: null },
    accuracy: { type: Number, default: null },
    altitude: { type: Number, default: null },
    speed: { type: Number, default: null },
  },
  { _id: false }
);

const heartRateSampleSchema = new mongoose.Schema(
  {
    bpm: { type: Number, required: true },
    t: { type: Number, required: true }, // elapsed active seconds
  },
  { _id: false }
);

// Generic scalar series sample (SpO₂ %, temperature °C, HRV ms).
const metricSampleSchema = new mongoose.Schema(
  {
    v: { type: Number, required: true },
    t: { type: Number, required: true }, // elapsed active seconds
  },
  { _id: false }
);

const activitySchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    userId: { type: String, required: true },
    userEmail: { type: String, required: true },
    userName: { type: String, required: true },
    clientId: { type: String, default: null }, // the app's local id (dedupe key)

    activityType: {
      type: String,
      enum: [
        'walking',
        'running',
        'cycling',
        'hiking',
        'training',
        'recovery_walk',
        'interval_run',
        'other',
      ],
      required: true,
    },

    startedAt: { type: String, required: true },
    endedAt: { type: String, default: null },

    totalDurationSeconds: { type: Number, default: 0 },
    activeDurationSeconds: { type: Number, default: 0 },
    pausedDurationSeconds: { type: Number, default: 0 },

    distanceMeters: { type: Number, default: 0 },
    averageSpeedMps: { type: Number, default: 0 },
    maxSpeedMps: { type: Number, default: 0 },
    averagePaceSecPerKm: { type: Number, default: null },

    averageHeartRate: { type: Number, default: null },
    maxHeartRate: { type: Number, default: null },

    // Derived time-domain HRV (computed on-device from RR intervals).
    rmssd: { type: Number, default: null },
    sdnn: { type: Number, default: null },

    calories: { type: Number, default: 0 },

    startLocation: {
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
      accuracy: { type: Number, default: null },
      address: { type: String, default: null },
    },

    routePoints: { type: [routePointSchema], default: [] },
    heartRateSamples: { type: [heartRateSampleSchema], default: [] },
    spo2Samples: { type: [metricSampleSchema], default: [] },
    temperatureSamples: { type: [metricSampleSchema], default: [] },
    hrvSamples: { type: [metricSampleSchema], default: [] },
  },
  { timestamps: true }
);

activitySchema.index({ userId: 1 });
activitySchema.index({ userId: 1, startedAt: -1 });
activitySchema.index({ clientId: 1 });

/// Lightweight projection for list endpoints (no heavy route/HR arrays).
activitySchema.methods.toSummary = function () {
  return {
    id: this.id,
    clientId: this.clientId || null,
    activityType: this.activityType,
    startedAt: this.startedAt,
    endedAt: this.endedAt || null,
    totalDurationSeconds: this.totalDurationSeconds || 0,
    activeDurationSeconds: this.activeDurationSeconds || 0,
    pausedDurationSeconds: this.pausedDurationSeconds || 0,
    distanceMeters: this.distanceMeters || 0,
    averageSpeedMps: this.averageSpeedMps || 0,
    maxSpeedMps: this.maxSpeedMps || 0,
    averagePaceSecPerKm: this.averagePaceSecPerKm ?? null,
    averageHeartRate: this.averageHeartRate ?? null,
    maxHeartRate: this.maxHeartRate ?? null,
    rmssd: this.rmssd ?? null,
    sdnn: this.sdnn ?? null,
    calories: this.calories || 0,
    startLocation: this.startLocation || null,
  };
};

/// Full serializer including route + HR samples (detail + create response).
activitySchema.methods.toFrontend = function () {
  return {
    ...this.toSummary(),
    routePoints: (this.routePoints || []).map((p) => ({
      latitude: p.latitude,
      longitude: p.longitude,
      timestamp: p.timestamp || null,
      accuracy: p.accuracy ?? null,
      altitude: p.altitude ?? null,
      speed: p.speed ?? null,
    })),
    heartRateSamples: (this.heartRateSamples || []).map((s) => ({
      bpm: s.bpm,
      t: s.t,
    })),
    spo2Samples: (this.spo2Samples || []).map((s) => ({ v: s.v, t: s.t })),
    temperatureSamples:
      (this.temperatureSamples || []).map((s) => ({ v: s.v, t: s.t })),
    hrvSamples: (this.hrvSamples || []).map((s) => ({ v: s.v, t: s.t })),
  };
};

module.exports = mongoose.model('Activity', activitySchema);
