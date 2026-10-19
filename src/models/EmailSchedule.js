const mongoose = require('mongoose');

// ── Scheduled summary email ─────────────────────────────────────────────────
// An admin configures a recipient address and a recurring time; when that time
// arrives the summaryScheduler builds a session-activity digest (logins +
// sessions recorded with their durations for the period) and emails it.
//
// Scoping mirrors the rest of the admin API: a client_admin's schedule carries
// their clientId and only ever summarises that client's data; a super_admin's
// schedule has clientId = null and summarises everything.
const emailScheduleSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },

    // Human label shown in the admin list (e.g. "Daily ops digest").
    name: { type: String, required: true, trim: true },

    // Where the digest is delivered. Any valid address the admin types.
    recipientEmail: { type: String, required: true, lowercase: true, trim: true },

    // How often it fires.
    frequency: { type: String, enum: ['daily', 'weekly'], required: true },

    // Local send time in 24h "HH:MM", interpreted in `timezone`.
    timeOfDay: { type: String, required: true },

    // 0 = Sunday … 6 = Saturday. Only meaningful for frequency === 'weekly'.
    weekday: { type: Number, min: 0, max: 6, default: 1 },

    // IANA timezone the timeOfDay/weekday are interpreted in (DST-aware).
    timezone: { type: String, default: 'Asia/Kolkata' },

    enabled: { type: Boolean, default: true },

    // Ownership / scope.
    clientId: { type: String, default: null },
    createdBy: { type: String, default: null },
    createdByName: { type: String, default: null },

    // ── Run tracking (maintained by the scheduler) ───────────────────────────
    // nextRunAt is the instant the digest is next due. The scheduler claims a
    // schedule by advancing nextRunAt BEFORE sending, so a second worker (or a
    // restart mid-send) cannot double-send the same slot.
    nextRunAt: { type: Date, default: null },
    lastRunAt: { type: Date, default: null },
    lastStatus: { type: String, enum: ['pending', 'success', 'failed', null], default: null },
    lastError: { type: String, default: null },
    lastSessionCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

emailScheduleSchema.index({ enabled: 1, nextRunAt: 1 });
emailScheduleSchema.index({ clientId: 1 });

emailScheduleSchema.methods.toFrontend = function () {
  return {
    id: this.id,
    name: this.name,
    recipientEmail: this.recipientEmail,
    frequency: this.frequency,
    timeOfDay: this.timeOfDay,
    weekday: this.weekday,
    timezone: this.timezone,
    enabled: this.enabled,
    createdByName: this.createdByName,
    nextRunAt: this.nextRunAt || null,
    lastRunAt: this.lastRunAt || null,
    lastStatus: this.lastStatus || null,
    lastError: this.lastError || null,
    lastSessionCount: this.lastSessionCount || 0,
    createdAt: this.createdAt || null,
  };
};

module.exports = mongoose.model('EmailSchedule', emailScheduleSchema);
