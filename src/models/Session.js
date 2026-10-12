const mongoose = require('mongoose');

// ── Embedded GPS route point ────────────────────────────────────────────────
// A Session may additionally carry a GPS workout (walking/running/cycling).
// Route points are stored inline, the same shape the (now-removed) Activity
// model used, so the client/view code is unchanged. `_id: false` keeps the
// array terse, matching the house style for nested data.
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

const sessionSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    name: { type: String, default: null },
    userId: { type: String, required: true },
    userEmail: { type: String, required: true },
    userName: { type: String, required: true },
    deviceId: { type: String, required: true },
    startTime: { type: String, required: true },
    endTime: { type: String, required: true },
    duration: { type: Number, required: true },
    dataPoints: { type: Number, required: true },
    dataSource: { type: String, enum: ['live', 'stored', 'mixed'], required: true },
    avgTemp: { type: String, required: true },
    avgHR: { type: Number, required: true },
    minHR: { type: Number, required: true },
    maxHR: { type: Number, required: true },
    avgSpo2: { type: Number, default: 0 },
    minSpo2: { type: Number, default: 0 },
    maxSpo2: { type: Number, default: 0 },
    clientId: { type: String, default: 'CLIENT-001' },
    location: {
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
      accuracy: { type: Number, default: null },
      address: { type: String, default: null },
    },

    // ── Activity / GPS workout data (additive) ───────────────────────
    //
    // A Session is now the single record for both a plain ECG recording and a
    // GPS workout. `activityType` defaults to 'ecg' so every existing and
    // future ECG-only session is self-describing; a real workout sets one of
    // the movement types. All other fields default to empty/zero so a session
    // with no workout carries no misleading data. `location` (above) doubles
    // as the start location; `endLocation` is the last fix.
    //
    // Note on units: `duration` stays WHOLE MINUTES (unchanged, derived from
    // timestamps). `activeDurationSeconds` is the precise moving time used by
    // the workout UI and analytics.
    activityType: {
      type: String,
      enum: [
        'ecg',
        'walking',
        'running',
        'cycling',
        'hiking',
        'training',
        'recovery_walk',
        'interval_run',
        'other',
      ],
      default: 'ecg',
    },
    endLocation: {
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
      accuracy: { type: Number, default: null },
      address: { type: String, default: null },
    },
    routePoints: { type: [routePointSchema], default: [] },
    distanceMeters: { type: Number, default: 0 },
    activeDurationSeconds: { type: Number, default: 0 },
    pausedDurationSeconds: { type: Number, default: 0 },
    averageSpeedMps: { type: Number, default: 0 },
    maxSpeedMps: { type: Number, default: 0 },
    averagePaceSecPerKm: { type: Number, default: null },
    calories: { type: Number, default: 0 },
    // Derived time-domain HRV (computed on-device from RR intervals).
    rmssd: { type: Number, default: null },
    sdnn: { type: Number, default: null },

    // ── Report generation state ──────────────────────────────────────
    //
    // Reports are derived when the recording finishes. Without a status the
    // UI cannot tell "not generated yet" from "generated, and there genuinely
    // was nothing to report" - both would render as an empty report. Nor
    // would a generation failure leave any trace at all.
    //
    //   not_started - the recording has not finished yet
    //   pending     - finished, generation queued
    //   generating  - generation in progress
    //   ready       - generation completed (individual reports may still be
    //                 unavailable on their own merits, e.g. no beats recorded)
    //   failed      - generation threw; reportError says what happened
    //   too_short   - the recording is below the minimum length for reports to
    //                 mean anything, so none were generated
    reportStatus: {
      type: String,
      enum: ['not_started', 'pending', 'generating', 'ready', 'failed', 'too_short'],
      default: 'not_started',
    },
    reportGeneratedAt: { type: Date, default: null },
    reportError: { type: String, default: null },
    // Counts generation runs, so a session stuck in a retry loop is visible.
    reportAttempts: { type: Number, default: 0 },
  },
  { timestamps: true }
);

sessionSchema.index({ userId: 1 });
sessionSchema.index({ deviceId: 1 });
sessionSchema.index({ startTime: 1 });
sessionSchema.index({ clientId: 1 });
sessionSchema.index({ userId: 1, startTime: -1 });

sessionSchema.methods.toFrontend = function () {
  return {
    id: this.id,
    name: this.name || null,
    userId: this.userId,
    userEmail: this.userEmail,
    userName: this.userName,
    deviceId: this.deviceId,
    startTime: this.startTime,
    endTime: this.endTime,
    duration: this.duration,
    dataPoints: this.dataPoints,
    dataSource: this.dataSource,
    avgTemp: this.avgTemp,
    avgHR: this.avgHR,
    minHR: this.minHR,
    maxHR: this.maxHR,
    avgSpo2: this.avgSpo2 || 0,
    minSpo2: this.minSpo2 || 0,
    maxSpo2: this.maxSpo2 || 0,
    location: this.location || null,
    // ── Activity / GPS workout data ──────────────────────────────────
    activityType: this.activityType || 'ecg',
    endLocation: this.endLocation || null,
    distanceMeters: this.distanceMeters || 0,
    activeDurationSeconds: this.activeDurationSeconds || 0,
    pausedDurationSeconds: this.pausedDurationSeconds || 0,
    averageSpeedMps: this.averageSpeedMps || 0,
    maxSpeedMps: this.maxSpeedMps || 0,
    averagePaceSecPerKm: this.averagePaceSecPerKm ?? null,
    calories: this.calories || 0,
    rmssd: this.rmssd ?? null,
    sdnn: this.sdnn ?? null,
    routePoints: (this.routePoints || []).map((p) => ({
      latitude: p.latitude,
      longitude: p.longitude,
      timestamp: p.timestamp || null,
      accuracy: p.accuracy ?? null,
      altitude: p.altitude ?? null,
      speed: p.speed ?? null,
    })),
    reportStatus: this.reportStatus || 'not_started',
    reportGeneratedAt: this.reportGeneratedAt || null,
    reportError: this.reportError || null,
  };
};

module.exports = mongoose.model('Session', sessionSchema);
