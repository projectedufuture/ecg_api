const mongoose = require('mongoose');

const readingSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    sessionId: { type: String, required: true },
    userId: { type: String, required: true },
    timestamp: { type: String, required: true },
    ecgValue: { type: Number, required: true },
    temperatureCelsius: { type: Number, required: true },
    hr: { type: Number, default: 0 },
    spo2: { type: Number, default: 0 },
    deviceId: { type: String, required: true },
    clientId: { type: String, default: 'CLIENT-001' },

    // ── R-peak / beat detection (ECG/RR analysis) ──────────────────
    // The firmware raises these on the sample where its detector fired. They are
    // additive and optional: readings uploaded by older firmware simply leave
    // `beat` false and are ignored by the RR pipeline.

    // True when the device reported an R peak at this sample (device BEAT flag).
    beat: { type: Boolean, default: false },

    /**
     * R-peak instant on the device's own monotonic millisecond clock (device
     * R_TIME field). RR intervals are differences of this value, so they are
     * immune to the wall-clock jitter and rounding that `timestamp` carries.
     * Null when the firmware reports a beat without a precise peak time - the
     * RR pipeline then falls back to `timestamp`.
     */
    rPeakTimestamp: { type: Number, default: null },

    // Detector confidence 0..1, when the firmware provides one.
    beatConfidence: { type: Number, default: null },

    // Device LEAD status: true = electrode off/poor contact, so any beat
    // detected on this sample is not trustworthy.
    leadOff: { type: Boolean, default: false },

    /**
     * RR interval the device reported on this packet (device RR field).
     *
     * The firmware repeats its last known RR on every packet, so this is NOT a
     * new interval per sample — only a reading with `beat: true` marks a new
     * beat. Kept for cross-checking and for firmware that reports RR without an
     * R-peak clock. Null when the device sent the -1 sentinel.
     */
    rrIntervalMs: { type: Number, default: null },

    /**
     * Device ECG quality flag (device QUALITY field). 0 means the firmware
     * considers this ECG sample unusable. Null when not reported.
     */
    ecgQuality: { type: Number, default: null },

    // ── Raw PPG ────────────────────────────────────────────────────
    // Required for PPG-derived respiration: the final SpO2 percentage carries
    // no waveform and cannot substitute for these. Null when the firmware does
    // not stream raw photoplethysmography.
    ppgIr: { type: Number, default: null },
    ppgRed: { type: Number, default: null },
  },
  { timestamps: true }
);

readingSchema.index({ sessionId: 1, timestamp: 1 });
// Supports the RR pipeline's "all R peaks for this session, in order" query.
readingSchema.index({ sessionId: 1, beat: 1, rPeakTimestamp: 1 });
readingSchema.index({ userId: 1 });
readingSchema.index({ deviceId: 1 });
readingSchema.index({ clientId: 1 });

readingSchema.methods.toFrontend = function () {
  return {
    id: this.id,
    sessionId: this.sessionId,
    userId: this.userId,
    timestamp: this.timestamp,
    ecgValue: this.ecgValue,
    temperatureCelsius: this.temperatureCelsius,
    hr: this.hr || 0,
    spo2: this.spo2 || 0,
    deviceId: this.deviceId,
    beat: this.beat === true,
    rPeakTimestamp: this.rPeakTimestamp ?? null,
    beatConfidence: this.beatConfidence ?? null,
    leadOff: this.leadOff === true,
  };
};

module.exports = mongoose.model('Reading', readingSchema);
